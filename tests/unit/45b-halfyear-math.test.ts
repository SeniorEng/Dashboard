/**
 * Golden-Cases für die halbjahresscharfe §45b-Übertrags-Gegenrechnung.
 *
 * Diese Datei existiert, weil die erste Fassung des Dry-Run-Skripts OHNE
 * Formel-Test gebaut wurde. Der Gate-2-Review fand daraufhin zwei Rechenfehler,
 * indem er Positivfälle in eine Wegwerf-DB pflanzte — beide wären hier ohne
 * jede Datenbank aufgefallen. Die betroffenen Fälle stehen unten namentlich
 * als Regression (B2, B3).
 *
 * ── Nicht mehr Einmal-Werkzeug ──────────────────────────────────────────
 * Die Formel ist mit dem Halbjahres-PR Produktionscode geworden
 * (`shared/domain/budget/halfyear-45b.ts`, Aufrufer: Übertrags-Anlage UND
 * Dry-Run). Diese Datei bleibt damit bestehen, auch wenn das Werkzeug
 * irgendwann gelöscht wird.
 *
 * ── Absorption kommt aus dem LEDGER, nicht aus dem Datum ────────────────
 * `absorbedByCarryInCents` ist der Betrag, den der Übertrag laut Verlinkung
 * (`allocation_id`) getragen hat. Die frühere Fassung leitete ihn aus dem
 * Buchungs-Datum ab; das deckte dieselben Cent doppelt, weil der
 * Verfalls-Write-Off den ungenutzten Rest über die Verlinkung bestimmt.
 * Die 30.06.-Frist wirkt weiterhin — nur eben beim Buchen, wo
 * `computeFifoAvailability` sie durchsetzt.
 *
 * Alle Beträge in Cent. 131 € Monatsanspruch = 13100 ct, Jahresanspruch
 * 12 × 13100 = 157200 ct — die im Repo übliche §45b-Größenordnung.
 */
import { describe, it, expect } from "vitest";
import {
  computeCarryoverPhantom,
  computeShortfall,
  entitlementForYear,
} from "@shared/domain/budget/halfyear-45b";

const JAHR = 157200;   // 12 × 131 €
const UEBERTRAG = 100000; // 1000 €

describe("computeCarryoverPhantom — Golden-Cases", () => {
  it("Fall A: Verbrauch GEGEN den Übertrag gebucht — rechtmäßig aufgezehrt, kein Phantom", () => {
    // 800 € gegen die Übertragszeile gebucht (die FIFO-Buchung tut das nur,
    // solange die Frist läuft), Übertrag 1000 € deckt das.
    // consumedOwn = 0 → Übertrag raus = voller Jahresanspruch.
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 80000,
      absorbedByCarryInCents: 80000,
      persistedCarryoverOutCents: JAHR,
    });
    expect(r.absorbedCents).toBe(80000);
    expect(r.consumedOwnSollCents).toBe(0);
    expect(r.carryoverOutSollCents).toBe(JAHR);
    expect(r.phantomCents).toBe(0);
  });

  it("Fall B (der Bug): Verbrauch NICHT gegen den Übertrag gebucht darf ihn nicht aufzehren", () => {
    // 800 € am 15.09. verbraucht — die FIFO-Buchung konnte sie nicht gegen den
    // Übertrag verlinken, weil der am 30.06. bereits verfallen war.
    // Korrekt: die 800 € belasten den eigenen Topf → Übertrag raus = 157200 − 80000.
    // Der Schreibpfad rollte stattdessen den vollen Jahresanspruch weiter.
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 80000,
      absorbedByCarryInCents: 0,
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
      absorbedByCarryInCents: 0,
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
      absorbedByCarryInCents: 30000,
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
      absorbedByCarryInCents: 150000,
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
      absorbedByCarryInCents: 0,
      persistedCarryoverOutCents: 77200,   // schon der korrekte Wert
    });
    expect(r.phantomCents).toBe(0);
  });

  it("phantomCents wird nie negativ (persistierter Übertrag zu NIEDRIG)", () => {
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 0,
      absorbedByCarryInCents: 0,
      persistedCarryoverOutCents: 10000,
    });
    expect(r.carryoverOutSollCents).toBe(JAHR);
    expect(r.phantomCents).toBe(0);   // Unterdeckung ist ein anderer Befund
  });

  it("Absorptions-Eingabe wird geklammert: sie kann nie über der Jahressumme liegen", () => {
    // Schutz gegen inkonsistente Eingaben aus dem Aufrufer.
    const r = computeCarryoverPhantom({
      sourceYearAllocatedCents: JAHR,
      prevCarryInCents: UEBERTRAG,
      netConsumptionYearCents: 30000,
      absorbedByCarryInCents: 80000,   // widersprüchlich
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

describe("entitlementForYear — Jahresanspruch (ersetzt sourceYearEntitlementCents)", () => {
  const M = 13100;                      // 131 EUR Monatsanspruch
  const VOLL = [{ validFrom: "1970-01-01", validTo: null, monthlyLimitCents: null, enabled: true }];
  const basis = (over: Partial<Parameters<typeof entitlementForYear>[0]> = {}) => ({
    asOfIso: "2026-08-11", sourceYear: 2025, pgStartIso: "2020-01-01",
    settings: VOLL, allocations: [], transactions: [], ...over,
  });
  const dez = (y: number) => ({ year: y, month: 12 });

  it("volles Jahr, Anker liegt davor → 12 Monate", () => {
    expect(entitlementForYear(basis(), 2025, "2020-01-01", dez(2025))).toBe(12 * M);
  });

  it("Anker liegt IM Jahr → nur ab diesem Monat", () => {
    expect(entitlementForYear(basis(), 2025, "2025-09-15", dez(2025))).toBe(4 * M);
  });

  it("REGRESSION B7: Startwert wird ADDIERT und sein Monat uebersprungen", () => {
    // Der frueher exportierte sourceYearEntitlementCents liess beides weg und
    // meldete deshalb 2500 EUR Phantom statt 500 EUR.
    const i = basis({
      allocations: [{ year: 2025, month: 3, amountCents: 200000, source: "initial_balance", validFrom: "2025-03-01", expiresAt: null }],
    });
    expect(entitlementForYear(i, 2025, "2020-01-01", dez(2025))).toBe(11 * M + 200000);
  });

  it("REGRESSION B8: das Settings-Fenster verkuerzt den Zeitraum", () => {
    // Ab Mai eingerichtet → 8 Monate. Der alte Export ignorierte das Fenster
    // und kam auf 12 Monate.
    const i = basis({ settings: [{ validFrom: "2025-05-01", validTo: null, monthlyLimitCents: null, enabled: true }] });
    expect(entitlementForYear(i, 2025, "2020-01-01", dez(2025))).toBe(8 * M);
  });

  it("historisierter Monatsbetrag wird pro Monat nachgeschlagen", () => {
    const i = basis({ settings: [
      { validFrom: "1970-01-01", validTo: "2025-06-30", monthlyLimitCents: null, enabled: true },
      { validFrom: "2025-07-01", validTo: null, monthlyLimitCents: 10000, enabled: true },
    ] });
    expect(entitlementForYear(i, 2025, "2020-01-01", dez(2025))).toBe(6 * M + 6 * 10000);
  });

  it("REGRESSION B1: das Ergebnis haengt NICHT vom laufenden Jahr ab", () => {
    for (const jahr of [2023, 2024, 2025, 2026]) {
      expect(entitlementForYear(basis(), jahr, "2019-01-01", dez(jahr))).toBe(12 * M);
    }
  });

  it("Ende vor Beginn → 0", () => {
    expect(entitlementForYear(basis(), 2025, "2026-01-01", dez(2025))).toBe(0);
  });
});
