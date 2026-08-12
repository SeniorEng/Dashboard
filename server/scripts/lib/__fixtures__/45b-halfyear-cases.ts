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

/** Roher Zustand eines Kunden-Jahres, wie er aus der DB käme. */
export interface CaseInput {
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

const VOLL = [{ validFrom: "1970-01-01", validTo: null, monthlyLimitCents: null, enabled: true }];

export const HALFYEAR_CASES: HalfYearCase[] = [
  {
    id: "C1",
    guards: "Basisfall — Verbrauch NACH der Frist zehrt den verfallenen Übertrag nicht auf",
    beschreibung:
      "Übertrag 1000 € (Frist 30.06.2025), 800 € Verbrauch am 15.09.2025. Der Schreibpfad " +
      "rollte den vollen Jahresanspruch 1572 € weiter; korrekt sind 772 €.",
    input: {
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
      // Zieljahr 2026: Anspruch 157200 + korrigierter Übertrag 77200 = 234400
      // gegen 200000 Verbrauch → gedeckt.
      shortfallCents: 0,
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
];

/**
 * NOCH ZU ERGÄNZEN, bevor die Extraktion als fertig gilt:
 *
 * - **B10** — Zieljahres-Verbrauch NACH dem 30.06., also nach Verfall des
 *   korrigierten Übertrags. Gemessen wurden 180 € statt 952 €, weil die
 *   Fehlbetrags-Rechnung den Übertrag als ganzjährig verfügbar behandelt —
 *   derselbe Denkfehler wie im Produktionscode. Erwartung: der Übertrag steht
 *   im Zieljahr nur bis zu SEINER Frist zur Verfügung.
 * - **S6** — `reversal` im gestellt/Entwurf-Split. Gemessen: eine vollständig
 *   reversierte, stornierte Zeile saugte den Fehlbetrag auf, während das echte
 *   Geld auf einer aktiven Altrechnung lag.
 * - **B9-Variante** — Kunde MIT Pflegegrad-Historie, aber ohne aktivierte
 *   §45b-Settings: jeder Produktionspfad liefert 0, das Skript erfand 1572 €.
 */
