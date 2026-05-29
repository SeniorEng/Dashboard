/**
 * Pure-Unit-Tests für die Urlaubsanspruch-Berechnung in
 * `shared/domain/vacation.ts` (Task #791 — Mutation-Testing-Erweiterung).
 *
 * Diese Tests laufen OHNE DB/Server und sind Teil der Stryker-Mutation-
 * Suite. Abgedeckt:
 *   - getVacationEntitlement (Pro-Rata bei unterjährigem Eintritt)
 *   - calculateVacationEntitlementByWorkDays
 *   - calculateCarryOverDays (Verfalls-Stichtag 1. April)
 *   - calculateAnnualEntitlementWithHistory (History-Segmente, Pro-Rata)
 *   - summarizeMonthlyBreakdown
 *   - simulateAnnualEntitlementWithPatch
 *
 * Schwerpunkt auf Monatsgrenzen (Eintritt Jan vs. Dez), dem Verfalls-
 * Stichtag und dem Rundungsverhalten (Math.ceil / Math.round), damit
 * Mutationen an Operatoren und Konstanten gefangen werden.
 */
// @ts-nocheck

import { describe, it, expect } from "vitest";
import {
  getVacationEntitlement,
  calculateCarryOverDays,
  calculateVacationEntitlementByWorkDays,
  calculateAnnualEntitlementWithHistory,
  summarizeMonthlyBreakdown,
  simulateAnnualEntitlementWithPatch,
} from "@shared/domain/vacation";

describe("getVacationEntitlement — Pro-Rata bei unterjährigem Eintritt", () => {
  it("liefert den vollen Anspruch ohne Eintrittsdatum", () => {
    expect(getVacationEntitlement(30, null, 2025)).toBe(30);
  });

  it("liefert 0 für Jahre vor dem Eintrittsjahr", () => {
    expect(getVacationEntitlement(24, "2024-04-15", 2023)).toBe(0);
  });

  it("liefert den vollen Anspruch für Jahre nach dem Eintrittsjahr", () => {
    expect(getVacationEntitlement(24, "2024-04-15", 2025)).toBe(24);
  });

  it("rechnet anteilig im Eintrittsjahr und rundet auf (Math.ceil)", () => {
    // Eintritt April (Monat-Index 3) → remainingMonths = 12 - 3 = 9.
    // 24/12 * 9 = 18 (exakt).
    expect(getVacationEntitlement(24, "2024-04-15", 2024)).toBe(18);
    // Eintritt November (Index 10) → remainingMonths = 2 → 24/12*2 = 4.
    expect(getVacationEntitlement(24, "2024-11-10", 2024)).toBe(4);
    // Eintritt Januar (Index 0) → remainingMonths = 12 → voller Anspruch.
    expect(getVacationEntitlement(30, "2024-01-01", 2024)).toBe(30);
    // Aufrundung sichtbar machen: 25/12 * 9 = 18.75 → ceil = 19.
    expect(getVacationEntitlement(25, "2024-04-15", 2024)).toBe(19);
    // Eintritt Dezember (Index 11) → remainingMonths = 1 → 30/12 = 2.5 → 3.
    expect(getVacationEntitlement(30, "2024-12-01", 2024)).toBe(3);
  });
});

describe("calculateVacationEntitlementByWorkDays", () => {
  it("rechnet (weeklyWorkDays * 24) / 6 und rundet kaufmännisch", () => {
    expect(calculateVacationEntitlementByWorkDays(6)).toBe(24);
    expect(calculateVacationEntitlementByWorkDays(5)).toBe(20);
    expect(calculateVacationEntitlementByWorkDays(3)).toBe(12);
    // 1 Tag: 24/6 = 4.
    expect(calculateVacationEntitlementByWorkDays(1)).toBe(4);
    // Rundung sichtbar: 4 Tage → 16; halber Tag-Effekt: 0.5 → 2.
    expect(calculateVacationEntitlementByWorkDays(0.5)).toBe(2);
  });
});

describe("calculateCarryOverDays — Verfall am 1. April", () => {
  it("liefert 0, wenn nichts übrig ist", () => {
    expect(calculateCarryOverDays(0, 2025, "2025-01-15")).toBe(0);
    expect(calculateCarryOverDays(-3, 2025, "2025-01-15")).toBe(0);
  });

  it("behält Resttage vor dem Verfalls-Stichtag", () => {
    expect(calculateCarryOverDays(5, 2025, "2025-03-31")).toBe(5);
  });

  it("verfällt am 1. April und danach", () => {
    expect(calculateCarryOverDays(5, 2025, "2025-04-01")).toBe(0);
    expect(calculateCarryOverDays(5, 2025, "2025-06-15")).toBe(0);
  });

  it("behält Resttage, wenn der Stichtag noch im Vorjahr liegt", () => {
    expect(calculateCarryOverDays(5, 2025, "2024-12-20")).toBe(5);
  });
});

describe("calculateAnnualEntitlementWithHistory", () => {
  it("fällt ohne History auf getVacationEntitlement zurück", () => {
    expect(calculateAnnualEntitlementWithHistory([], "2024-04-15", 2024, 24)).toBe(18);
    expect(calculateAnnualEntitlementWithHistory([], null, 2025, 30)).toBe(30);
  });

  it("liefert 0 für Jahre vor dem Eintrittsjahr", () => {
    const history = [{ validFromYear: 2024, validFromMonth: 4, daysPerYear: 24 }];
    expect(calculateAnnualEntitlementWithHistory(history, "2024-04-15", 2023, 24)).toBe(0);
  });

  it("rechnet konstanten Anspruch über das volle Jahr", () => {
    const history = [{ validFromYear: 2020, validFromMonth: 1, daysPerYear: 24 }];
    expect(calculateAnnualEntitlementWithHistory(history, "2020-01-01", 2025, 24)).toBe(24);
  });

  it("berücksichtigt einen unterjährigen History-Wechsel anteilig", () => {
    // Jahresanfang 12 Tage/Jahr, ab Juli (Monat 7) 24 Tage/Jahr.
    // Jan–Jun: 6 * 12/12 = 6 ; Jul–Dez: 6 * 24/12 = 12 → Summe 18.
    const history = [
      { validFromYear: 2024, validFromMonth: 1, daysPerYear: 12 },
      { validFromYear: 2025, validFromMonth: 7, daysPerYear: 24 },
    ];
    expect(calculateAnnualEntitlementWithHistory(history, null, 2025, 12)).toBe(18);
  });

  it("lässt Monate vor dem Eintrittsmonat im Eintrittsjahr weg", () => {
    // Eintritt April 2025, 24 Tage/Jahr → Apr–Dez = 9 * 24/12 = 18.
    const history = [{ validFromYear: 2025, validFromMonth: 4, daysPerYear: 24 }];
    expect(calculateAnnualEntitlementWithHistory(history, "2025-04-15", 2025, 24)).toBe(18);
  });

  it("nutzt den frühesten History-Wert, wenn alle Einträge in der Zukunft liegen", () => {
    // Betrachtetes Jahr 2025, History erst ab 2026 → früheste Row (30) gilt
    // für das ganze Jahr 2025.
    const history = [{ validFromYear: 2026, validFromMonth: 1, daysPerYear: 30 }];
    expect(calculateAnnualEntitlementWithHistory(history, null, 2025, 12)).toBe(30);
  });

  it("sortiert eine unsortierte History korrekt (zwei Wechsel im selben Jahr)", () => {
    // Reihenfolge bewusst verdreht — die Funktion MUSS nach validFrom sortieren.
    // Korrekt sortiert: Mär 12 Tage/Jahr, ab Sep 24 Tage/Jahr.
    //   Jan–Feb: 2 × 12/12 = 2
    //   Mär–Aug: 6 × 12/12 = 6
    //   Sep–Dez: 4 × 24/12 = 8  → Summe 16.
    // Bliebe die Reihenfolge unsortiert (Sep zuerst), käme 18 heraus.
    const history = [
      { validFromYear: 2025, validFromMonth: 9, daysPerYear: 24 },
      { validFromYear: 2025, validFromMonth: 3, daysPerYear: 12 },
    ];
    expect(calculateAnnualEntitlementWithHistory(history, null, 2025, 99)).toBe(16);
  });

  it("wählt den zum Jahresanfang gültigen Wert aus mehreren Vorjahres-Einträgen", () => {
    // Zwei Vorjahres-Einträge, unsortiert. Der zum Jahresstart 2025 gültige
    // Wert ist der SPÄTERE (2024-06 → 20), nicht der erste der Liste.
    // Keine Wechsel in 2025 → ganzjährig 20 Tage/Jahr → 20.
    // Ohne den Init-Loop (nur sorted[0]) käme fälschlich 12 heraus.
    const history = [
      { validFromYear: 2023, validFromMonth: 1, daysPerYear: 12 },
      { validFromYear: 2024, validFromMonth: 6, daysPerYear: 20 },
    ];
    expect(calculateAnnualEntitlementWithHistory(history, null, 2025, 99)).toBe(20);
  });

  it("zählt das volle Jahr, wenn der Eintritt in einem Vorjahr liegt", () => {
    // Eintritt 2024 → in 2025 zählt jeder Monat (kein Monats-Skip).
    const history = [{ validFromYear: 2024, validFromMonth: 6, daysPerYear: 30 }];
    expect(calculateAnnualEntitlementWithHistory(history, "2024-06-15", 2025, 30)).toBe(30);
  });
});

describe("summarizeMonthlyBreakdown", () => {
  it("liefert ein einzelnes Segment bei konstantem Anspruch", () => {
    const history = [{ validFromYear: 2020, validFromMonth: 1, daysPerYear: 24 }];
    expect(summarizeMonthlyBreakdown(history, null, 2025, 24)).toEqual([
      { fromMonth: 1, toMonth: 12, daysPerYear: 24 },
    ]);
  });

  it("teilt das Jahr bei einem unterjährigen Wechsel in zwei Segmente", () => {
    const history = [
      { validFromYear: 2025, validFromMonth: 1, daysPerYear: 12 },
      { validFromYear: 2025, validFromMonth: 7, daysPerYear: 24 },
    ];
    expect(summarizeMonthlyBreakdown(history, null, 2025, 12)).toEqual([
      { fromMonth: 1, toMonth: 6, daysPerYear: 12 },
      { fromMonth: 7, toMonth: 12, daysPerYear: 24 },
    ]);
  });

  it("startet das erste Segment im Eintrittsmonat", () => {
    const history = [{ validFromYear: 2025, validFromMonth: 4, daysPerYear: 24 }];
    expect(summarizeMonthlyBreakdown(history, "2025-04-15", 2025, 24)).toEqual([
      { fromMonth: 4, toMonth: 12, daysPerYear: 24 },
    ]);
  });

  it("liefert eine leere Liste für Jahre vor dem Eintritt", () => {
    const history = [{ validFromYear: 2025, validFromMonth: 4, daysPerYear: 24 }];
    expect(summarizeMonthlyBreakdown(history, "2025-04-15", 2024, 24)).toEqual([]);
  });

  it("sortiert eine unsortierte History korrekt in Segmente", () => {
    // Verdrehte Reihenfolge — korrekt sortiert: Jan–Aug 12, Sep–Dez 24.
    // Ohne Sortierung kämen falsche/zusätzliche Segmente heraus.
    const history = [
      { validFromYear: 2025, validFromMonth: 9, daysPerYear: 24 },
      { validFromYear: 2025, validFromMonth: 3, daysPerYear: 12 },
    ];
    expect(summarizeMonthlyBreakdown(history, null, 2025, 99)).toEqual([
      { fromMonth: 1, toMonth: 8, daysPerYear: 12 },
      { fromMonth: 9, toMonth: 12, daysPerYear: 24 },
    ]);
  });

  it("nutzt den zum Jahresanfang gültigen Vorjahres-Wert als erstes Segment", () => {
    // Zwei Vorjahres-Einträge → der spätere (20) gilt zum Jahresstart.
    const history = [
      { validFromYear: 2023, validFromMonth: 1, daysPerYear: 12 },
      { validFromYear: 2024, validFromMonth: 6, daysPerYear: 20 },
    ];
    expect(summarizeMonthlyBreakdown(history, null, 2025, 99)).toEqual([
      { fromMonth: 1, toMonth: 12, daysPerYear: 20 },
    ]);
  });

  it("beginnt das Segment im Januar, wenn der Eintritt in einem Vorjahr liegt", () => {
    const history = [{ validFromYear: 2024, validFromMonth: 6, daysPerYear: 30 }];
    expect(summarizeMonthlyBreakdown(history, "2024-06-15", 2025, 30)).toEqual([
      { fromMonth: 1, toMonth: 12, daysPerYear: 30 },
    ]);
  });
});

describe("simulateAnnualEntitlementWithPatch", () => {
  it("überschreibt einen bestehenden Monatseintrag und liefert den neuen Anspruch", () => {
    const history = [{ validFromYear: 2025, validFromMonth: 1, daysPerYear: 12 }];
    const result = simulateAnnualEntitlementWithPatch(history, null, 2025, 1, 24, 12);
    expect(result.entitlement).toBe(24);
    expect(result.history).toEqual([
      { validFromYear: 2025, validFromMonth: 1, daysPerYear: 24 },
    ]);
  });

  it("hängt einen neuen Eintrag an und behält bestehende Monate", () => {
    const history = [{ validFromYear: 2025, validFromMonth: 1, daysPerYear: 12 }];
    const result = simulateAnnualEntitlementWithPatch(history, null, 2025, 7, 24, 12);
    // Jan–Jun 12, Jul–Dez 24 → 6 + 12 = 18.
    expect(result.entitlement).toBe(18);
    expect(result.history).toHaveLength(2);
  });

  it("ersetzt nur den Eintrag im exakt selben Jahr+Monat, nicht denselben Monat anderer Jahre", () => {
    // Patch betrifft 2025-07. Der gleichnamige Monat eines ANDEREN Jahres
    // (2024-07) darf NICHT entfernt werden — nur Jahr UND Monat zusammen matchen.
    const history = [
      { validFromYear: 2024, validFromMonth: 7, daysPerYear: 10 },
      { validFromYear: 2025, validFromMonth: 7, daysPerYear: 12 },
    ];
    const result = simulateAnnualEntitlementWithPatch(history, null, 2025, 7, 24, 12);
    // Der 2024-07-Eintrag bleibt erhalten, der 2025-07-Eintrag wird auf 24 gesetzt.
    expect(result.history).toContainEqual({
      validFromYear: 2024,
      validFromMonth: 7,
      daysPerYear: 10,
    });
    expect(result.history).toContainEqual({
      validFromYear: 2025,
      validFromMonth: 7,
      daysPerYear: 24,
    });
    expect(result.history).toHaveLength(2);
  });
});
