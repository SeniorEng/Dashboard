/**
 * Task #1353 — SSoT-Gate „Darf dieser Kunde einen privaten (Selbstzahler-)
 * Anteil bekommen?".
 *
 * Hintergrund: Ein reiner Pflegekassen-Kunde (z.B. Jungnickel: gesetzlich
 * versichert, `acceptsPrivatePayment = false`, KEIN Selbstzahler) hat
 * fälschlich neben der korrekten Kassen-Rechnung eine private 19%-Rechnung
 * erhalten. Die EINE Definition dieses Gates lebt in
 * `isPrivatePaymentAllowed` und wird von Buchungs-/Rebook-/Reservierungs-/
 * Import-/Rechnungssplit-Pfad importiert (keine parallelen Definitionen).
 *
 * Dieser Test fixiert die Wahrheitstabelle des Gates.
 */
import { describe, it, expect } from "vitest";
import {
  isPrivatePaymentAllowed,
  isSelbstzahlerBillingType,
} from "@shared/domain/budget-selbstzahler-validator";

describe("isPrivatePaymentAllowed (Task #1353)", () => {
  it("Selbstzahler darf immer privat zahlen — unabhängig vom Flag", () => {
    expect(
      isPrivatePaymentAllowed({ billingType: "selbstzahler", acceptsPrivatePayment: false }),
    ).toBe(true);
    expect(
      isPrivatePaymentAllowed({ billingType: "selbstzahler", acceptsPrivatePayment: true }),
    ).toBe(true);
    expect(
      isPrivatePaymentAllowed({ billingType: "selbstzahler", acceptsPrivatePayment: null }),
    ).toBe(true);
  });

  it("Pflegekassen-Kunde MIT acceptsPrivatePayment darf privat zahlen", () => {
    expect(
      isPrivatePaymentAllowed({ billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: true }),
    ).toBe(true);
    expect(
      isPrivatePaymentAllowed({ billingType: "pflegekasse_privat", acceptsPrivatePayment: true }),
    ).toBe(true);
  });

  it("Reiner Pflegekassen-Kunde OHNE acceptsPrivatePayment darf NICHT privat zahlen (Jungnickel)", () => {
    expect(
      isPrivatePaymentAllowed({ billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: false }),
    ).toBe(false);
    expect(
      isPrivatePaymentAllowed({ billingType: "pflegekasse_privat", acceptsPrivatePayment: false }),
    ).toBe(false);
    // Fehlendes/Null-Flag wird wie `false` behandelt.
    expect(
      isPrivatePaymentAllowed({ billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: null }),
    ).toBe(false);
    expect(
      isPrivatePaymentAllowed({ billingType: "pflegekasse_gesetzlich", acceptsPrivatePayment: undefined }),
    ).toBe(false);
  });

  it("isSelbstzahlerBillingType erkennt ausschließlich 'selbstzahler'", () => {
    expect(isSelbstzahlerBillingType("selbstzahler")).toBe(true);
    expect(isSelbstzahlerBillingType("pflegekasse_gesetzlich")).toBe(false);
    expect(isSelbstzahlerBillingType("pflegekasse_privat")).toBe(false);
    expect(isSelbstzahlerBillingType(null)).toBe(false);
    expect(isSelbstzahlerBillingType(undefined)).toBe(false);
  });
});
