import { describe, it, expect } from "vitest";
import {
  resolveAppointmentPartyName,
  UNRESOLVED_CUSTOMER_LABEL,
  PROSPECT_NAME_PREFIX,
} from "@shared/domain/appointment-party-name";

/**
 * Task #1571 — SSoT für die Partei-Namens-Auflösung eines Termins. Dieselbe
 * Funktion wird in Mitarbeiterabrechnung, Lexware-/Payroll-Export und weiteren
 * Termin-Listen genutzt, damit kundenlose Interessententermine überall
 * einheitlich "Interessent: <Name>" statt eines leeren Platzhalters zeigen.
 */
describe("resolveAppointmentPartyName", () => {
  it("bevorzugt den Kundennamen, wenn vorhanden", () => {
    expect(resolveAppointmentPartyName("Max Mustermann", "Erika Musterfrau")).toBe(
      "Max Mustermann",
    );
  });

  it("fällt auf den Interessenten-Namen mit Präfix zurück, wenn kein Kunde", () => {
    expect(resolveAppointmentPartyName(null, "Erika Musterfrau")).toBe(
      `${PROSPECT_NAME_PREFIX}Erika Musterfrau`,
    );
    expect(resolveAppointmentPartyName(undefined, "Erika Musterfrau")).toBe(
      "Interessent: Erika Musterfrau",
    );
  });

  it("gibt den Platzhalter zurück, wenn weder Kunde noch Interessent auflösbar", () => {
    expect(resolveAppointmentPartyName(null, null)).toBe(UNRESOLVED_CUSTOMER_LABEL);
    expect(resolveAppointmentPartyName(undefined, undefined)).toBe(
      "Kein Kunde zugeordnet",
    );
    expect(resolveAppointmentPartyName("", "")).toBe(UNRESOLVED_CUSTOMER_LABEL);
  });
});
