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
  classifyBillingEligibility,
  isPflegekasseBillingType,
  isServiceRecordSignedForBilling,
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
