/**
 * Golden-Cases für die halbjahresscharfe §45b-Übertrags-Gegenrechnung.
 *
 * Diese Datei existiert, weil die erste Fassung des Dry-Run-Skripts OHNE
 * Formel-Test gebaut wurde. Der Gate-2-Review fand daraufhin zwei Rechenfehler,
 * indem er Positivfälle in eine Wegwerf-DB pflanzte — beide wären hier ohne
 * jede Datenbank aufgefallen. Die betroffenen Fälle stehen unten namentlich
 * als Regression (B2, B3).
 *
 * Gehört zum Einmal-Werkzeug und wird mit ihm gelöscht (One-off-Disziplin).
 *
 * Alle Beträge in Cent. 131 € Monatsanspruch = 13100 ct, Jahresanspruch
 * 12 × 13100 = 157200 ct — die im Repo übliche §45b-Größenordnung.
 */
import { describe, it, expect } from "vitest";
import {
  computeCarryoverPhantom,
  computeShortfall,
  sourceYearEntitlementCents,
} from "../../server/scripts/lib/45b-halfyear-math";

const JAHR = 157200;   // 12 × 131 €
const UEBERTRAG = 100000; // 1000 €

describe("computeCarryoverPhantom — Golden-Cases", () => {
  it("Fall A: Verbrauch VOR der Frist — Übertrag wird rechtmäßig aufgezehrt, kein Phantom", () => {
    // 800 € im H1 verbraucht, Übertrag 1000 € deckt das.
    // consumedOwn = 0 → Übertrag raus = voller Jahresanspruch.
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 80000,
      netConsumptionUntilDeadlineCents: 80000,
      persistedCarryoverOutCents: JAHR,
    });
    expect(r.absorbedCents).toBe(80000);
    expect(r.consumedOwnSollCents).toBe(0);
    expect(r.carryoverOutSollCents).toBe(JAHR);
    expect(r.phantomCents).toBe(0);
  });

  it("Fall B (der Bug): Verbrauch NACH der Frist darf den verfallenen Übertrag nicht aufzehren", () => {
    // 800 € am 15.09. verbraucht — der Übertrag war am 30.06. bereits weg.
    // Korrekt: die 800 € belasten den eigenen Topf → Übertrag raus = 157200 − 80000.
    // Der Schreibpfad rollte stattdessen den vollen Jahresanspruch weiter.
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 80000,
      netConsumptionUntilDeadlineCents: 0,
      persistedCarryoverOutCents: JAHR,
    });
    expect(r.absorbedCents).toBe(0);
    expect(r.consumedOwnSollCents).toBe(80000);
    expect(r.carryoverOutSollCents).toBe(77200);
    expect(r.phantomCents).toBe(80000);
  });

  it("REGRESSION B2: der Verfalls-Write-Off darf den Phantom-Betrag nicht aufblähen", () => {
    // Gemessener Review-Fall: Übertrag 1000 €, 800 € Verbrauch nach der Frist,
    // 200 € Verfalls-Write-Off am 01.07. Die erste Fassung zählte den Write-Off
    // ins Jahresfenster, aber nicht ins Fenster "bis Frist", und meldete 1000 €
    // statt 800 € — 25 % zu viel Storno.
    //
    // Hier tragen beide Eingaben NUR `consumption − reversal`; der Write-Off
    // taucht in keiner auf. Das Ergebnis muss identisch zu Fall B sein.
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 80000,           // OHNE die 200 € Write-Off
      netConsumptionUntilDeadlineCents: 0,
      persistedCarryoverOutCents: JAHR,
    });
    expect(r.phantomCents).toBe(80000);
    expect(r.phantomCents).not.toBe(100000);
  });

  it("Fall C: gemischt — H1 zehrt teilweise, H2 belastet den eigenen Topf", () => {
    // 300 € vor der Frist, 500 € danach (Jahressumme 800 €).
    // absorbed = 300 €, consumedOwn = 500 € → Übertrag raus = 157200 − 50000.
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 80000,
      netConsumptionUntilDeadlineCents: 30000,
      persistedCarryoverOutCents: JAHR,
    });
    expect(r.absorbedCents).toBe(30000);
    expect(r.consumedOwnSollCents).toBe(50000);
    expect(r.carryoverOutSollCents).toBe(107200);
    expect(r.phantomCents).toBe(50000);
  });

  it("Übertrag deckelt die Absorption — mehr H1-Verbrauch als Übertrag", () => {
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 150000,
      netConsumptionUntilDeadlineCents: 150000,
      persistedCarryoverOutCents: JAHR,
    });
    expect(r.absorbedCents).toBe(UEBERTRAG);       // nicht 150000
    expect(r.consumedOwnSollCents).toBe(50000);
    expect(r.carryoverOutSollCents).toBe(107200);
  });

  it("kein Phantom, wenn der persistierte Übertrag bereits korrekt ist", () => {
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 80000,
      netConsumptionUntilDeadlineCents: 0,
      persistedCarryoverOutCents: 77200,   // schon der korrekte Wert
    });
    expect(r.phantomCents).toBe(0);
  });

  it("phantomCents wird nie negativ (persistierter Übertrag zu NIEDRIG)", () => {
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 0,
      netConsumptionUntilDeadlineCents: 0,
      persistedCarryoverOutCents: 10000,
    });
    expect(r.carryoverOutSollCents).toBe(JAHR);
    expect(r.phantomCents).toBe(0);   // Unterdeckung ist ein anderer Befund
  });

  it("Fenster-Eingabe wird geklammert: 'bis Frist' kann nie über der Jahressumme liegen", () => {
    // Schutz gegen inkonsistente Eingaben aus dem Aufrufer.
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 30000,
      netConsumptionUntilDeadlineCents: 80000,   // widersprüchlich
      persistedCarryoverOutCents: JAHR,
    });
    expect(r.absorbedCents).toBe(30000);
    expect(r.consumedOwnSollCents).toBe(0);
  });
});

describe("computeShortfall — Golden-Cases", () => {
  it("REGRESSION B3: kein Fehlbetrag, wenn der Verbrauch vom korrekten Rest gedeckt ist", () => {
    // Gemessener Review-Fall: Kunde mit NULL Überzahlung. Die erste Fassung
    // zählte den Verfalls-Write-Off ins "geltend gemachte" und meldete 572 €
    // Fehlbetrag. `claimedCents` traegt hier nur `consumption − reversal`.
    const r = computeShortfall({
      claimedCents: 162000,
      targetYearAllocatedCents: 104800,
      carryoverInSollCents: 57200,
    });
    expect(r.availableCents).toBe(162000);
    expect(r.shortfallCents).toBe(0);
  });

  it("echter Fehlbetrag: Verbrauch über dem korrekten Rest", () => {
    const r = computeShortfall({
      claimedCents: 200000,
      targetYearAllocatedCents: 104800,
      carryoverInSollCents: 57200,
    });
    expect(r.availableCents).toBe(162000);
    expect(r.shortfallCents).toBe(38000);
  });

  it("kein negativer Fehlbetrag bei ungenutztem Budget", () => {
    const r = computeShortfall({
      claimedCents: 10000,
      targetYearAllocatedCents: 104800,
      carryoverInSollCents: 57200,
    });
    expect(r.shortfallCents).toBe(0);
  });
});

describe("sourceYearEntitlementCents — B1: zustandsunabhängiger Quelljahres-Anspruch", () => {
  const M = 13100;                      // 131 € Monatsanspruch
  const flat = () => M;
  const keine = new Set<string>();

  it("volles Jahr, Pflegegrad läuft schon vorher → 12 Monate", () => {
    expect(sourceYearEntitlementCents({
      sourceYear: 2025, pgStartIso: "2020-03-01",
      initialBalanceMonthKeys: keine, monthlyAmountFor: flat,
    })).toBe(12 * M);
  });

  it("Pflegegrad beginnt IM Quelljahr → nur ab diesem Monat", () => {
    // Start im September → Sep..Dez = 4 Monate.
    expect(sourceYearEntitlementCents({
      sourceYear: 2025, pgStartIso: "2025-09-15",
      initialBalanceMonthKeys: keine, monthlyAmountFor: flat,
    })).toBe(4 * M);
  });

  it("Pflegegrad beginnt NACH dem Quelljahr → 0", () => {
    expect(sourceYearEntitlementCents({
      sourceYear: 2025, pgStartIso: "2026-01-01",
      initialBalanceMonthKeys: keine, monthlyAmountFor: flat,
    })).toBe(0);
  });

  it("ohne Pflegegrad-Beginn → 0", () => {
    expect(sourceYearEntitlementCents({
      sourceYear: 2025, pgStartIso: null,
      initialBalanceMonthKeys: keine, monthlyAmountFor: flat,
    })).toBe(0);
  });

  it("Startwert-Monate werden übersprungen", () => {
    // Jan+Feb 2025 durch einen aktiven Startwert verdrängt → 10 Monate.
    expect(sourceYearEntitlementCents({
      sourceYear: 2025, pgStartIso: "2020-01-01",
      initialBalanceMonthKeys: new Set(["2025-1", "2025-2"]),
      monthlyAmountFor: flat,
    })).toBe(10 * M);
  });

  it("historisierter Monatsbetrag wird pro Monat nachgeschlagen", () => {
    // Ab Juli 2025 auf 100 € reduziert: 6 × 131 € + 6 × 100 €.
    const staffel = (y: number, m: number) => (y === 2025 && m >= 7 ? 10000 : M);
    expect(sourceYearEntitlementCents({
      sourceYear: 2025, pgStartIso: "2020-01-01",
      initialBalanceMonthKeys: keine, monthlyAmountFor: staffel,
    })).toBe(6 * M + 6 * 10000);
  });

  it("REGRESSION B1: das Ergebnis hängt NICHT vom laufenden Jahr ab", () => {
    // Der Defekt war, dass der Anspruch aus heutiger Sicht gerechnet wurde und
    // fuer ein vergangenes Jahr auf 0 kollabierte. Dieselben Eingaben muessen
    // fuer jedes Quelljahr denselben Wert liefern, egal wann gerechnet wird.
    for (const jahr of [2023, 2024, 2025, 2026]) {
      expect(sourceYearEntitlementCents({
        sourceYear: jahr, pgStartIso: "2019-01-01",
        initialBalanceMonthKeys: keine, monthlyAmountFor: flat,
      })).toBe(12 * M);
    }
  });
});
