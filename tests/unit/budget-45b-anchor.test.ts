import { describe, it, expect } from "vitest";
import {
  earliest45bRelevantAnchor,
  clampDerived45bAnchor,
  floorAutoAnchor45bToCurrentYear,
} from "@shared/domain/budgets";

// Task #856 — §45b wird ab dem Pflegegrad-Beginn angesetzt. Zwei verschiedene
// Anker-Regeln dürfen NICHT verwechselt werden:
//   - `clampDerived45bAnchor`  → EXPLIZITE, audit-pflichtige Pfade
//     (Startwert-Eingabe, Korrektur-Skript): erlaubt das rechtliche
//     Vorjahres-Fenster (aktuelles Jahr + Vorjahr bis 30.06.).
//   - `floorAutoAnchor45bToCurrentYear` → AUTO-Fallback für nie eingerichtete
//     Kunden: nur laufendes Jahr, NIE ein Vorjahres-Übertrag.
describe("§45b Anchor-Helfer (Task #856)", () => {
  describe("earliest45bRelevantAnchor", () => {
    it("zählt im 1. Halbjahr noch das Vorjahr als Fensteranfang", () => {
      // Januar–Juni: Vorjahres-Carryover ist bis 30.06. gültig.
      expect(earliest45bRelevantAnchor(2026, 1)).toBe("2025-01-01");
      expect(earliest45bRelevantAnchor(2026, 6)).toBe("2025-01-01");
    });
    it("ab Juli zählt nur noch das laufende Jahr", () => {
      expect(earliest45bRelevantAnchor(2026, 7)).toBe("2026-01-01");
      expect(earliest45bRelevantAnchor(2026, 12)).toBe("2026-01-01");
    });
  });

  describe("clampDerived45bAnchor (explizite Pfade)", () => {
    it("hebt ein zu frühes Datum auf den Fensteranfang an", () => {
      // PG seit 2018 → im 1. Halbjahr auf Vorjahresanfang gekappt.
      expect(clampDerived45bAnchor("2018-03-01", 2026, 5)).toBe("2025-01-01");
    });
    it("lässt ein Datum innerhalb des Fensters unverändert", () => {
      expect(clampDerived45bAnchor("2026-03-01", 2026, 5)).toBe("2026-03-01");
      expect(clampDerived45bAnchor("2025-07-01", 2026, 5)).toBe("2025-07-01");
    });
    it("lässt ein zukünftiges Datum unverändert", () => {
      expect(clampDerived45bAnchor("2026-09-01", 2026, 5)).toBe("2026-09-01");
    });
    it("ist idempotent (doppeltes Kappen ändert nichts)", () => {
      // Der §45b-`/initial-budget`-Write kappt den Anker; ein erneutes Kappen
      // desselben Werts MUSS dasselbe Ergebnis liefern.
      const once = clampDerived45bAnchor("2018-03-01", 2026, 5);
      expect(clampDerived45bAnchor(once, 2026, 5)).toBe(once);
    });
    it("bändigt einen weit zurückliegenden pflegegradSeit auf dem §45b-Write", () => {
      // Regression Task #856: Der Wizard postet §45b mit `pflegegradSeit`
      // (z. B. 2019). Der §45b-`/initial-budget`-Write MUSS diesen Wert aufs
      // rechtliche Carryover-/Verfalls-Fenster (aktuelles Jahr + Vorjahr bis
      // 30.06.) kappen, sonst akkumuliert der Entlastungsbetrag jahrelang
      // rückwirkend. §45a/§39 lassen die kunden-weiten Preferences unangetastet.
      expect(clampDerived45bAnchor("2019-06-15", 2026, 5)).toBe("2025-01-01");
      expect(clampDerived45bAnchor("2019-06-15", 2026, 8)).toBe("2026-01-01");
    });
  });

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
