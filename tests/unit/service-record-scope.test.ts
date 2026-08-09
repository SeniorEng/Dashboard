/**
 * Task #1896 — Das reine Prädikat „gehört dieser Termin dem Mitarbeiter?".
 *
 * DB-frei. Der SQL-Spiegel wird separat gegen echte Zeilen geprüft
 * (`tests/equality/service-record-scope-parity.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { appointmentBelongsToEmployeeScope } from "@shared/domain/service-record-scope";

const ME = 7;
const OTHER = 9;

describe("appointmentBelongsToEmployeeScope (Task #1896)", () => {
  it("gehört dem Mitarbeiter, wenn er ihm ZUGEWIESEN ist", () => {
    expect(
      appointmentBelongsToEmployeeScope({ assignedEmployeeId: ME, performedByEmployeeId: null }, ME),
    ).toBe(true);
  });

  it("gehört dem Mitarbeiter, wenn er ihn GELEISTET hat", () => {
    expect(
      appointmentBelongsToEmployeeScope({ assignedEmployeeId: null, performedByEmployeeId: ME }, ME),
    ).toBe(true);
  });

  it("gehört BEIDEN, wenn die Spalten auseinanderfallen (Vertretung dokumentiert fremde Zuweisung)", () => {
    const appt = { assignedEmployeeId: OTHER, performedByEmployeeId: ME };
    expect(appointmentBelongsToEmployeeScope(appt, ME)).toBe(true);
    expect(appointmentBelongsToEmployeeScope(appt, OTHER)).toBe(true);
  });

  it("gehört einem Unbeteiligten NICHT", () => {
    expect(
      appointmentBelongsToEmployeeScope({ assignedEmployeeId: OTHER, performedByEmployeeId: OTHER }, ME),
    ).toBe(false);
  });

  it("gehört bei fehlendem Mitarbeiterbezug NIEMANDEM (konservativ, nicht jedem)", () => {
    const orphan = { assignedEmployeeId: null, performedByEmployeeId: null };
    expect(appointmentBelongsToEmployeeScope(orphan, ME)).toBe(false);
    expect(appointmentBelongsToEmployeeScope(orphan, OTHER)).toBe(false);
  });

  it("trennt NULL sauber von der Mitarbeiter-Id 0 (kein Falsy-Vergleich)", () => {
    // Ein `!appt.assignedEmployeeId` statt `=== null` würde hier kippen.
    expect(
      appointmentBelongsToEmployeeScope({ assignedEmployeeId: 0, performedByEmployeeId: null }, 0),
    ).toBe(true);
  });
});
