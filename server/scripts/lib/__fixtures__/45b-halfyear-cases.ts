/**
 * SEED-FIXTURE mit BEKANNTEN ANTWORTEN für die halbjahresscharfe
 * §45b-Übertrags-Rechnung — die Grundlage der dritten Runde.
 *
 * Gehört zum Einmal-Werkzeug und wird mit ihm gelöscht (One-off-Disziplin).
 *
 * ── Warum diese Datei existiert ──────────────────────────────────────────
 * Zwei Runden Dry-Run-Skript, zwei vollständige Sätze gemessener Blocker —
 * jedes Mal gefunden, indem der Reviewer Daten pflanzte und das Skript laufen
 * ließ, nie durch Lesen. Die vorhandenen Golden-Cases fanden nichts davon,
 * weil sie der Arithmetik bereits BEREINIGTE Zahlen hineinreichen: die Fehler
 * saßen in der Komposition der Eingaben, nicht in der Formel.
 *
 * Diese Fälle sind deshalb an der ANDEREN Naht formuliert — roher
 * Datenzustand rein, fachlich korrekte Antwort raus. Eine Extraktion, die sie
 * alle erfüllt, kann B6–B10 nicht mehr enthalten.
 *
 * ── Vertrag für die zu bauende SSoT ──────────────────────────────────────
 * Die gemeinsame, DB-freie Funktion (Dry-Run UND Produktions-Fix) bekommt den
 * rohen Zustand eines Kunden-Jahres und liefert `expected`. Sie darf dafür
 * KEINEN zweiten Ableitungspfad aufmachen — insbesondere die Pro-Allocation-
 * Maps aus `computeFifoAvailability` bleiben unberührt (#33).
 *
 * Datenstand entspricht `cc_test_45b_rereview`; die Beträge sind gegen den
 * Schreibpfad gerechnet, nicht geschätzt. 13100 ct = 131 € Monatsanspruch.
 */

import { SETTINGS_VALID_FROM_EPOCH } from "@shared/domain/budget-settings-sentinel";

/** Roher Zustand eines Kunden-Jahres, wie er aus der DB käme. */
export interface CaseInput {
  /**
   * Bewertungs-Stichtag. PFLICHT, weil der Zieljahres-Anspruch bis „heute"
   * aufläuft: ohne festen Stichtag faulen die Soll-Antworten mit dem Kalender.
   * Tests frieren die Uhr hierauf ein (`tests/helpers/frozen-clock.ts`).
   */
  asOfIso: string;
  sourceYear: number;
  /** Pflegegrad-Beginn; `null` = keine Historie (Anker muss aus Allocations kommen). */
  pgStartIso: string | null;
  /** §45b-Settings mit ihrem Gültigkeitsfenster — VOLLE Historie, keine Scheibe. */
  settings: Array<{ validFrom: string; validTo: string | null; monthlyLimitCents: number | null; enabled: boolean }>;
  /** Alle nicht-gelöschten Allocations des Kunden. */
  allocations: Array<{ year: number; month: number | null; amountCents: number; source: string; validFrom: string; expiresAt: string | null }>;
  /** Alle §45b-Transaktionen des Kunden. */
  transactions: Array<{ date: string; type: "consumption" | "reversal" | "write_off"; amountCents: number }>;
}

export interface CaseExpectation {
  /** `true` = Quelljahr liegt vor dem Anspruchsfenster, nicht bewertbar. */
  notEvaluable?: boolean;
  /** `true` = Eligibility-Gate greift, der Kunde hat gar keinen §45b-Anspruch. */
  ineligible?: boolean;
  /** Anspruch des Quelljahres: Monatsaufstockungen + initial_balance. */
  sourceYearEntitlementCents: number;
  /** Übertrag, der ins Folgejahr hätte rollen dürfen. */
  carryoverOutSollCents: number;
  /** Zu viel gerollt = persistiert − soll. */
  phantomCents: number;
  /** Fehlbetrag im ZIELJAHR, halbjahresscharf gerechnet. */
  shortfallCents: number;
}

export interface HalfYearCase {
  id: string;
  /** Welchen gemessenen Blocker dieser Fall verriegelt. */
  guards: string;
  beschreibung: string;
  input: CaseInput;
  expected: CaseExpectation;
}

const VOLL = [{ validFrom: SETTINGS_VALID_FROM_EPOCH, validTo: null, monthlyLimitCents: null, enabled: true }];

/** Stichtag aller Fälle — derselbe, an dem der Re-Review gemessen hat. */
export const AS_OF = "2026-08-11";

export const HALFYEAR_CASES: HalfYearCase[] = [
  {
    id: "C1",
    guards: "Basisfall — Verbrauch NACH der Frist zehrt den verfallenen Übertrag nicht auf",
    beschreibung:
      "Übertrag 1000 € (Frist 30.06.2025), 800 € Verbrauch am 15.09.2025. Der Schreibpfad " +
      "rollte den vollen Jahresanspruch 1572 € weiter; korrekt sind 772 €.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: VOLL,
      allocations: [
        { year: 2025, month: null, amountCents: 100000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
        { year: 2026, month: null, amountCents: 157200, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [
        { date: "2025-09-15", type: "consumption", amountCents: -80000 },
        { date: "2026-03-01", type: "consumption", amountCents: -200000 },
      ],
    },
    expected: {
      sourceYearEntitlementCents: 157200,
      carryoverOutSollCents: 77200,
      phantomCents: 80000,
      // Zieljahr 2026 zum Stichtag 11.08.: Anspruch Jan–Aug = 8 × 13100 =
      // 104800. Der Verbrauch (01.03.) liegt VOR dem Verfall des korrigierten
      // Übertrags am 30.06., darf ihn also aufzehren → verfügbar 104800 +
      // 77200 = 182000 gegen 200000 → 18000 offen.
      shortfallCents: 18000,
    },
  },
  {
    id: "C2",
    guards: "B6 — Zieljahres-Anspruch darf für vergangene Jahre nicht auf 0 kollabieren",
    beschreibung:
      "Wie C1, aber ein Jahr früher (Quelljahr 2024 → Zieljahr 2025). Das Skript meldete " +
      "228 € Fehlbetrag 'davon gestellt'; korrekt sind 0 €, weil der 2025er Jahresanspruch " +
      "in der Verfügbarkeit fehlte.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2024,
      pgStartIso: "2020-01-01",
      settings: VOLL,
      allocations: [
        { year: 2024, month: null, amountCents: 100000, source: "carryover", validFrom: "2024-01-01", expiresAt: "2024-06-30" },
        { year: 2025, month: null, amountCents: 157200, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
      ],
      transactions: [
        { date: "2024-09-15", type: "consumption", amountCents: -80000 },
        { date: "2025-03-01", type: "consumption", amountCents: -100000 },
      ],
    },
    expected: {
      sourceYearEntitlementCents: 157200,
      carryoverOutSollCents: 77200,
      phantomCents: 80000,
      shortfallCents: 0,
    },
  },
  {
    id: "C3",
    guards: "B8 — Settings-Historie und ihr Gültigkeitsfenster",
    beschreibung:
      "§45b erst ab 01.05.2025 eingerichtet → 8 Monate = 1048 €, nicht 1572 €. Das Skript " +
      "rechnete mit 12 Monaten, kam auf phantom = 0 und ließ den Kunden STILL aus dem " +
      "Report fallen — ohne Eintrag in `degenerate`, ohne Gegenprobe-Meldung.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: [{ validFrom: "2025-05-01", validTo: null, monthlyLimitCents: null, enabled: true }],
      allocations: [
        { year: 2025, month: null, amountCents: 50000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
        { year: 2026, month: null, amountCents: 104800, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [{ date: "2025-09-15", type: "consumption", amountCents: -50000 }],
    },
    expected: {
      sourceYearEntitlementCents: 104800,   // 8 × 13100
      carryoverOutSollCents: 54800,
      phantomCents: 50000,
      shortfallCents: 0,
    },
  },
  {
    id: "C4",
    guards: "B7 — initial_balance gehört in den Quelljahres-Anspruch",
    beschreibung:
      "Startwert 2000 € im März 2025. Anspruch = 11 Monatsaufstockungen (März verdrängt) " +
      "+ 2000 € = 3441 €. Das Skript ließ den Startwert weg UND übersprang den Monat, " +
      "meldete deshalb 2500 € Phantom statt 500 €.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: VOLL,
      allocations: [
        { year: 2025, month: 3, amountCents: 200000, source: "initial_balance", validFrom: "2025-03-01", expiresAt: null },
        { year: 2025, month: null, amountCents: 50000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
        { year: 2026, month: null, amountCents: 334100, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [{ date: "2025-09-15", type: "consumption", amountCents: -60000 }],
    },
    expected: {
      sourceYearEntitlementCents: 344100,   // 11 × 13100 + 200000
      carryoverOutSollCents: 284100,
      phantomCents: 50000,
      shortfallCents: 0,
    },
  },
  {
    id: "C5",
    guards: "B9 — ohne Pflegegrad-Historie muss der Anker aus den Allocations kommen",
    beschreibung:
      "Wie C1, aber ohne `customer_care_level_history`. Der Produktionspfad ankert dann " +
      "über `initial_balance`/`carryover.validFrom`; das Skript lieferte 0 und übersprang " +
      "den Kunden — er tauchte nur als anonyme Zahl in einer stderr-Zeile auf.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: null,
      settings: VOLL,
      allocations: [
        { year: 2025, month: null, amountCents: 100000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
        { year: 2026, month: null, amountCents: 157200, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [{ date: "2025-09-15", type: "consumption", amountCents: -80000 }],
    },
    expected: {
      sourceYearEntitlementCents: 157200,
      carryoverOutSollCents: 77200,
      phantomCents: 80000,
      shortfallCents: 0,
    },
  },
  {
    id: "C6",
    guards: "B10 — der korrigierte Übertrag ist im ZIELJAHR nicht ganzjährig verfügbar",
    beschreibung:
      "Wie C1, aber der Zieljahres-Verbrauch (2000 €) liegt am 15.07.2026 — nach dem " +
      "Verfall des Übertrags am 30.06.2026. Das Skript meldete 180 €, denselben Wert wie " +
      "bei Verbrauch im März, weil es den Übertrag als ganzjährig verfügbar behandelte. " +
      "Das ist derselbe Denkfehler wie im Produktionscode, gegen den dieser Report " +
      "geschrieben wurde.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: VOLL,
      allocations: [
        { year: 2025, month: null, amountCents: 100000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
        { year: 2026, month: null, amountCents: 157200, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [
        { date: "2025-09-15", type: "consumption", amountCents: -80000 },
        { date: "2026-07-15", type: "consumption", amountCents: -200000 },
      ],
    },
    expected: {
      sourceYearEntitlementCents: 157200,
      carryoverOutSollCents: 77200,
      phantomCents: 80000,
      // Verbrauch am 15.07. liegt NACH dem 30.06. → der Übertrag ist bereits
      // verfallen und darf nichts absorbieren. Verfügbar ist nur der eigene
      // Anspruch Jan–Aug = 104800 gegen 200000 → 95200 offen.
      // Die Differenz zu C1 (18000) IST der Befund: gleicher Betrag, anderes
      // Datum, anderes Ergebnis.
      shortfallCents: 95200,
    },
  },
  {
    id: "C7",
    guards: "B9-Variante — Pflegegrad vorhanden, §45b aber nie eingerichtet",
    beschreibung:
      "Das Eligibility-Gate (`allocation-storage.ts:694`) liefert hart 0, wenn keine " +
      "§45b-Zeile aktiviert ist — 131 €/Monat ist ein fixer statutorischer Betrag, es gibt " +
      "keinen `monthlyAmount==0`-Schutz wie bei §45a. Das Skript erfand stattdessen 1572 €.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: [{ validFrom: SETTINGS_VALID_FROM_EPOCH, validTo: null, monthlyLimitCents: null, enabled: false }],
      allocations: [],
      transactions: [],
    },
    expected: {
      ineligible: true,
      sourceYearEntitlementCents: 0,
      carryoverOutSollCents: 0,
      phantomCents: 0,
      shortfallCents: 0,
    },
  },
  {
    id: "C8",
    guards: "Quelljahr VOR dem Anspruchsfenster — nicht bewertbar, nicht 'alles Phantom'",
    beschreibung:
      "Kunde ohne Pflegegrad-Historie: der Anker kommt aus der Übertragszeile 2025, das " +
      "Quelljahr 2024 liegt also komplett vor dem Fenster. Der Anspruch ist dort 0 — daraus " +
      "folgt aber NICHT, dass der Übertrag erfunden ist, sondern dass seine Herkunft aus " +
      "den vorhandenen Daten nicht rekonstruierbar ist. Im eigenen Seed-Lauf meldete der " +
      "Report solche Zeilen mit dem VOLLEN Übertrag als Phantom.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2024,
      pgStartIso: null,
      settings: VOLL,
      allocations: [
        { year: 2025, month: null, amountCents: 100000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
      ],
      transactions: [],
    },
    expected: {
      notEvaluable: true,
      sourceYearEntitlementCents: 0,
      carryoverOutSollCents: 0,
      phantomCents: 0,
      shortfallCents: 0,
    },
  },
  {
    id: "C9",
    guards: "B-3 — Quelljahr HINTER dem Anspruchsfenster ist ebenfalls nicht bewertbar",
    beschreibung:
      "§45b lief nur bis Ende 2023, das Quelljahr 2025 liegt komplett dahinter. Die " +
      "notEvaluable-Pruefung sah bisher nur den ANFANG des Fensters; am hinteren Ende " +
      "lieferte `entitlementForYear` glatt 0 und der volle Uebertrag (1572 EUR) wurde als " +
      "Phantom gemeldet — ohne jede Warnung. Dieselbe Fehlerklasse wie C8, andere Kante.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: [{ validFrom: SETTINGS_VALID_FROM_EPOCH, validTo: "2023-12-31", monthlyLimitCents: null, enabled: true }],
      allocations: [
        { year: 2026, month: null, amountCents: 157200, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [],
    },
    expected: {
      notEvaluable: true,
      sourceYearEntitlementCents: 0,
      carryoverOutSollCents: 0,
      phantomCents: 0,
      shortfallCents: 0,
    },
  },
  {
    id: "C12",
    guards: "BL-2 — Legacy-Konvention `year = sourceYear` darf das Ergebnis nicht aendern",
    beschreibung:
      "Datengleich zu C1, aber beide Uebertragszeilen tragen die Wizard-Konvention vor #601: " +
      "`year` ist das QUELLjahr, das Fenster (validFrom/expiresAt) unveraendert das Zieljahr. " +
      "Der #601-Backfill normalisiert `year` nicht — er behaelt bevorzugt genau diese Zeile. " +
      "Auf Prod tragen 26 Zeilen diese Konvention; eine `year`-basierte Auswertung fand dort " +
      "GAR KEINE Paare mehr und mass damit nichts, statt nichts zu finden. Ueber das Fenster " +
      "geschluesselt muss C12 Zeichen fuer Zeichen dasselbe liefern wie C1.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: VOLL,
      allocations: [
        // year = 2024 statt 2025, Fenster aber unveraendert das Jahr 2025:
        { year: 2024, month: null, amountCents: 100000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
        // year = 2025 statt 2026, Fenster unveraendert 2026:
        { year: 2025, month: null, amountCents: 157200, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [
        { date: "2025-09-15", type: "consumption", amountCents: -80000 },
        { date: "2026-03-01", type: "consumption", amountCents: -200000 },
      ],
    },
    // identisch zu C1
    expected: {
      sourceYearEntitlementCents: 157200,
      carryoverOutSollCents: 77200,
      phantomCents: 80000,
      shortfallCents: 18000,
    },
  },
  {
    id: "C13",
    guards: "BL-2 — Doppel-Uebertraege: Betrag SUMMIEREN, Frist ueber DIESELBE Zeilenmenge",
    beschreibung:
      "Zwei lebende Uebertragszeilen im selben Zielfenster. Der #601-Backfill ueberspringt " +
      "Duplikate mit verlinkten Transaktionen ausdruecklich ('manuelle Aufloesung noetig'), " +
      "sie sind also real. Beide gewaehren Budget, der persistierte Uebertrag ist ihre SUMME. " +
      "Frueher wurde der Betrag summiert, die Frist aber ueber `.find` aus einer ungeordneten " +
      "Menge gezogen — zwei Behandlungen derselben Zeilen.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: VOLL,
      allocations: [
        { year: 2025, month: null, amountCents: 100000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
        { year: 2026, month: null, amountCents: 157200, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
        { year: 2026, month: null, amountCents: 157200, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [{ date: "2025-09-15", type: "consumption", amountCents: -80000 }],
    },
    expected: {
      sourceYearEntitlementCents: 157200,
      carryoverOutSollCents: 77200,
      // persistiert = 157200 + 157200 = 314400 gegen Soll 77200.
      // Wuerde nur EINE Zeile zaehlen, waeren es 80000 — der Fall trennt das.
      phantomCents: 237200,
      shortfallCents: 0,
    },
  },
  {
    id: "C11",
    guards: "BL-1 — manual_adjustment gehoert in den Anspruch (strukturell: alle source != carryover)",
    beschreibung:
      "Datengleich zu C1, plus eine manuelle Budget-Anpassung von 500 EUR in 2025. Der " +
      "Schreibpfad addiert `manual_adjustment` im {year}-Modus mit (allocation-storage.ts:446-466); " +
      "die Komposition listete nur `initial_balance` auf und liess sie fallen. Folge: 500 EUR " +
      "Phantom, die es nicht gibt, plus 180 EUR Fehlbetrag 'davon gestellt' — Storno auf eine " +
      "KORREKTE Rechnung, die einzige Richtung, die der Vertrag als unzulaessig benennt. " +
      "Der persistierte Uebertrag hier ist genau das, was der Schreibpfad korrekt errechnet.",
    input: {
      asOfIso: AS_OF,
      sourceYear: 2025,
      pgStartIso: "2020-01-01",
      settings: VOLL,
      allocations: [
        { year: 2025, month: null, amountCents: 50000, source: "manual_adjustment", validFrom: "2025-04-01", expiresAt: null },
        { year: 2025, month: null, amountCents: 100000, source: "carryover", validFrom: "2025-01-01", expiresAt: "2025-06-30" },
        // 157200 + 50000 - 80000 = 127200 — der korrekte Roll.
        { year: 2026, month: null, amountCents: 127200, source: "carryover", validFrom: "2026-01-01", expiresAt: "2026-06-30" },
      ],
      transactions: [{ date: "2025-09-15", type: "consumption", amountCents: -80000 }],
    },
    expected: {
      sourceYearEntitlementCents: 207200,   // 12 x 13100 + 50000
      carryoverOutSollCents: 127200,
      phantomCents: 0,                      // frueher: 50000
      shortfallCents: 0,
    },
  },
];

// ---------------------------------------------------------------------------
// Split-Fälle: Zuordnung des Fehlbetrags auf gestellte vs. Entwurfs-Rechnungen.
// Eigene Form, weil hier Rechnungs-Zustand statt Anspruch geprüft wird.
// ---------------------------------------------------------------------------

export interface SplitCase {
  id: string;
  guards: string;
  beschreibung: string;
  /**
   * Stichtag der Zuordnung. Zeilen NACH ihm haben den Fehlbetrag nicht
   * verursacht und dürfen ihn nicht tragen (C10).
   */
  cutoffIso: string;
  shortfallCents: number;
  rows: Array<{ id: number; date: string; type: "consumption" | "reversal"; amountCents: number; appointmentId: number | null }>;
  /** Termine, die auf einer GESTELLTEN und AKTIVEN Rechnung liegen. */
  issuedAppointmentIds: number[];
  expected: { gestellt: number; entwurf: number; nichtZugeordnet: number };
}

export const SPLIT_CASES: SplitCase[] = [
  {
    id: "S6",
    guards: "S6 — reversierte Zeilen dürfen den Fehlbetrag nicht aufsaugen",
    beschreibung:
      "2000 € auf einer aktiven, gestellten Rechnung (Februar) plus 1000 € im Mai, " +
      "vollständig reversiert und die Rechnung storniert. Gemessen wurde 'davon gestellt " +
      "0 €, davon Entwurf 180 €': die stornierte Mai-Zeile saugte als jüngste den ganzen " +
      "Fehlbetrag auf, während das echte Geld auf der Februar-Rechnung liegt. Die " +
      "Split-Query zählt brutto, der Fehlbetrag wird netto gerechnet — genau die Naht.",
    cutoffIso: AS_OF,
    shortfallCents: 18000,
    rows: [
      { id: 1, date: "2026-02-10", type: "consumption", amountCents: -200000, appointmentId: 101 },
      { id: 2, date: "2026-05-20", type: "consumption", amountCents: -100000, appointmentId: 102 },
      { id: 3, date: "2026-05-21", type: "reversal", amountCents: 100000, appointmentId: 102 },
    ],
    issuedAppointmentIds: [101],
    expected: { gestellt: 18000, entwurf: 0, nichtZugeordnet: 0 },
  },
  {
    id: "C10",
    guards: "B-1 — die Zuordnung endet am STICHTAG (formale Zuordnungs-Konvention)",
    beschreibung:
      "Der Fehlbetrag wird auf Verbrauch bis zum Stichtag gerechnet; die Zuordnung lief " +
      "aber über die Zeilen des ganzen Zieljahres. Ein VORGEBUCHTER Termin nach dem " +
      "Stichtag ist damit der jüngste Posten und saugt den Fehlbetrag auf, obwohl er ihn " +
      "nicht verursacht hat. Gemessen: 'gestellt 0 / Entwurf 180 €' statt umgekehrt — die " +
      "GoBD-gefährliche Richtung, die derselbe Docblock als unzulässig benennt.\n\n" +
      "Die Konvention lautet damit vollständig: der Fehlbetrag sind die zuletzt " +
      "verbrauchten Cent BIS ZUM STICHTAG, netto pro Termin, Datum absteigend mit " +
      "`id` als Tiebreaker.",
    cutoffIso: AS_OF,
    shortfallCents: 18000,
    rows: [
      // 2000 € am 01.03. auf einer gestellten, aktiven Rechnung.
      { id: 1, date: "2026-03-01", type: "consumption", amountCents: -200000, appointmentId: 201 },
      // Vorgebuchter Termin NACH dem Stichtag — noch keine Rechnung, hat den
      // Fehlbetrag nicht verursacht.
      { id: 2, date: "2026-09-20", type: "consumption", amountCents: -100000, appointmentId: 202 },
    ],
    issuedAppointmentIds: [201],
    expected: { gestellt: 18000, entwurf: 0, nichtZugeordnet: 0 },
  },
];
