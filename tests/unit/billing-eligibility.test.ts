/**
 * Task #1456 — PURE unit tests für die Abrechnungs-Eligibilitäts-SSoT.
 *
 * Garantie: Die Klassifikation (`classifyBillingEligibility`) spiegelt die
 * Prüf-Reihenfolge und die wortgleichen Begründungen des echten Generate-Pfads
 * (`buildInvoiceDraft`) — „eligible" im Review ⇔ Generate akzeptiert, „blocked"
 * im Review ⇔ Generate lehnt mit identischem Text ab.
 */
import { describe, it, expect } from "vitest";
import {
  BILLING_BLOCK_MESSAGES,
  BILLING_BLOCK_SHORT_LABELS,
  classifyBillingEligibility,
  classifyBillingMaturity,
  isPflegekasseBillingType,
  isServiceRecordSignedForBilling,
  isLateSignedFollowUp,
  lateSignedFollowUpCount,
  isMonthFullyBilledAndSigned,
  isAwaitingCustomerSignature,
} from "@shared/domain/billing-eligibility";

describe("isPflegekasseBillingType", () => {
  it("erkennt beide Pflegekassen-Varianten", () => {
    expect(isPflegekasseBillingType("pflegekasse_gesetzlich")).toBe(true);
    expect(isPflegekasseBillingType("pflegekasse_privat")).toBe(true);
  });
  it("ist false für Selbstzahler/null/undefined", () => {
    expect(isPflegekasseBillingType("selbstzahler")).toBe(false);
    expect(isPflegekasseBillingType(null)).toBe(false);
    expect(isPflegekasseBillingType(undefined)).toBe(false);
  });
});

describe("isServiceRecordSignedForBilling", () => {
  it("Pflegekasse: NUR completed (Kundenunterschrift) zählt", () => {
    expect(isServiceRecordSignedForBilling("pflegekasse_gesetzlich", "completed")).toBe(true);
    expect(isServiceRecordSignedForBilling("pflegekasse_gesetzlich", "employee_signed")).toBe(false);
    expect(isServiceRecordSignedForBilling("pflegekasse_privat", "employee_signed")).toBe(false);
  });
  it("Selbstzahler: completed ODER employee_signed", () => {
    expect(isServiceRecordSignedForBilling("selbstzahler", "completed")).toBe(true);
    expect(isServiceRecordSignedForBilling("selbstzahler", "employee_signed")).toBe(true);
  });
  it("offene/unsignierte Status zählen nie", () => {
    expect(isServiceRecordSignedForBilling("selbstzahler", "open")).toBe(false);
    expect(isServiceRecordSignedForBilling("pflegekasse_gesetzlich", "open")).toBe(false);
  });
});

describe("classifyBillingEligibility — Prüf-Reihenfolge spiegelt buildInvoiceDraft", () => {
  it("Pflegekasse ohne Kundenunterschrift ⇒ customer_signature_required", () => {
    const r = classifyBillingEligibility({
      billingType: "pflegekasse_gesetzlich",
      serviceRecordStatuses: ["employee_signed"],
      signedAppointmentCount: 0,
      unbilledAppointmentCount: 0,
    });
    expect(r.status).toBe("blocked");
    expect(r.reason).toBe("customer_signature_required");
    expect(r.message).toBe(BILLING_BLOCK_MESSAGES.customer_signature_required);
  });

  it("Selbstzahler ohne jede Unterschrift ⇒ not_signed", () => {
    const r = classifyBillingEligibility({
      billingType: "selbstzahler",
      serviceRecordStatuses: ["open"],
      signedAppointmentCount: 0,
      unbilledAppointmentCount: 0,
    });
    expect(r.status).toBe("blocked");
    expect(r.reason).toBe("not_signed");
    expect(r.message).toBe(BILLING_BLOCK_MESSAGES.not_signed);
  });

  it("signiert, aber 0 Termine ⇒ no_appointments", () => {
    const r = classifyBillingEligibility({
      billingType: "selbstzahler",
      serviceRecordStatuses: ["completed"],
      signedAppointmentCount: 0,
      unbilledAppointmentCount: 0,
    });
    expect(r.status).toBe("blocked");
    expect(r.reason).toBe("no_appointments");
    expect(r.message).toBe(BILLING_BLOCK_MESSAGES.no_appointments);
  });

  it("alle Termine bereits abgerechnet ⇒ already_billed", () => {
    const r = classifyBillingEligibility({
      billingType: "selbstzahler",
      serviceRecordStatuses: ["completed"],
      signedAppointmentCount: 3,
      unbilledAppointmentCount: 0,
    });
    expect(r.status).toBe("blocked");
    expect(r.reason).toBe("already_billed");
    expect(r.message).toBe(BILLING_BLOCK_MESSAGES.already_billed);
  });

  it("signiert + offene Termine ⇒ eligible (kein Grund/Meldung)", () => {
    const r = classifyBillingEligibility({
      billingType: "pflegekasse_privat",
      serviceRecordStatuses: ["completed", "open"],
      signedAppointmentCount: 5,
      unbilledAppointmentCount: 2,
    });
    expect(r.status).toBe("eligible");
    expect(r.reason).toBeNull();
    expect(r.message).toBeNull();
  });

  it("Pflegekasse mit gemischten Status zählt nur completed als signiert", () => {
    // employee_signed allein darf Pflegekasse NICHT freischalten.
    const r = classifyBillingEligibility({
      billingType: "pflegekasse_gesetzlich",
      serviceRecordStatuses: ["employee_signed", "employee_signed"],
      signedAppointmentCount: 4,
      unbilledAppointmentCount: 4,
    });
    expect(r.status).toBe("blocked");
    expect(r.reason).toBe("customer_signature_required");
  });
});

describe("classifyBillingMaturity — genau eine Reifegruppe pro Kunde", () => {
  const eligible = { status: "eligible" as const, reason: null };

  it("offene Termine ⇒ has_open_appointments (schlägt alles andere)", () => {
    expect(
      classifyBillingMaturity({
        openAppointments: 2,
        completedAppointments: 3,
        coveredAppointments: 1,
        eligibility: { status: "blocked", reason: "customer_signature_required" },
      }),
    ).toBe("has_open_appointments");
  });

  it("keine offenen Termine + Kundenunterschrift fehlt ⇒ signature_blocked", () => {
    expect(
      classifyBillingMaturity({
        openAppointments: 0,
        completedAppointments: 2,
        coveredAppointments: 2,
        eligibility: { status: "blocked", reason: "customer_signature_required" },
      }),
    ).toBe("signature_blocked");
  });

  it("blockiert (not_signed/no_appointments/already_billed) ⇒ nie ready", () => {
    for (const reason of ["not_signed", "no_appointments", "already_billed"] as const) {
      expect(
        classifyBillingMaturity({
          openAppointments: 0,
          completedAppointments: 2,
          coveredAppointments: 2,
          eligibility: { status: "blocked", reason },
        }),
      ).not.toBe("ready");
    }
  });

  it("abrechenbar, aber nur teilweise abgedeckt ⇒ partially_documented", () => {
    expect(
      classifyBillingMaturity({
        openAppointments: 0,
        completedAppointments: 3,
        coveredAppointments: 2,
        eligibility: eligible,
      }),
    ).toBe("partially_documented");
  });

  it("teildokumentiert UND signaturblockiert ⇒ partially_documented (Sektion == Inline-Label, Task #1881)", () => {
    // Silke/Pia-Fall: weniger Termine abgedeckt als dokumentiert (teildokumentiert)
    // UND zusätzlich signaturblockiert. Der Kunde zeigt inline „nur X/Y
    // dokumentiert" und muss daher unter „Unvollständig dokumentiert" stehen —
    // NICHT unter „Wartet auf Kundenunterschrift" (sonst zwei widersprüchliche
    // Begründungen). `partially_documented` schlägt `signature_blocked`.
    expect(
      classifyBillingMaturity({
        openAppointments: 0,
        completedAppointments: 2,
        coveredAppointments: 1,
        eligibility: { status: "blocked", reason: "customer_signature_required" },
      }),
    ).toBe("partially_documented");
  });

  it("abrechenbar + vollständig abgedeckt + keine offenen Termine ⇒ ready", () => {
    expect(
      classifyBillingMaturity({
        openAppointments: 0,
        completedAppointments: 3,
        coveredAppointments: 3,
        eligibility: eligible,
      }),
    ).toBe("ready");
  });
});

describe("BILLING_BLOCK_SHORT_LABELS", () => {
  it("liefert prägnante Kurz-Labels je Blockgrund", () => {
    expect(BILLING_BLOCK_SHORT_LABELS.customer_signature_required).toBe("Kundenunterschrift fehlt");
    expect(BILLING_BLOCK_SHORT_LABELS.not_signed).toBeTruthy();
    expect(BILLING_BLOCK_SHORT_LABELS.no_appointments).toBeTruthy();
    expect(BILLING_BLOCK_SHORT_LABELS.already_billed).toBeTruthy();
  });
});

describe("isMonthFullyBilledAndSigned (Task #1878)", () => {
  it("alle dokumentierten Termine abrechenbar-signiert UND abgerechnet ⇒ true (Kunde fällt raus)", () => {
    expect(
      isMonthFullyBilledAndSigned({
        completedAppointments: 4,
        signedAppointmentCount: 4,
        unbilledAppointmentCount: 0,
      }),
    ).toBe(true);
  });

  it("Funke: 4 dokumentiert, nur 1 abrechenbar-signiert+abgerechnet ⇒ false (bleibt sichtbar)", () => {
    // 1 Termin unter kundensigniertem LN (abgerechnet), 3 unter employee_signed LN
    // (bei Pflegekasse NICHT abrechenbar-signiert ⇒ nicht in signedAppointmentCount).
    expect(
      isMonthFullyBilledAndSigned({
        completedAppointments: 4,
        signedAppointmentCount: 1,
        unbilledAppointmentCount: 0,
      }),
    ).toBe(false);
  });

  it("noch nicht abgerechnete signierte Termine (unbilled>0) ⇒ false (bleibt sichtbar)", () => {
    expect(
      isMonthFullyBilledAndSigned({
        completedAppointments: 3,
        signedAppointmentCount: 3,
        unbilledAppointmentCount: 1,
      }),
    ).toBe(false);
  });

  it("pure signaturblockierte Pflegekasse (0 signiert) ⇒ false (bleibt sichtbar)", () => {
    expect(
      isMonthFullyBilledAndSigned({
        completedAppointments: 3,
        signedAppointmentCount: 0,
        unbilledAppointmentCount: 0,
      }),
    ).toBe(false);
  });

  it("keine dokumentierten Termine ⇒ false (kein Grund zu entfernen)", () => {
    expect(
      isMonthFullyBilledAndSigned({
        completedAppointments: 0,
        signedAppointmentCount: 0,
        unbilledAppointmentCount: 0,
      }),
    ).toBe(false);
  });
});

describe("isAwaitingCustomerSignature (Task #1878)", () => {
  it("Pflegekasse mit mehr abgedeckten als abrechenbar-signierten Terminen ⇒ true", () => {
    // Funke: 4 abgedeckt (1 completed-LN + 3 employee_signed-LN), 1 abrechenbar-signiert.
    expect(
      isAwaitingCustomerSignature({
        billingType: "pflegekasse_gesetzlich",
        coveredAppointments: 4,
        signedAppointmentCount: 1,
      }),
    ).toBe(true);
  });

  it("Pflegekasse vollständig abrechenbar-signiert (covered === signed) ⇒ false", () => {
    expect(
      isAwaitingCustomerSignature({
        billingType: "pflegekasse_gesetzlich",
        coveredAppointments: 4,
        signedAppointmentCount: 4,
      }),
    ).toBe(false);
  });

  it("Selbstzahler mit employee_signed LN ⇒ false (keine Kundenunterschrift nötig)", () => {
    expect(
      isAwaitingCustomerSignature({
        billingType: "selbstzahler",
        coveredAppointments: 3,
        signedAppointmentCount: 0,
      }),
    ).toBe(false);
  });
});

describe("isLateSignedFollowUp / lateSignedFollowUpCount (Task #1813)", () => {
  it("Nachberechnung: unbilled>0 und signed>unbilled ⇒ true, Anzahl = jetzt abzurechnende (unbilled)", () => {
    const facts = { signedAppointmentCount: 5, unbilledAppointmentCount: 2 };
    expect(isLateSignedFollowUp(facts)).toBe(true);
    expect(lateSignedFollowUpCount(facts)).toBe(2);
  });

  it("keine unabgerechneten Termine ⇒ keine Nachberechnung", () => {
    const facts = { signedAppointmentCount: 4, unbilledAppointmentCount: 0 };
    expect(isLateSignedFollowUp(facts)).toBe(false);
    expect(lateSignedFollowUpCount(facts)).toBe(0);
  });

  it("noch nie abgerechnet (signed === unbilled) ⇒ keine Nachberechnung", () => {
    const facts = { signedAppointmentCount: 3, unbilledAppointmentCount: 3 };
    expect(isLateSignedFollowUp(facts)).toBe(false);
    expect(lateSignedFollowUpCount(facts)).toBe(0);
  });
});
