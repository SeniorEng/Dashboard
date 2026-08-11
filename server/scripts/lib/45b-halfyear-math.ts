/**
 * Reine Arithmetik der halbjahresscharfen §45b-Übertrags-Gegenrechnung.
 *
 * Gehört zum Einmal-Werkzeug `server/scripts/fix-45b-halfyear-split-dryrun.ts`
 * und wird gemeinsam mit ihm gelöscht (One-off-Disziplin, CLAUDE.md).
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
 * 2. `write_off` gehört in KEINE der beiden Verbrauchssummen. Der
 *    Verfalls-Write-Off liegt per `addDays(expiresAt, 1)` auf dem 01.07., fiel
 *    also in das Jahresfenster, aber nicht in das Fenster „bis Frist" — die
 *    Asymmetrie blähte den Phantom-Betrag um genau den Write-Off-Betrag auf
 *    (gemessen: 25 % zu viel). Fachlich ist er ohnehin kein Verbrauch gegen
 *    den eigenen Jahrestopf, sondern das Verfallen des Übertrags. Beide
 *    Eingaben unten sind deshalb `consumption − reversal`, ohne `write_off`.
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
  /** Netto-Verbrauch (consumption − reversal) bis EINSCHLIESSLICH der Frist. */
  netConsumptionUntilDeadlineCents: number;
  /** Tatsächlich persistierter Übertrag ins Folgejahr (aus der DB). */
  persistedCarryoverOutCents: number;
}

export interface HalfYearResult {
  /** Vom Vorjahres-Übertrag rechtmäßig aufgezehrt (nur Verbrauch bis Frist). */
  absorbedCents: number;
  /** Verbrauch, der den EIGENEN Jahrestopf belastet — halbjahresscharf. */
  consumedOwnSollCents: number;
  /** Übertrag, der ins Folgejahr hätte rollen dürfen. */
  carryoverOutSollCents: number;
  /** Zu viel gerollt = persistiert − soll. Nie negativ. */
  phantomCents: number;
}

/**
 * Berechnet den korrekten Folgejahres-Übertrag und die Abweichung zum
 * tatsächlich persistierten.
 *
 * Kern der Korrektur gegenüber `allocation-storage.ts:1598`: dort gilt
 * `consumedAgainstOwnYear = max(0, netConsumed − totalCarryoverIn)` — der
 * Übertrag absorbiert Verbrauch unabhängig vom Datum. Hier absorbiert er nur,
 * was bis zu seiner Frist verbraucht wurde; alles danach belastet den eigenen
 * Jahrestopf, weil der Übertrag zu diesem Zeitpunkt bereits verfallen war.
 */
export function computeCarryoverPhantom(i: HalfYearInput): HalfYearResult {
  const untilDeadline = Math.min(i.netConsumptionUntilDeadlineCents, i.netConsumptionYearCents);
  const absorbedCents = Math.max(0, Math.min(i.prevCarryInCents, untilDeadline));
  const consumedOwnSollCents = Math.max(0, i.netConsumptionYearCents - absorbedCents);
  const carryoverOutSollCents = Math.max(0, i.sourceYearAllocatedCents - consumedOwnSollCents);
  const phantomCents = Math.max(0, i.persistedCarryoverOutCents - carryoverOutSollCents);
  return { absorbedCents, consumedOwnSollCents, carryoverOutSollCents, phantomCents };
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
// B1 — Quelljahres-Anspruch aus einer ZUSTANDSUNABHÄNGIGEN Quelle.
// ---------------------------------------------------------------------------


export interface SourceYearEntitlementInput {
  sourceYear: number;
  /** ROHER Pflegegrad-Beginn (`getEarliestCareLevelStart`), NICHT gebodet. */
  pgStartIso: string | null;
  /** Monate, die ein aktiver Startwert verdrängt — Schlüssel `"YYYY-M"`. */
  initialBalanceMonthKeys: Set<string>;
  /** Aus `pickEffective45bSettingRow` + `clampToStatutoryMax` komponiert. */
  monthlyAmountFor: (year: number, month: number) => number;
}

/**
 * Summe der §45b-Monatsaufstockungen des Quelljahres.
 *
 * ERSETZT `calculateAllocatedCents(customerId, BT, { year })` für diesen
 * Report. Jener Aufruf liefert die HEUTIGE Sicht: der Carryover-`allocStart`-
 * Shift (`allocation-storage.ts:770-772`) ist im `{year}`-Modus nicht
 * geschützt und springt auf das Zieljahr, sobald dessen Übertragszeile
 * existiert — also genau in der Kandidatenmenge dieses Reports. Ergebnis war 0
 * und damit ein stiller Null-Befund auf allen echten Daten.
 *
 * KEIN Zweitbegriff: die Aufzählung ist `enumerate45bStatutoryMonths` (die
 * SSoT, die auch der Schreibpfad benutzt), und `monthlyAmountFor` wird vom
 * Aufrufer aus den exportierten Bausteinen `pickEffective45bSettingRow` +
 * `clampToStatutoryMax` komponiert. Neu ist AUSSCHLIESSLICH das Fenster:
 * Beginn = roher Pflegegrad-Start statt des auf das laufende Jahr gebodeten
 * Ankers (`floorAutoAnchor45bToCurrentYear`), Ende = Dezember des Quelljahres.
 * Genau dieser Floor ist die Ursache von B1 — für eine Rückschau darf er nicht
 * greifen.
 *
 * Ohne Pflegegrad-Beginn gibt es keinen Anspruch: 0.
 */
export function sourceYearEntitlementCents(i: SourceYearEntitlementInput): number {
  if (!i.pgStartIso) return 0;
  const [pgY, pgM] = i.pgStartIso.split("-").map(Number);
  if (!Number.isInteger(pgY) || !Number.isInteger(pgM)) return 0;
  // Beginnt der Anspruch erst NACH dem Quelljahr, gibt es für dieses nichts.
  if (pgY > i.sourceYear) return 0;

  const months = enumerate45bStatutoryMonths({
    allocStartYear: pgY,
    allocStartMonth: pgM,
    endYear: i.sourceYear,
    endMonth: 12,
    initialBalanceMonthKeys: i.initialBalanceMonthKeys,
    monthlyAmountFor: i.monthlyAmountFor,
  });
  return sum45bStatutoryMonths(months.filter(m => m.year === i.sourceYear));
}
