/**
 * Reine Arithmetik der halbjahresscharfen §45b-Übertrags-Gegenrechnung.
 *
 * ── Lebensdauer: die Weggabelung ist entschieden ────────────────────────
 * Diese Datei lag unter `server/scripts/lib/` und war an das Einmal-Werkzeug
 * `server/scripts/fix-45b-halfyear-split-dryrun.ts` gebunden — mit der
 * ausdrücklichen Alternative: entweder mit ihm gelöscht, oder VORHER nach
 * `shared/domain/budget/` umgezogen, sobald der Produktions-Fix sie importiert.
 *
 * Der zweite Weg ist eingetreten. `carryoverOutSollFor` speist jetzt die
 * Übertrags-Anlage in `server/storage/budget/allocation-storage.ts`; die Datei
 * ist damit Produktionscode. (`computeCarryoverPhantom` bleibt reine
 * Mess-Sicht — die Produktion kennt keinen Phantom-Begriff.) Ein Produktions-Import aus einem Verzeichnis, das
 * laut One-off-Disziplin zu löschen ist, wäre genau der Zustand, den der
 * frühere Docblock verhindern wollte.
 *
 * Das Dry-Run-Werkzeug importiert weiterhin von hier und bleibt ein Einmal-
 * Werkzeug — es kann gelöscht werden, ohne dass die Formel mitgeht.
 *
 * Bewusst OHNE DB-Import, damit die Formel ohne Datenbank testbar ist —
 * genau das fehlte in der ersten Fassung und ließ zwei Rechenfehler durch,
 * die drei synthetische Fälle sofort gezeigt hätten.
 *
 * ── Zwei Entscheidungen, die hier festgeschrieben sind ───────────────────
 *
 * 1. Der IST-Übertrag wird NICHT nachgerechnet. Er steht persistiert in
 *    `budget_allocations` (geschrieben von `allocation-storage.ts:1603`) und
 *    ist damit die belastbarste verfügbare Zahl. Die erste Fassung leitete ihn
 *    über `calculateAllocatedCents({year})` her — das liefert die HEUTIGE
 *    Sicht, für ein vergangenes Jahr also 0, sobald die Zieljahres-Zeile
 *    existiert. Ergebnis war ein stiller Null-Befund auf allen echten Daten.
 *
 * 2. `write_off` gehört in KEINE Verbrauchssumme. Fachlich ist er kein
 *    Verbrauch gegen den eigenen Jahrestopf, sondern das Verfallen des
 *    Übertrags; rechnerisch würde er doppelt decken, weil er denselben
 *    ungenutzten Rest ausweist, den die Absorption unten schon abzieht. Alle
 *    Summen sind `consumption − reversal`.
 *
 * 3. Die Absorption kommt aus dem LEDGER (`allocation_id`), nicht aus dem
 *    Buchungs-DATUM. Die datumsbasierte Fassung stand hier bis zum Gate-2 des
 *    Halbjahres-PR und war messbar falsch (Doppeldeckung gegen den
 *    Write-Off). Die 30.06.-Frist ist deshalb nicht aufgegeben, sondern dort
 *    durchgesetzt, wo sie hingehört: beim Buchen.
 */
import { enumerate45bStatutoryMonths, sum45bStatutoryMonths } from "@shared/domain/budget/statutory-45b";

export interface HalfYearInput {
  /**
   * Anspruch des QUELLJAHRES (Monatsaufstockungen + Startwert + manuelle
   * Anpassungen), aus einer ZUSTANDSUNABHÄNGIGEN Quelle.
   *
   * ACHTUNG: `calculateAllocatedCents(customerId, BT, { year })` ist NICHT
   * geeignet — der Carryover-`allocStart`-Shift (`allocation-storage.ts:770`)
   * ist im `{year}`-Modus nicht geschützt und liefert 0, sobald die
   * Zieljahres-Übertragszeile existiert.
   */
  sourceYearAllocatedCents: number;
  /** Übertrag, der IN das Quelljahr rollte (verfällt zu dessen Frist). */
  prevCarryInCents: number;
  /** Netto-Verbrauch (consumption − reversal) im GANZEN Quelljahr. */
  netConsumptionYearCents: number;
  /**
   * Was der hereingerollte Übertrag laut LEDGER getragen hat: Netto-Verbrauch
   * (`consumption − reversal`, ohne `write_off`) der Buchungen, die auf seine
   * `allocation_id` zeigen.
   *
   * ── ERSETZT `netConsumptionUntilDeadlineCents` (datumsbasiert) ──────────
   * Die frühere Fassung leitete die Absorption aus dem Buchungs-DATUM ab
   * („alles bis zum 30.06."). Gemessen führte das zur Doppeldeckung: der
   * Verfalls-`write_off` bestimmt den ungenutzten Rest über die VERLINKUNG
   * (`amountCents − net(Verbrauch mit dieser allocation_id)`), und wo Datum und
   * Verlinkung auseinanderliefen, galten dieselben Cent zweimal als gedeckt —
   * mit dem Übertrag zu hoch als Ergebnis (permissive Richtung).
   *
   * Die 30.06.-Frist ist damit nicht aufgegeben, sondern an ihrer richtigen
   * Stelle durchgesetzt: `computeFifoAvailability` nimmt eine Übertrags-
   * Allocation nur in die FIFO-Kette auf, solange `expiresAt >= transactionDate`.
   * Eine Buchung nach der Frist kann per Konstruktion nicht auf sie zeigen. Der
   * Buchungssatz IST die Frist-Entscheidung; sie hinterher aus Daten neu
   * abzuleiten war ein Zweitbegriff derselben Frage.
   */
  absorbedByCarryInCents: number;
  /** Tatsächlich persistierter Übertrag ins Folgejahr (aus der DB). */
  persistedCarryoverOutCents: number;
}

export interface HalfYearResult {
  /** Vom Vorjahres-Übertrag rechtmäßig aufgezehrt. */
  absorbedCents: number;
  /** Verbrauch, der den EIGENEN Jahrestopf belastet. */
  consumedOwnSollCents: number;
  /** Übertrag, der ins Folgejahr hätte rollen dürfen. */
  carryoverOutSollCents: number;
  /** Zu viel gerollt = persistiert − soll. Nie negativ. */
  phantomCents: number;
}

export interface CarryoverOutInput {
  sourceYearAllocatedCents: number;
  netConsumptionYearCents: number;
  absorbedByCarryInCents: number;
}

/**
 * **Wie hoch ist der Übertrag ins Folgejahr?** — die eine Fassung.
 *
 * ZWEI Aufrufer, bewusst dieselbe Funktion: die Übertrags-Anlage
 * (`ensureYearlyCarryover45b`) und das Mess-Werkzeug über
 * `computeCarryoverPhantom` unten. Vorher rechneten beide Seiten dasselbe
 * getrennt — der Schreibpfad jahresscharf, das Werkzeug halbjahresscharf — und
 * genau diese Drift ist der Grund, warum ein Phantom-Betrag überhaupt
 * entstehen konnte. Wer hier etwas ändert, bewegt Messung und Produktion
 * zusammen; das ist der Punkt.
 *
 * `absorbedByCarryInCents` kommt aus dem Ledger (siehe dort), nicht aus einer
 * Datumsregel.
 */
export function carryoverOutSollFor(i: CarryoverOutInput): number {
  const absorbed = Math.max(0, Math.min(i.absorbedByCarryInCents, i.netConsumptionYearCents));
  const consumedOwn = Math.max(0, i.netConsumptionYearCents - absorbed);
  return Math.max(0, i.sourceYearAllocatedCents - consumedOwn);
}

/**
 * Der korrekte Folgejahres-Übertrag UND die Abweichung zum tatsächlich
 * persistierten. Reine Mess-Sicht — die Produktion braucht nur
 * `carryoverOutSollFor` und ruft diese Funktion NICHT.
 */
export function computeCarryoverPhantom(i: HalfYearInput): HalfYearResult {
  const absorbedCents = Math.max(0, Math.min(i.prevCarryInCents, i.absorbedByCarryInCents, i.netConsumptionYearCents));
  const carryoverOutSollCents = carryoverOutSollFor({
    sourceYearAllocatedCents: i.sourceYearAllocatedCents,
    netConsumptionYearCents: i.netConsumptionYearCents,
    absorbedByCarryInCents: absorbedCents,
  });
  return {
    absorbedCents,
    consumedOwnSollCents: Math.max(0, i.netConsumptionYearCents - absorbedCents),
    carryoverOutSollCents,
    phantomCents: Math.max(0, i.persistedCarryoverOutCents - carryoverOutSollCents),
  };
}

export interface ShortfallInput {
  /** Netto-Verbrauch (consumption − reversal) des ZIELJAHRES, ohne write_off. */
  claimedCents: number;
  /** Eigener Jahresanspruch des Zieljahres — gleiches Zeitfenster wie oben. */
  targetYearAllocatedCents: number;
  /** Korrigierter Übertrag ins Zieljahr (= `carryoverOutSollCents`). */
  carryoverInSollCents: number;
}

/**
 * Fehlbetrag = geltend gemachtes §45b über dem, was mit korrektem Übertrag
 * verfügbar gewesen wäre.
 *
 * Beide Eingaben MÜSSEN dasselbe Zeitfenster abdecken. Die erste Fassung
 * verglich Anspruch bis HEUTE gegen Verbrauch bis 31.12. — jede Buchung nach
 * heute fiel dadurch ungedeckt in den Fehlbetrag.
 */
export function computeShortfall(i: ShortfallInput): { availableCents: number; shortfallCents: number } {
  const availableCents = Math.max(0, i.targetYearAllocatedCents + i.carryoverInSollCents);
  return { availableCents, shortfallCents: Math.max(0, i.claimedCents - availableCents) };
}

// ---------------------------------------------------------------------------
// KOMPOSITION — die eine Funktion, die Dry-Run und Produktions-Fix teilen.
// Setzt ausschliesslich exportierte Produktionsteile zusammen; sie baut nichts
// nach. Rein und DB-frei: der Aufrufer liefert den rohen Zustand.
// ---------------------------------------------------------------------------

import {
  resolve45bAnchor, initialBalanceMonthKeys, pickEffective45bSettingRow,
  effective45bSettingsWindow, shiftStartToSettings, clampEndToSettings,
} from "@shared/domain/budget/anchor-45b";
import { clampToStatutoryMax, BUDGET_45B_MAX_MONTHLY_CENTS } from "@shared/domain/budgets";
import { carryoverWindowFor } from "@shared/domain/budget-carryover-dedup";
import type { CustomerBudgetTypeSetting } from "@shared/schema";
import { BUDGET_ALLOCATION_SOURCES } from "@shared/schema/budget";

export interface TxRow {
  date: string;
  type: "consumption" | "reversal" | "write_off";
  amountCents: number;
  /**
   * Gegen welche Allocation wurde gebucht? `null` = das Monatsaufstockungs-Leg
   * (die FIFO-Buchung schreibt genau EINE solche Zeile pro Vorgang).
   *
   * Trägt seit der Ledger-Umstellung die Absorptions-Frage: was der Übertrag
   * getragen hat, steht hier und wird nicht mehr aus dem Datum abgeleitet.
   */
  allocationId: number | null;
}
export interface AllocRow { id: number; year: number; month: number | null; amountCents: number; source: string; validFrom: string; expiresAt: string | null }
export interface SettingRow { validFrom: string; validTo: string | null; monthlyLimitCents: number | null; enabled: boolean }

/**
 * Netto-VERBRAUCH aus rohen Transaktionszeilen: `consumption − reversal`.
 *
 * DIE NAHT, an der B2/B3 sassen. `write_off` wird hier ausgeschlossen — und
 * zwar an der Stelle, an der die Zahlen ENTSTEHEN, nicht erst dort, wo sie
 * verrechnet werden. Die frueheren Golden-Cases reichten der Arithmetik
 * bereits bereinigte Summen hinein und konnten den Fehler deshalb nie fangen.
 *
 * Fachlich: der Verfalls-Write-Off liegt per `addDays(expiresAt, 1)` auf dem
 * 01.07. Er fiele damit in ein Jahresfenster, aber nicht in ein Fenster „bis
 * Frist" — die Asymmetrie blaehte den Phantom-Betrag um genau ihn auf. Und er
 * ist ohnehin kein Verbrauch gegen den eigenen Topf, sondern das Verfallen des
 * Uebertrags.
 */
export function netConsumptionFromRows(rows: ReadonlyArray<TxRow>, fromIso: string, toIso: string): number {
  let netto = 0;
  for (const r of rows) {
    if (r.date < fromIso || r.date > toIso) continue;
    if (r.type === "consumption") netto += Math.abs(r.amountCents);
    else if (r.type === "reversal") netto -= Math.abs(r.amountCents);
    // write_off: bewusst ignoriert (siehe Docblock)
  }
  return Math.max(0, netto);
}

/**
 * Netto-Verbrauch, der auf eine bestimmte Allocation-Menge gebucht wurde —
 * die LEDGER-Antwort auf „was hat dieser Übertrag getragen?".
 *
 * Kein Datumsfenster: die 30.06.-Frist steckt bereits in der Verlinkung, weil
 * `computeFifoAvailability` eine Übertrags-Allocation nur aufnimmt, solange
 * `expiresAt >= transactionDate` der Buchung. `write_off` bleibt draußen (es
 * ist der Verfall, nicht der Verbrauch).
 */
export function netConsumptionForAllocations(
  rows: ReadonlyArray<TxRow>,
  allocationIds: ReadonlySet<number>,
): number {
  let netto = 0;
  for (const r of rows) {
    if (r.allocationId == null || !allocationIds.has(r.allocationId)) continue;
    if (r.type === "consumption") netto += Math.abs(r.amountCents);
    else if (r.type === "reversal") netto -= Math.abs(r.amountCents);
  }
  return Math.max(0, netto);
}

export interface HalfYearEvalInput {
  /** Bewertungs-Stichtag. Anspruch UND Verbrauch werden hierauf gekappt. */
  asOfIso: string;
  sourceYear: number;
  pgStartIso: string | null;
  settings: ReadonlyArray<SettingRow>;
  allocations: ReadonlyArray<AllocRow>;
  transactions: ReadonlyArray<TxRow>;
  /**
   * Wie der Uebertrag seinem Zieljahr zugeordnet wird. PFLICHT, kein Default:
   *  - `"year"`   = wie die Produktion (`allocation-storage.ts:1569`,
   *                 `carryoverAllocations.filter(a => a.year === year)`)
   *  - `"window"` = ueber `valid_from`, konventionsunabhaengig
   * Bei den 26 Legacy-Zeilen (`year = sourceYear`) fallen beide auseinander.
   */
  carryoverKeying: CarryoverKeying;
}

export interface HalfYearEvalResult {
  ineligible?: boolean;
  /**
   * Das Quelljahr liegt vollständig VOR dem Anspruchsfenster — der Übertrag
   * stammt aus einer Zeit, die sich aus den vorhandenen Daten nicht
   * rekonstruieren lässt. Dann ist der Anspruch 0, aber daraus folgt NICHT,
   * dass der ganze Übertrag Phantom ist. Diese Zeilen werden ausgewiesen,
   * nicht bewertet — sonst meldete der Report jeden solchen Übertrag als
   * vollständig erfunden.
   */
  notEvaluable?: boolean;
  sourceYearEntitlementCents: number;
  carryoverOutSollCents: number;
  phantomCents: number;
  shortfallCents: number;

  // ── Zwischenwerte: der Fehlbetrag muss PRUEFBAR sein ────────────────────
  //
  // `shortfallCents` allein ist eine Behauptung. Aus ihm kann eine Kuerzung
  // eines noch nicht gestellten Rechnungsentwurfs folgen — und beim ersten
  // echten Fall (Kunde 54, 211,95 EUR) liess sich die Zahl aus den Rohdaten
  // NICHT nachvollziehen: die Nachrechnung kam auf 429,90 EUR, also den
  // doppelten Betrag, und die Differenz blieb unerklaert. Nachbauen ist kein
  // Pruefen; wer nachbaut, kann denselben Fehler ein zweites Mal machen.
  //
  // Diese fuenf Felder sind die Eingaben der Formel
  // (`shortfall = max(0, claimed - available)`,
  //  `available = targetYearEntitlement + carryoverInSoll`). Sie werden hier
  // nur DURCHGEREICHT — die Rechnung selbst bleibt unveraendert.

  /** Netto-Verbrauch des ZIELjahres bis zum Stichtag (ohne `write_off`). */
  claimedCents: number;
  /** Eigener Anspruch des Zieljahres, auf denselben Stichtag gekappt. */
  targetYearEntitlementCents: number;
  /** Was der Uebertrag laut Ledger im Zieljahr getragen hat — vor dem Deckel. */
  absorbedInTargetCents: number;
  /** Angerechneter Uebertrag = `min(carryoverOutSoll, absorbedInTarget)`. */
  carryoverInSollCents: number;
  /** `targetYearEntitlement + carryoverInSoll`. */
  availableCents: number;
}

function ymOf(iso: string): { year: number; month: number } {
  const [y, m] = iso.split("-").map(Number);
  return { year: y, month: m };
}

/**
 * Anspruch eines Jahres = Monatsaufstockungen (im gedeckten Fenster) PLUS die
 * Startwerte dieses Jahres. Der zweite Summand fehlte und war B7: der
 * Schreibpfad rechnet `yearMonthlyTotal + sumInitialBalancesForYear`.
 */
/**
 * Anspruch eines Jahres = Monatsaufstockungen im gedeckten Fenster PLUS die
 * Startwerte dieses Jahres.
 *
 * ERSETZT den frueheren Export `sourceYearEntitlementCents`. Der war der
 * Vor-B7/B8-Stand: ohne `initial_balance`-Summand und ohne Settings-Fenster —
 * exportiert, testgruen und trotzdem falsch. Wer ihn wiederverwendet haette,
 * haette sich zwei bereits geschlossene Blocker zurueckgeholt.
 */
export function entitlementForYear(
  i: HalfYearEvalInput, jahr: number, anchorIso: string, endYm: { year: number; month: number },
): number {
  const window = effective45bSettingsWindow(i.settings, null);
  const start = shiftStartToSettings(ymOf(anchorIso), window.validFrom);
  const end = clampEndToSettings(endYm, window.validTo);
  if (end.year < start.year || (end.year === start.year && end.month < start.month)) return 0;

  const rows = i.settings as unknown as CustomerBudgetTypeSetting[];
  const monthlyAmountFor = (y: number, m: number): number => {
    const row = pickEffective45bSettingRow(rows, y, m);
    if (!row || row.monthlyLimitCents == null) return BUDGET_45B_MAX_MONTHLY_CENTS;
    return clampToStatutoryMax({
      budgetType: "entlastungsbetrag_45b", monthlyLimitCents: row.monthlyLimitCents,
      yearlyLimitCents: null, pflegegrad: null,
    }).monthlyLimitCents ?? BUDGET_45B_MAX_MONTHLY_CENTS;
  };

  const monatlich = sum45bStatutoryMonths(
    enumerate45bStatutoryMonths({
      allocStartYear: start.year, allocStartMonth: start.month,
      endYear: end.year, endMonth: end.month,
      initialBalanceMonthKeys: initialBalanceMonthKeys(i.allocations),
      monthlyAmountFor,
    }).filter(m => m.year === jahr),
  );
  // POSITIV aus dem Enum abgeleitet, nicht als Negation von `carryover`.
  //
  // Die fruehere Blacklist (`source !== "carryover"`) war strukturell falsch
  // herum: sie zog auch Quellen mit, die GAR NICHT im Enum stehen — allen
  // voran die zurueckgezogene Altlast-Quelle, von der laut Prod-Report noch
  // 470 aktive §45b-Zeilen bei 89 Kunden existieren. Deren Betraege wanderten
  // in den Anspruch, wodurch der Soll-Uebertrag zu hoch und das Phantom zu
  // NIEDRIG wurde, haeufig auf 0 — genau die Kunden mit der laengsten
  // Altlast-Historie fielen still aus dem Report.
  //
  // Der Schreibpfad zaehlt im {year}-Modus exakt `initial_balance` und
  // `manual_adjustment`. Die Ableitung aus dem Enum trifft das, bleibt aber
  // strukturell: eine kuenftige vierte LEGITIME Quelle faellt automatisch
  // hinein, eine Altlast-Quelle per Definition nicht.
  // Der Schreibpfad addiert im {year}-Modus `initial_balance` UND
  // `manual_adjustment`; das Auflisten einzelner Quellen liess letztere fallen
  // und meldete 500 EUR Phantom, die es nicht gab — samt Fehlbetrag "davon
  // gestellt", also Storno auf eine korrekte Rechnung. Eine kuenftige vierte
  // Quelle faellt hier nicht mehr durch.
  //
  // `carryover` ist ausgenommen, weil der Uebertrag nicht Teil des EIGENEN
  // Jahresanspruchs ist, sondern der Zufluss aus dem Vorjahr — er wird
  // getrennt behandelt (`carryoverIn`).
  const anspruchsQuellen = new Set<string>(
    BUDGET_ALLOCATION_SOURCES.filter(q => q !== "carryover"),
  );
  const weitereQuellen = i.allocations
    .filter(a => anspruchsQuellen.has(a.source) && a.year === jahr)
    .reduce((s, a) => s + a.amountCents, 0);
  return monatlich + weitereQuellen;
}

/** Kleineres der beiden ISO-Daten. */
function minIso(a: string, b: string): string { return a < b ? a : b; }

/**
 * Das Jahr, in das eine Übertragszeile rollte — abgeleitet aus dem FENSTER,
 * nicht aus der Spalte `year`.
 *
 * `year` trägt zwei Konventionen nebeneinander: der Auto-Pfad schreibt das
 * ZIELjahr, der Wizard-Pfad vor #601 das QUELLjahr, und der #601-Backfill
 * normalisiert `year` nicht (er dedupliziert über das Fenster und behält
 * bevorzugt die Wizard-Zeile). Auf Prod sind 26 Zeilen betroffen — eine
 * Auswertung über `year` fand dort GAR KEINE Paare mehr und maß damit nichts,
 * statt nichts zu finden.
 *
 * `validFrom` trägt dagegen immer den 01.01. des Zieljahres, unabhängig von
 * der Konvention. Es ist derselbe drift-sichere Schlüssel, den auch die
 * Dedup-SSoT (`shared/domain/budget-carryover-dedup.ts`) benennt.
 */
export type CarryoverKeying = "window" | "year";

export function carryoverTargetYear(a: AllocRow, modus: CarryoverKeying): number {
  // KEIN Default. Die beiden Modelle laufen bei den Legacy-Zeilen auseinander,
  // und welches dem Produktions-Roll entspricht, ist offen — ein Default waere
  // eine stille Antwort auf eine ungeklaerte Frage.
  return modus === "window" ? Number(a.validFrom.slice(0, 4)) : a.year;
}

/**
 * Die gemeinsame Bewertung eines Kunden-Quelljahres.
 *
 * Der Halbjahres-Split greift ZWEIMAL, und das ist der Kern:
 *  - im QUELLJAHR entscheidet er, wieviel der hereingerollte Uebertrag
 *    rechtmaessig absorbieren durfte (nur Verbrauch bis zu seiner Frist),
 *  - im ZIELJAHR entscheidet er, ob der korrigierte Uebertrag ueberhaupt noch
 *    zur Verfuegung stand. Er ist NICHT ganzjaehrig verfuegbar (B10): ein
 *    Verbrauch nach dem 30.06. kann ihn nicht mehr aufzehren.
 */
export function evaluate45bHalfYear(i: HalfYearEvalInput): HalfYearEvalResult {
  const leer = {
    sourceYearEntitlementCents: 0, carryoverOutSollCents: 0, phantomCents: 0, shortfallCents: 0,
    claimedCents: 0, targetYearEntitlementCents: 0, absorbedInTargetCents: 0,
    carryoverInSollCents: 0, availableCents: 0,
  };
  const s45bEnabled = i.settings.some(s => s.enabled);

  const anchor = resolve45bAnchor({
    pgStartIso: i.pgStartIso,
    s45bEnabled,
    activeAllocations: i.allocations,
    deletedInitialBalanceValidFroms: [],
    fallbackYear: i.sourceYear,
    // Rueckschau: KEIN Erden auf das laufende Jahr (das war B1).
    floorPgAnchor: (iso) => iso,
  });
  if (anchor.kind === "ineligible") return { ineligible: true, ...leer };

  // Deckt das Anspruchsfenster das Quelljahr überhaupt ab?
  const fenster = effective45bSettingsWindow(i.settings, null);
  const startYm = shiftStartToSettings(ymOf(anchor.anchorIso), fenster.validFrom);
  const endYmSource = clampEndToSettings({ year: i.sourceYear, month: 12 }, fenster.validTo);
  // BEIDE Kanten pruefen. Nur den Anfang zu pruefen liess das Quelljahr HINTER
  // dem Fenster durchrutschen: `entitlementForYear` lieferte dort glatt 0 und
  // der volle Uebertrag wurde als Phantom gemeldet (B-3).
  if (startYm.year > i.sourceYear || endYmSource.year < i.sourceYear) {
    return { notEvaluable: true, ...leer };
  }

  const targetYear = i.sourceYear + 1;
  // Betrag UND Frist über DIESELBE Zeilenmenge — sonst summiert die eine
  // Seite Zeilen, die die andere nicht sieht.
  const uebertragsZeilen = (jahr: number) =>
    i.allocations.filter(a => a.source === "carryover" && carryoverTargetYear(a, i.carryoverKeying) === jahr);
  const carryoverIn = (jahr: number) =>
    uebertragsZeilen(jahr).reduce((s, a) => s + a.amountCents, 0);
  /**
   * Die Frist des Uebertrags, der in `jahr` hereinrollte.
   *
   * DETERMINISTISCHES MINIMUM ueber die Nicht-NULL-Fristen, nicht `.find`.
   * Die Query liefert ohne `orderBy` keine garantierte Reihenfolge, und
   * Doppel-Uebertraege sind real (Task #101/#102; Altbestand zurueckgebaut,
   * Protokoll `docs/corrections/2026-08-23_duplikate-45b-carryover-startwert.md`).
   * Mit `.find` kippte derselbe Datenstand je nach Zeilenreihenfolge
   * zwischen 800 EUR Phantom und 0 EUR.
   *
   * Warum das MINIMUM: mehrere Zeilen bedeuten mehrere Fristen; die frueheste
   * ist die konservative Wahl, weil sie am wenigsten Verbrauch absorbieren
   * laesst und den Phantom-Betrag damit nicht kuenstlich klein rechnet.
   */
  const fristFuer = (jahr: number) => {
    const fristen = uebertragsZeilen(jahr)
      .filter(a => a.expiresAt)
      .map(a => a.expiresAt!)
      .sort();
    return fristen[0] ?? carryoverWindowFor(jahr - 1).expiresAt;
  };

  // ── Quelljahr ──────────────────────────────────────────────────────────
  const sourceYearEntitlementCents = entitlementForYear(
    i, i.sourceYear, anchor.anchorIso, { year: i.sourceYear, month: 12 },
  );
  // Absorption aus dem LEDGER: was auf die Übertragszeilen des Quelljahres
  // gebucht wurde. Ersetzt das frühere Datumsfenster `[01.01. … Frist]`.
  const ph = computeCarryoverPhantom({
    sourceYearAllocatedCents: sourceYearEntitlementCents,
    prevCarryInCents: carryoverIn(i.sourceYear),
    netConsumptionYearCents: netConsumptionFromRows(i.transactions, `${i.sourceYear}-01-01`, `${i.sourceYear}-12-31`),
    absorbedByCarryInCents: netConsumptionForAllocations(
      i.transactions,
      new Set(uebertragsZeilen(i.sourceYear).map(a => a.id)),
    ),
    persistedCarryoverOutCents: carryoverIn(targetYear),
  });

  // ── Zieljahr ───────────────────────────────────────────────────────────
  // Anspruch und Verbrauch teilen dasselbe Fenster (bis Stichtag) — die
  // Asymmetrie war B4.
  const asOf = ymOf(i.asOfIso);
  const endYm = asOf.year > targetYear ? { year: targetYear, month: 12 } : { year: targetYear, month: asOf.month };
  const targetEntitlement = entitlementForYear(i, targetYear, anchor.anchorIso, endYm);
  const fensterEnde = minIso(`${targetYear}-12-31`, i.asOfIso);
  const claimed = netConsumptionFromRows(i.transactions, `${targetYear}-01-01`, fensterEnde);
  // Auch hier Ledger statt Datum: was haben die Zieljahres-Übertragszeilen
  // getragen? Gedeckelt auf den KORRIGIERTEN Übertrag — mehr als der hätte
  // rollen dürfen, kann nicht absorbiert worden sein.
  const absorbedInTarget = netConsumptionForAllocations(
    i.transactions,
    new Set(uebertragsZeilen(targetYear).map(a => a.id)),
  );
  const absorbed = Math.min(ph.carryoverOutSollCents, absorbedInTarget);
  const sf = computeShortfall({
    claimedCents: claimed,
    targetYearAllocatedCents: targetEntitlement,
    carryoverInSollCents: absorbed,
  });

  return {
    sourceYearEntitlementCents,
    carryoverOutSollCents: ph.carryoverOutSollCents,
    phantomCents: ph.phantomCents,
    shortfallCents: sf.shortfallCents,
    claimedCents: claimed,
    targetYearEntitlementCents: targetEntitlement,
    absorbedInTargetCents: absorbedInTarget,
    carryoverInSollCents: absorbed,
    availableCents: sf.availableCents,
  };
}

export interface SplitRow {
  id: number;
  date: string;
  type: "consumption" | "reversal";
  amountCents: number;
  appointmentId: number | null;
}

/**
 * Verteilt den Fehlbetrag auf gestellte vs. Entwurfs-Rechnungen.
 *
 * NETTO pro Termin, nicht brutto pro Zeile — das war S6. Eine vollstaendig
 * reversierte Buchung hat kein Geld bewegt und darf den Fehlbetrag nicht
 * aufsaugen; sonst wandert er von einer aktiven, gestellten Rechnung auf eine
 * stornierte und wird als „nach vorn korrigierbar" ausgewiesen. Das ist die
 * GoBD-gefaehrliche Richtung.
 *
 * Zuordnungs-Konvention: der Fehlbetrag sind die ZULETZT verbrauchten Cent.
 * Wir laufen die Netto-Posten rueckwaerts nach Datum, `id` als Tiebreaker
 * (mehrere Buchungen am selben Tag sind der Normalfall — ohne ihn koennen zwei
 * Laeufe verschieden aufteilen). Eine andere Konvention (anteilig, FIFO
 * vorwaerts) ergaebe dieselbe Summe, aber eine andere Aufteilung; das gehoert
 * fachlich bestaetigt, bevor daraus Stornos abgeleitet werden.
 *
 * Zeilen NACH `cutoffIso` sind ausgeschlossen (siehe unten).\n *\n * Ohne `appointmentId` ist keine Rechnung auffindbar — konservativ als
 * „gestellt" gewertet: lieber ein GoBD-Vorgang zu viel geprueft als eine
 * gestellte Rechnung still korrigiert.
 */
export function splitShortfall(
  rows: ReadonlyArray<SplitRow>,
  shortfallCents: number,
  issuedAppointmentIds: ReadonlySet<number>,
  cutoffIso: string,
): { gestellt: number; entwurf: number; nichtZugeordnet: number } {
  if (shortfallCents <= 0) return { gestellt: 0, entwurf: 0, nichtZugeordnet: 0 };
  // Der Stichtag gehoert IN diese Funktion, nicht in den Aufrufer: der
  // Fehlbetrag wird auf Verbrauch bis zum Stichtag gerechnet, also darf auch
  // nur solcher Verbrauch ihn tragen. Ein vorgebuchter Termin danach war
  // sonst der juengste Posten und saugte ihn auf (B-1) — mit dem Ergebnis,
  // dass eine gestellte Rechnung als "Entwurf, nach vorn korrigierbar" galt.
  rows = rows.filter(r => r.date <= cutoffIso);

  // Netting: Zeilen mit Termin werden pro Termin verrechnet, terminlose je Zeile.
  const posten = new Map<string, { netto: number; date: string; id: number; appointmentId: number | null }>();
  for (const r of rows) {
    const key = r.appointmentId != null ? `a${r.appointmentId}` : `r${r.id}`;
    const vorz = r.type === "consumption" ? 1 : -1;
    const cur = posten.get(key);
    if (cur) {
      cur.netto += vorz * Math.abs(r.amountCents);
      if (r.date > cur.date || (r.date === cur.date && r.id > cur.id)) { cur.date = r.date; cur.id = r.id; }
    } else {
      posten.set(key, { netto: vorz * Math.abs(r.amountCents), date: r.date, id: r.id, appointmentId: r.appointmentId });
    }
  }

  const sortiert = [...posten.values()]
    .filter(p => p.netto > 0)
    .sort((a, b) => (a.date === b.date ? b.id - a.id : (a.date < b.date ? 1 : -1)));

  let rest = shortfallCents;
  let gestellt = 0;
  let entwurf = 0;
  for (const p of sortiert) {
    if (rest <= 0) break;
    const nimm = Math.min(rest, p.netto);
    if (p.appointmentId == null || issuedAppointmentIds.has(p.appointmentId)) gestellt += nimm;
    else entwurf += nimm;
    rest -= nimm;
  }
  return { gestellt, entwurf, nichtZugeordnet: Math.max(0, rest) };
}
