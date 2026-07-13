/**
 * Task #1745 — Exhaustiveness-Guard für die Termin-Status-Partition.
 *
 * `shared/domain/appointments.ts` leitet die fachliche Frage „ist dieser Termin
 * noch offen?" aus GENAU EINER Partition ab:
 *   - `PERSISTED_APPOINTMENT_STATUSES` = alle tatsächlich in `appointments.status`
 *     gespeicherten Status (alles außer dem reinen Anzeige-Label
 *     `expired_unsigned`).
 *   - `FINAL_APPOINTMENT_STATUSES` (terminal) und `UNDOCUMENTED_STATUSES` (offen,
 *     als Komplement abgeleitet) bilden zusammen diese Partition.
 *
 * Diese Partition steuert drei Stellen: Monatsabschluss-Readiness, die
 * Leistungsnachweis-Blockade UND die „noch offene Termine"-Zählung der
 * Abrechnungs-Karte. Wird künftig ein neuer Status zum Typ `AppointmentStatus`
 * hinzugefügt, aber in `PERSISTED_APPOINTMENT_STATUSES` vergessen, driften diese
 * Zählungen still (Termine werden falsch als „fertig"/„offen" gewertet) — ohne
 * dass ein anderer Test anschlägt. Dieser Guard fängt genau das ab.
 *
 * Enumerations-Quelle: `STATUS_LABELS` ist per Compiler ein
 * `Record<AppointmentStatus, string>` und deckt damit ZWINGEND alle Werte des
 * Union-Typs `AppointmentStatus` ab. Fügt jemand einen Status zum Typ hinzu,
 * erzwingt `tsc` einen Eintrag in `STATUS_LABELS`, und dieser Test sieht den
 * neuen Wert automatisch.
 */
import { describe, it, expect } from "vitest";
import {
  STATUS_LABELS,
  PERSISTED_APPOINTMENT_STATUSES,
  FINAL_APPOINTMENT_STATUSES,
  UNDOCUMENTED_STATUSES,
  type AppointmentStatus,
} from "../../shared/domain/appointments";

// Das einzige reine Anzeige-Label, das NICHT persistiert wird.
const DISPLAY_ONLY_STATUSES: readonly AppointmentStatus[] = ["expired_unsigned"];

// Alle Werte des Union-Typs `AppointmentStatus` — Compiler-erzwungen vollständig.
const ALL_APPOINTMENT_STATUSES = Object.keys(STATUS_LABELS) as AppointmentStatus[];

describe("Termin-Status-Partition (Exhaustiveness-Guard, Task #1745)", () => {
  it("PERSISTED_APPOINTMENT_STATUSES deckt alle persistierten Status ab (= alle außer expired_unsigned)", () => {
    const expectedPersisted = ALL_APPOINTMENT_STATUSES.filter(
      (s) => !DISPLAY_ONLY_STATUSES.includes(s),
    ).sort();

    const actualPersisted = [...PERSISTED_APPOINTMENT_STATUSES].sort();

    expect(actualPersisted).toEqual(expectedPersisted);
  });

  it("expired_unsigned ist bewusst NICHT persistiert", () => {
    expect(PERSISTED_APPOINTMENT_STATUSES).not.toContain("expired_unsigned");
  });

  it("PERSISTED_APPOINTMENT_STATUSES enthält keine Duplikate", () => {
    const unique = new Set<string>(PERSISTED_APPOINTMENT_STATUSES);
    expect(unique.size).toBe(PERSISTED_APPOINTMENT_STATUSES.length);
  });

  it("FINAL_APPOINTMENT_STATUSES ist eine Teilmenge der persistierten Status", () => {
    const persisted = new Set<string>(PERSISTED_APPOINTMENT_STATUSES);
    for (const s of FINAL_APPOINTMENT_STATUSES) {
      expect(persisted.has(s)).toBe(true);
    }
  });

  it("FINAL und UNDOCUMENTED sind disjunkt", () => {
    const finalSet = new Set<string>(FINAL_APPOINTMENT_STATUSES);
    const overlap = UNDOCUMENTED_STATUSES.filter((s) => finalSet.has(s));
    expect(overlap).toEqual([]);
  });

  it("FINAL ∪ UNDOCUMENTED = PERSISTED (vollständige Partition, keine Lücke)", () => {
    const union = new Set<string>([
      ...FINAL_APPOINTMENT_STATUSES,
      ...UNDOCUMENTED_STATUSES,
    ]);
    const persisted = new Set<string>(PERSISTED_APPOINTMENT_STATUSES);

    expect([...union].sort()).toEqual([...persisted].sort());
  });
});
