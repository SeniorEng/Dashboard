import type { CustomerBudgetTypeSetting } from "../../schema";
import { lastDayOfMonth } from "../../utils/datetime";

/**
 * SSoT für die §45b-Anspruchs-Auflösung: „ab wann läuft der Anspruch?" —
 * die Anker-Fallback-Kette, die bisher nur intern in `calculateAllocated45b`
 * (`server/storage/budget/allocation-storage.ts`) existierte.
 *
 * HERAUSGELÖST, NICHT NACHGEBAUT: der LESEPFAD (`calculateAllocated45b`) ruft
 * dieselbe Funktion, es gibt dort keine zweite Fassung mehr. Damit können
 * Lese-Werkzeuge (§45b-Übertrags-Diagnose, kommender Produktions-Fix) den Anker
 * beziehen, ohne die Reihenfolge erneut zu kodieren — genau die Divergenz, an
 * der eine frühere Fassung des Diagnose-Skripts scheiterte.
 *
 * ── Beide Pfade rufen diese Kette ────────────────────────────────────────
 * Lesepfad (`calculateAllocated45b`) und SCHREIBpfad
 * (`ensureYearlyCarryover45b`), beide in
 * `server/storage/budget/allocation-storage.ts`. Der Schreibpfad trug die Frage
 * bis zur Anker-Konsolidierung ein zweites Mal, inline, mit drei Abweichungen
 * (`todayISO()`-Gate auf der Aktivierung, fehlende Stufe 4, `validFrom` der
 * heute-aktiven statt der frühesten Phase). Diese zweite Kette ist ENTFERNT.
 *
 * Eine dritte Kopie darf nicht entstehen — deshalb der Registry-Eintrag
 * `budget-anchor` in `shared/ssot-registry.ts`.
 *
 * Rein und DB-frei: alle Zeilen kommen als Parameter herein, damit die Kette
 * ohne Datenbank testbar ist.
 *
 * ── Warum `floorPgAnchor` ein Parameter ist ──────────────────────────────
 * Der aus der Pflegegrad-Historie abgeleitete Anker wird im Produktionspfad
 * auf den 1.1. des LAUFENDEN Jahres gebodet (`floorAutoAnchor45bToCurrentYear`,
 * Task #860/#1204: das Vorjahr gilt als aufgebraucht, es wird kein
 * automatischer Vorjahres-Übertrag fabriziert).
 *
 * Für eine RÜCKSCHAU auf ein vergangenes Jahr ist genau dieser Floor falsch —
 * er erdet den Anker auf „heute" und lässt den historischen Anspruch auf 0
 * kollabieren. Statt die Kette dafür zu duplizieren, ist das Erden ein
 * Parameter: der Produktionspfad übergibt sein bisheriges Verhalten
 * unverändert, ein rückschauendes Werkzeug übergibt die Identität.
 */

/**
 * Task #911 — Phasen-bewusste Auswahl der für einen Monat wirksamen §45b-
 * `customer_budget_type_settings`-Zeile. SSoT für die Monats-Aufstockung
 * (`monthlyAmountFor` unten) UND für die in der Overview/Summary angezeigte
 * `monthlyLimitCents` (`getBudgetSummary`). Vorher leitete die Anzeige den
 * Limit-Wert aus einer einzigen `forDate(heute)`-Zeile ab, während die
 * Allocation über ALLE Phasen iterierte — eine erst im Folge-Append wirksame
 * Phase (z.B. `validFrom = morgen`, aber bis Monatsende in Kraft) reduzierte
 * den Topf korrekt, die UI zeigte aber `null`.
 *
 * Auswahl analog `monthlyAmountFor`: gegen das **Monatsende** geprüft (eine im
 * laufenden Monat ab Tag > 15 wirksame Phase matcht trotzdem), die Zeile mit
 * dem spätesten `validFrom`, deren Fenster den Monat berührt, gewinnt. `rows`
 * darf in beliebiger Reihenfolge übergeben werden.
 */
export function pickEffective45bSettingRow(
  rows: CustomerBudgetTypeSetting[],
  year: number,
  month: number,
): CustomerBudgetTypeSetting | undefined {
  if (rows.length === 0) return undefined;
  const monthEnd = lastDayOfMonth(year, month);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const sorted = [...rows].sort((a, b) => {
    const av = a.validFrom ?? "";
    const bv = b.validFrom ?? "";
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    const startsByMonthEnd = r.validFrom == null || r.validFrom <= monthEnd;
    const endsAfterMonthStart = r.validTo == null || r.validTo >= monthStart;
    if (startsByMonthEnd && endsAfterMonthStart) return r;
  }
  return undefined;
}

export interface AnchorAllocationRow {
  source: string;
  validFrom: string | null;
}

export interface Resolve45bAnchorInput {
  /** Frühester Pflegegrad-Beginn, oder `null` ohne Historie. */
  pgStartIso: string | null;
  /** Ist §45b in mindestens einer Phase aktiviert? (datumsunabhängig geprüft) */
  s45bEnabled: boolean;
  /** AKTIVE (nicht soft-gelöschte) §45b-Allocations des Kunden. */
  activeAllocations: ReadonlyArray<AnchorAllocationRow>;
  /** `validFrom` aller SOFT-GELÖSCHTEN `initial_balance`-Zeilen. */
  deletedInitialBalanceValidFroms: ReadonlyArray<string>;
  /** Jahr für den letzten Fallback (`${jahr}-01-01`). */
  fallbackYear: number;
  /**
   * Erdung des Pflegegrad-Ankers. Produktionspfad:
   * `iso => floorAutoAnchor45bToCurrentYear(iso, curYear)`.
   * Rückschau: `iso => iso`.
   */
  floorPgAnchor: (pgStartIso: string) => string;
}

export type Resolve45bAnchorResult =
  /** Kein §45b-Anspruch — Eligibility-Gate (Task #724). */
  | { kind: "ineligible" }
  | { kind: "anchor"; anchorIso: string; via: "pflegegrad" | "initial_balance" | "carryover" | "deleted_initial_balance" | "jahresanfang" };

/** Früheste nicht-leere `validFrom` aus einer Zeilenmenge. */
function earliestValidFrom(rows: ReadonlyArray<AnchorAllocationRow>, source: string): string | null {
  const withVf = rows.filter(a => a.source === source && a.validFrom);
  if (withVf.length === 0) return null;
  return withVf.reduce((min, a) => (a.validFrom! < min.validFrom! ? a : min)).validFrom!;
}

/**
 * Die Anker-Kette in ihrer Produktions-Reihenfolge. Jede Stufe greift nur,
 * wenn die vorherige nichts geliefert hat:
 *
 *  1. Pflegegrad-Historie — nur wenn §45b auch aktiviert ist (Task #724:
 *     ein Pflegekasse-Kunde MIT Pflegegrad, aber OHNE §45b-Einrichtung zeigte
 *     sonst einen Phantom-Topf).
 *  2. früheste aktive `initial_balance.validFrom`
 *  3. früheste aktive `carryover.validFrom`
 *  4. früheste SOFT-GELÖSCHTE `initial_balance.validFrom` (Task #1262: ein
 *     gelöschter Startwert bleibt Beleg dafür, dass §45b eingerichtet war —
 *     ohne diese Stufe verlöre die Allocation nach dem Soft-Delete ihren Anker
 *     und die Monatsaufstockung wäre DAUERHAFT blockiert).
 *  5. sonst: Eligibility-Gate. Ohne aktivierte §45b-Zeile gibt es keinen
 *     Anspruch; andernfalls der Jahresanfang.
 *
 * Die Stufen 2–4 ankern bewusst UNABHÄNGIG vom Eligibility-Gate: echte
 * persistierte Mittel belegen den Anspruch für sich.
 */
export function resolve45bAnchor(i: Resolve45bAnchorInput): Resolve45bAnchorResult {
  if (i.pgStartIso && i.s45bEnabled) {
    return { kind: "anchor", anchorIso: i.floorPgAnchor(i.pgStartIso), via: "pflegegrad" };
  }

  const viaIb = earliestValidFrom(i.activeAllocations, "initial_balance");
  if (viaIb) return { kind: "anchor", anchorIso: viaIb, via: "initial_balance" };

  const viaCarry = earliestValidFrom(i.activeAllocations, "carryover");
  if (viaCarry) return { kind: "anchor", anchorIso: viaCarry, via: "carryover" };

  const deleted = i.deletedInitialBalanceValidFroms.filter(Boolean);
  if (deleted.length > 0) {
    return {
      kind: "anchor",
      anchorIso: deleted.reduce((min, v) => (v < min ? v : min)),
      via: "deleted_initial_balance",
    };
  }

  if (!i.s45bEnabled) return { kind: "ineligible" };
  return { kind: "anchor", anchorIso: `${i.fallbackYear}-01-01`, via: "jahresanfang" };
}

/**
 * Monate, die ein AKTIVER Startwert belegt — das Skip-Set der
 * Monatsaufstockung (Doppelzählungsschutz, Task #101).
 *
 * Soft-gelöschte Startwerte gehören bewusst NICHT hinein (Task #642): sobald
 * kein aktiver Startwert den Monat mehr überdeckt, kehrt die reguläre
 * Aufstockung zurück.
 */
export function initialBalanceMonthKeys(
  activeAllocations: ReadonlyArray<{ source: string; year: number; month: number | null }>,
): Set<string> {
  return new Set(
    activeAllocations
      .filter(a => a.source === "initial_balance" && a.month != null)
      .map(a => `${a.year}-${a.month}`),
  );
}

// ---------------------------------------------------------------------------
// Settings-Fenster: welcher Zeitraum ist durch die §45b-Einrichtung gedeckt?
// ---------------------------------------------------------------------------

export interface SettingsWindowRow {
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Das wirksame §45b-Einrichtungs-Fenster über ALLE Phasen-Zeilen.
 *
 * Wichtig und nicht intuitiv: das Fenster wirkt NICHT über den Monatsbetrag
 * (`monthlyAmountFor` liefert für nicht abgedeckte Monate weiterhin den
 * gesetzlichen Satz), sondern über eine Verschiebung der Enumerations-Grenzen.
 * Wer das Fenster ignoriert, zählt Monate vor der Einrichtung mit — für einen
 * ab Mai eingerichteten Kunden also 12 statt 8 Monate.
 *
 *  - `validFrom` = die FRÜHESTE über alle Zeilen. Die einzelne „aktuell
 *    wirksame" Zeile zu nehmen wäre falsch: das ist üblicherweise die letzte
 *    Phase, und alle Monate vor dem Phasenwechsel fielen aus der Iteration
 *    (Repro: Jan–Apr fehlten komplett, weil die neue Zeile validFrom=Mai trug).
 *  - `validTo` = die SPÄTESTE über alle Zeilen — aber eine offene Zeile
 *    (`validTo = null`) bedeutet unbegrenzte Geltung und hebt jede Begrenzung
 *    auf.
 *
 * `fallback` bildet das Bestandsverhalten für den Fall ab, dass gar keine
 * Zeilen vorliegen.
 */
export function effective45bSettingsWindow(
  settings: ReadonlyArray<SettingsWindowRow>,
  fallback?: SettingsWindowRow | null,
): { validFrom: string | null; validTo: string | null } {
  if (settings.length === 0) {
    return { validFrom: fallback?.validFrom ?? null, validTo: fallback?.validTo ?? null };
  }
  const validFrom = settings.reduce<string | null>(
    (min, r) => (r.validFrom != null && (min == null || r.validFrom < min) ? r.validFrom : min),
    null,
  );
  const hasOpenEnd = settings.some(r => r.validTo == null);
  const validTo = hasOpenEnd
    ? null
    : settings.reduce<string | null>(
        (max, r) => (max == null || (r.validTo != null && r.validTo > max) ? r.validTo : max),
        null,
      );
  return { validFrom, validTo };
}

export interface YearMonth { year: number; month: number }

/** `${iso}` → `{year, month}`; `null` bleibt `null`. */
function toYearMonth(iso: string | null): YearMonth | null {
  if (!iso) return null;
  const [y, m] = iso.split("-").map(Number);
  return Number.isInteger(y) && Number.isInteger(m) ? { year: y, month: m } : null;
}

/** Schiebt den Start NACH HINTEN, wenn die Einrichtung später beginnt. */
export function shiftStartToSettings(start: YearMonth, validFromIso: string | null): YearMonth {
  const vf = toYearMonth(validFromIso);
  if (!vf) return start;
  const später = vf.year > start.year || (vf.year === start.year && vf.month > start.month);
  return später ? vf : start;
}

/** Zieht das Ende NACH VORNE, wenn die Einrichtung früher endet. */
export function clampEndToSettings(end: YearMonth, validToIso: string | null): YearMonth {
  const vt = toYearMonth(validToIso);
  if (!vt) return end;
  const früher = vt.year < end.year || (vt.year === end.year && vt.month < end.month);
  return früher ? vt : end;
}
