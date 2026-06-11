import { describe, it, expect } from "vitest";
import { floorAutoAnchor45bToCurrentYear } from "@shared/domain/budgets";

// Task #856/#860/#1215 — §45b wird ab dem Pflegegrad-Beginn angesetzt, der
// gesamte §45b-RUNTIME-Pfad (Lesepfad `calculateAllocated45b`, Carryover-Anlage
// `ensureYearlyCarryover45b`, `/initial-budget`-Write) UND der Auto-Fallback für
// nie eingerichtete Kunden boden den zur Laufzeit aus der Pflegegrad-Historie
// abgeleiteten Anker über `floorAutoAnchor45bToCurrentYear` auf das laufende
// Jahr. Das Vorjahr gilt beim Onboarding als aufgebraucht → NIE ein
// automatischer Vorjahres-Übertrag (12 × 131 €). Nur operator-erfasste Überträge
// zählen.
//
// Die früheren Helfer `clampDerived45bAnchor`/`earliest45bRelevantAnchor`
// (rechtliches Vorjahres-Fenster bis 30.06.) waren seit Task #1204 nicht mehr im
// Runtime-Pfad und wurden mit Task #1215 ersatzlos entfernt.
describe("§45b Anchor-Helfer (Task #856/#860/#1215)", () => {
  describe("floorAutoAnchor45bToCurrentYear (Auto-Fallback)", () => {
    it("hebt jedes Vorjahres-Datum auf den 1.1. des laufenden Jahres an", () => {
      // Kein automatischer Vorjahres-Übertrag (12 × 131 €) für nie
      // eingerichtete Kunden — auch nicht im 1. Halbjahr.
      expect(floorAutoAnchor45bToCurrentYear("2024-01-01", 2026)).toBe("2026-01-01");
      expect(floorAutoAnchor45bToCurrentYear("2025-12-31", 2026)).toBe("2026-01-01");
    });
    it("erhält den Pflegegrad-Beginn innerhalb des laufenden Jahres", () => {
      // Hannelore: PG seit März → ab März sichtbar.
      expect(floorAutoAnchor45bToCurrentYear("2026-03-01", 2026)).toBe("2026-03-01");
      expect(floorAutoAnchor45bToCurrentYear("2026-01-01", 2026)).toBe("2026-01-01");
    });
    it("lässt ein zukünftiges Datum unverändert", () => {
      expect(floorAutoAnchor45bToCurrentYear("2026-11-01", 2026)).toBe("2026-11-01");
    });
  });
});
