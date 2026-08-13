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

describe("classifyBillingMaturity — genau eine von DREI Reifegruppen pro Kunde (Task #1905)", () => {
  const eligible = { status: "eligible" as const, reason: null };
  /** Selbstzahler-Basis: kein Kundenunterschrifts-Gate, isoliert die Doku-Frage. */
  const base = { billingType: "selbstzahler", signedAppointmentCount: 0 };

  it("offene Termine ⇒ documentation_pending (schlägt den Nachweis-Cluster)", () => {
    expect(
      classifyBillingMaturity({
        ...base,
        openAppointments: 2,
        completedAppointments: 3,
        coveredAppointments: 1,
        eligibility: { status: "blocked", reason: "customer_signature_required" },
      }),
    ).toBe("documentation_pending");
  });

  it("teildokumentiert (0 < covered < completed) ⇒ documentation_pending", () => {
    expect(
      classifyBillingMaturity({
        ...base,
        openAppointments: 0,
        completedAppointments: 3,
        coveredAppointments: 2,
        eligibility: eligible,
      }),
    ).toBe("documentation_pending");
  });

  it("gar kein Leistungsnachweis (covered === 0) ⇒ documentation_pending", () => {
    // Task #1905 (Alrik-Entscheid): durchgeführt, aber gar nicht dokumentiert, ist
    // ein Dokumentations-Rückstand — NICHT der Nachweis-Cluster. Das ist die
    // bewusste Abkehr von der früheren Gruppe `service_record_missing`.
    expect(
      classifyBillingMaturity({
        ...base,
        openAppointments: 0,
        completedAppointments: 4,
        coveredAppointments: 0,
        eligibility: { status: "blocked", reason: "not_signed" },
      }),
    ).toBe("documentation_pending");
  });

  it("vollständig dokumentiert + Kundenunterschrift fehlt ⇒ proof_pending", () => {
    expect(
      classifyBillingMaturity({
        ...base,
        openAppointments: 0,
        completedAppointments: 2,
        coveredAppointments: 2,
        eligibility: { status: "blocked", reason: "customer_signature_required" },
      }),
    ).toBe("proof_pending");
  });

  it("blockiert (not_signed/no_appointments/already_billed) ⇒ nie ready", () => {
    for (const reason of ["not_signed", "no_appointments", "already_billed"] as const) {
      expect(
        classifyBillingMaturity({
          ...base,
          openAppointments: 0,
          completedAppointments: 2,
          coveredAppointments: 2,
          eligibility: { status: "blocked", reason },
        }),
      ).toBe("proof_pending");
    }
  });

  it("vollständig dokumentiert + vollständig signiert + nichts offen ⇒ ready", () => {
    expect(
      classifyBillingMaturity({
        ...base,
        openAppointments: 0,
        completedAppointments: 3,
        coveredAppointments: 3,
        signedAppointmentCount: 3,
        eligibility: eligible,
      }),
    ).toBe("ready");
  });

  // ── Der Kern-Fix von #1905 ────────────────────────────────────────────────
  // Regressionsanker gegen das dokumentierte Geld-Leck: ein Pflegekassen-Kunde
  // mit einem kundensignierten UND einem nur mitarbeiter-signierten LN ist
  // insgesamt `eligible` (der signierte Teil ist abrechenbar) und stand deshalb
  // unter „Bereit zum Abrechnen" — während dieselbe Zeile inline
  // „Kundenunterschrift fehlt" meldete. Beim Erstellen fiel der nicht
  // kundensignierte Termin aus der Rechnung (Unterberechnung).
  //
  // Die drei Formen stammen 1:1 aus echten Juli-2026-Daten (read-only an der
  // pseudonymisierten Referenz-DB erhoben): completed/covered/signiert.
  describe("Kundenunterschrift fehlt schlägt ready (Geld-Leck, Juli-2026-Formen)", () => {
    const formen = [
      { name: "5/5/4", completed: 5, covered: 5, signed: 4 },
      { name: "3/3/2", completed: 3, covered: 3, signed: 2 },
      { name: "2/2/1", completed: 2, covered: 2, signed: 1 },
    ];
    for (const f of formen) {
      it(`Pflegekasse ${f.name}: eligible, aber wartet auf Kundenunterschrift ⇒ proof_pending`, () => {
        expect(
          classifyBillingMaturity({
            billingType: "pflegekasse_gesetzlich",
            openAppointments: 0,
            completedAppointments: f.completed,
            coveredAppointments: f.covered,
            signedAppointmentCount: f.signed,
            // Genau der Punkt: die Eligibilitäts-SSoT sagt „abrechenbar" (der
            // signierte Teil ist es ja) — die Reifegruppe darf trotzdem nicht
            // `ready` sein.
            eligibility: eligible,
          }),
        ).toBe("proof_pending");
      });
    }

    it("Selbstzahler mit derselben Form bleibt ready (kein Kundenunterschrifts-Gate)", () => {
      // Gegenprobe: `employee_signed` genügt beim Selbstzahler, dort ist
      // covered > signed kein Nachweis-Mangel.
      expect(
        classifyBillingMaturity({
          billingType: "selbstzahler",
          openAppointments: 0,
          completedAppointments: 5,
          coveredAppointments: 5,
          signedAppointmentCount: 4,
          eligibility: eligible,
        }),
      ).toBe("ready");
    });
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
