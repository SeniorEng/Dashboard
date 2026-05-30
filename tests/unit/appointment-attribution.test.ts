/**
 * Task #838 — Unit-Tests für die zentrale Termin-zu-Mitarbeiter-Zuordnung.
 *
 * Sichert die reine Regel (`attributeAppointmentToEmployees`) ab, die sowohl
 * die Admin-Zeitübersicht als auch — über den Equality-Test gegen den SQL-Pfad
 * — die Mitarbeiter-Eigensicht verwendet.
 */
import { describe, it, expect } from "vitest";
import {
  attributeAppointmentToEmployees,
  appointmentBelongsToEmployee,
  type CustomerCoverage,
} from "@shared/domain/appointment-attribution";

const coverage: CustomerCoverage = {
  primaryEmployeeId: 1,
  backupEmployeeId: 2,
  backupEmployeeId2: 3,
};

describe("attributeAppointmentToEmployees", () => {
  it("abgeschlossen → durchführender Mitarbeiter (performedByEmployeeId)", () => {
    expect(
      attributeAppointmentToEmployees(
        { status: "completed", assignedEmployeeId: 9, performedByEmployeeId: 5 },
        coverage,
      ),
    ).toEqual([5]);
  });

  it("abgeschlossen ohne performedBy → niemandem zugerechnet", () => {
    expect(
      attributeAppointmentToEmployees(
        { status: "completed", assignedEmployeeId: 9, performedByEmployeeId: null },
        coverage,
      ),
    ).toEqual([]);
  });

  it("offen + zugewiesen → zugewiesener Mitarbeiter (assignedEmployeeId)", () => {
    expect(
      attributeAppointmentToEmployees(
        { status: "scheduled", assignedEmployeeId: 7, performedByEmployeeId: null },
        coverage,
      ),
    ).toEqual([7]);
  });

  it("offen + nicht zugewiesen → komplette Vertretungs-Kette des Kunden", () => {
    expect(
      attributeAppointmentToEmployees(
        { status: "scheduled", assignedEmployeeId: null, performedByEmployeeId: null },
        coverage,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("offen + nicht zugewiesen, dedupliziert die Vertretungs-Kette", () => {
    expect(
      attributeAppointmentToEmployees(
        { status: "documenting", assignedEmployeeId: null, performedByEmployeeId: null },
        { primaryEmployeeId: 4, backupEmployeeId: 4, backupEmployeeId2: null },
      ),
    ).toEqual([4]);
  });

  it("offen + nicht zugewiesen, ohne Kunde/Coverage → niemandem zugerechnet", () => {
    expect(
      attributeAppointmentToEmployees(
        { status: "scheduled", assignedEmployeeId: null, performedByEmployeeId: null },
        null,
      ),
    ).toEqual([]);
  });

  it("no-show (offen) folgt der Zuweisungs-/Coverage-Regel, nicht performedBy", () => {
    expect(
      attributeAppointmentToEmployees(
        { status: "customer_no_show", assignedEmployeeId: 8, performedByEmployeeId: 99 },
        coverage,
      ),
    ).toEqual([8]);
  });

  it("appointmentBelongsToEmployee spiegelt die Zuordnungs-Menge", () => {
    const appt = {
      status: "scheduled",
      assignedEmployeeId: null,
      performedByEmployeeId: null,
    };
    expect(appointmentBelongsToEmployee(appt, coverage, 2)).toBe(true);
    expect(appointmentBelongsToEmployee(appt, coverage, 99)).toBe(false);
  });
});
