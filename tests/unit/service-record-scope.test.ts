/**
 * Task #1896 — Das reine Prädikat „gehört dieser Termin dem Mitarbeiter?".
 *
 * Die Regel ist STATUS-ABHÄNGIG: dokumentiert → nur `performedByEmployeeId`,
 * sonst → nur `assignedEmployeeId`. Der interessante Fall ist die Divergenz
 * (`assigned = A`, `performed = B`) — dort entscheidet sich, ob der Nachweis
 * beim Erbringer landet oder beim bloß Zugewiesenen.
 *
 * DB-frei. Der SQL-Spiegel wird separat gegen echte Zeilen geprüft
 * (`tests/equality/service-record-scope-parity.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { appointmentBelongsToEmployeeScope } from "@shared/domain/service-record-scope";

const A = 7;
const B = 9;

describe("appointmentBelongsToEmployeeScope (Task #1896)", () => {
  describe("dokumentiert (status = 'completed') → NUR der Erbringer", () => {
    it("gehört dem, der geleistet hat", () => {
      expect(
        appointmentBelongsToEmployeeScope(
          { status: "completed", assignedEmployeeId: A, performedByEmployeeId: A },
          A,
        ),
      ).toBe(true);
    });

    it("DIVERGENZ: gehört B (Erbringer), NICHT A (nur zugewiesen)", () => {
      // Der Kern der Weiche vom 09.08.2026. Vor der Verengung war das flache
      // `assigned ODER performed` — dann besaß A den Nachweis und durfte ihn
      // unterschreiben, obwohl B geleistet hat.
      const appt = { status: "completed", assignedEmployeeId: A, performedByEmployeeId: B };
      expect(appointmentBelongsToEmployeeScope(appt, B)).toBe(true);
      expect(appointmentBelongsToEmployeeScope(appt, A)).toBe(false);
    });

    it("gehört niemandem, wenn kein Erbringer eingetragen ist — auch nicht dem Zugewiesenen", () => {
      const appt = { status: "completed", assignedEmployeeId: A, performedByEmployeeId: null };
      expect(appointmentBelongsToEmployeeScope(appt, A)).toBe(false);
      expect(appointmentBelongsToEmployeeScope(appt, B)).toBe(false);
    });
  });

  describe("noch offen → NUR der Zugewiesene", () => {
    it("gehört dem, dem er zugewiesen ist", () => {
      expect(
        appointmentBelongsToEmployeeScope(
          { status: "scheduled", assignedEmployeeId: A, performedByEmployeeId: null },
          A,
        ),
      ).toBe(true);
    });

    it("ein bereits gesetztes performedBy zählt hier NICHT", () => {
      const appt = { status: "scheduled", assignedEmployeeId: A, performedByEmployeeId: B };
      expect(appointmentBelongsToEmployeeScope(appt, A)).toBe(true);
      expect(appointmentBelongsToEmployeeScope(appt, B)).toBe(false);
    });

    it("gilt auch für no-show und documenting (alles ausser completed)", () => {
      for (const status of ["documenting", "customer_no_show", "cancelled"]) {
        expect(
          appointmentBelongsToEmployeeScope(
            { status, assignedEmployeeId: A, performedByEmployeeId: B },
            A,
          ),
          `Status ${status}`,
        ).toBe(true);
      }
    });

    it("gehört niemandem ohne Zuweisung — KEIN Rückfall auf die Kunden-Vertretungskette", () => {
      // Genau der Unterschied zur Zuordnungs-SSoT: dort fiele ein offener,
      // nicht zugewiesener Termin auf Primär-/Backup-Kraft zurück. Für den
      // Leistungsnachweis wäre das die entfernte Stammkraft-Ausnahme.
      const appt = { status: "scheduled", assignedEmployeeId: null, performedByEmployeeId: null };
      expect(appointmentBelongsToEmployeeScope(appt, A)).toBe(false);
      expect(appointmentBelongsToEmployeeScope(appt, B)).toBe(false);
    });
  });

  it("trennt NULL sauber von der Mitarbeiter-Id 0 (kein Falsy-Vergleich)", () => {
    expect(
      appointmentBelongsToEmployeeScope(
        { status: "completed", assignedEmployeeId: null, performedByEmployeeId: 0 },
        0,
      ),
    ).toBe(true);
  });
});
