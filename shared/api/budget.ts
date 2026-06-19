/**
 * Budget API contracts — Single Source of Truth für die Wire-Shapes der
 * Budget-Routen. Vor Task #720 lebten diese Schemas nur inline in
 * `server/routes/budget.ts` und wurden im Frontend (`BudgetLedgerSection.tsx`)
 * dupliziert. Drift war jederzeit möglich (kein Compile-Time-Check).
 *
 * Quelle: `GET /api/budget/:customerId/overview` — siehe Inventur-Doku
 * `docs/budget-ssot-inventory.md` Abschnitt 3.6 („DTO-SSoT-Lücke") und
 * Phasen-Plan Phase 1.2 Schritt 1.
 *
 * Querschnitts-Auflage A (pure / kein State): Dieses Modul deklariert
 * NUR Typen — keine Runtime-Logik, keine Defaults, keine Konstanten.
 */

/**
 * §45b Entlastungsbetrag — Jahrestopf mit monatlicher Aufstockung
 * (kein harter Monats-Cap seit #425). Verfügbar = bis zum Abfragedatum
 * aufgelaufene Allocation minus bereits gebuchter Beträge.
 */
export interface BudgetOverview45bDTO {
  totalAllocatedCents: number;
  totalUsedCents: number;
  availableCents: number;
  plannedCents: number;
  availableAfterPlannedCents: number;
  currentMonthUsedCents: number;
  currentMonthAvailableCents: number;
  /**
   * Per-Kunde konfigurierbarer "Unser Anteil"-Wert (€/Monat), reduziert die
   * monatliche Aufstockung. `null` = gesetzlicher Default 131 €/Monat.
   */
  monthlyLimitCents: number | null;
  carryoverCents: number;
  /** ISO-Datum (YYYY-MM-DD), an dem der Carryover verfällt. */
  carryoverExpiresAt: string | null;
  currentYearAllocatedCents: number;
  isCurrentlyActive: boolean;
  /**
   * Task #706 — Erster Monat (YYYY-MM), in dem die §45b-Projektion
   * (kumulative Monatsaufstockungen + ablaufende Carryover) die bis dahin
   * geplanten Termine nicht mehr deckt. `null` = keine Lücke prognostiziert.
   * Das Warnbanner nennt diesen Monat menschenlesbar.
   */
  plannedShortfallMonth: string | null;
}

/** §45a Umwandlungsanspruch — Monatstopf, PG-abhängiges Maximum. */
export interface BudgetOverview45aDTO {
  monthlyBudgetCents: number;
  currentMonthAllocatedCents: number;
  currentMonthUsedCents: number;
  currentMonthAvailableCents: number;
  isCurrentlyActive: boolean;
  /** UI-Label, am Backend einheitlich gesetzt. */
  label: string;
}

/** §39/§42a Verhinderungspflege — gemeinsamer Jahresbetrag. */
export interface BudgetOverview39_42aDTO {
  yearlyBudgetCents: number;
  currentYearAllocatedCents: number;
  currentYearUsedCents: number;
  currentYearAvailableCents: number;
  label: string;
}

/**
 * Wire-Format von `GET /api/budget/:customerId/overview`.
 *
 * Read-Pfad: `BudgetLedgerSection.tsx` (Customer-Detail) und Stats-V2
 * Per-Customer-Aggregat (Phase 2). Drift wäre direkt sichtbar als
 * falscher Topf-Rest in der UI — daher Snapshot-Test
 * `tests/equality/budget-overview-dto-shape.test.ts` als Schranke.
 */
export interface BudgetOverviewDTO {
  entlastungsbetrag45b: BudgetOverview45bDTO;
  umwandlung45a: BudgetOverview45aDTO;
  ersatzpflege39_42a: BudgetOverview39_42aDTO;
}

/**
 * §45b FIFO-Aufschlüsselung (Task #1129) — Wire-Format von
 * `GET /api/budget/:customerId/fifo-breakdown`. Rein lesende Visualisierung;
 * keine eigene Verfügbarkeits-Mathematik. Summen rekonzilieren exakt mit der
 * §45b-Karte:
 *   Σ pots.allocatedCents === totalAllocatedCents (== Overview totalAllocatedCents)
 *   Σ pots.consumedCents   === totalConsumedCents  (== Overview totalUsedCents, sofern kein manual_adjustment)
 *   Σ pots.remainingCents  === totalAvailableCents (== Overview availableCents)
 * Pro Topf gilt: allocatedCents === consumedCents + plannedCents + remainingCents
 * und consumedCents === consumedBilledCents + consumedDocumentedCents + consumedOtherCents.
 */
export type BudgetFifoPotType = "carryover" | "current_year";

export interface BudgetFifoPotDTO {
  potType: BudgetFifoPotType;
  allocatedCents: number;
  consumedCents: number;
  /** Konsum für bereits abgerechnete Termine. */
  consumedBilledCents: number;
  /** Konsum für dokumentierte (abgeschlossen + unterschriebene) Termine. */
  consumedDocumentedCents: number;
  /** Restlicher Konsum (write_off, Importe ohne Termin-Status …). */
  consumedOtherCents: number;
  /** Aktive Hard-Holds (geplante/blockierte Reservierungen). */
  plannedCents: number;
  /** Frei verfügbar. */
  remainingCents: number;
}

export interface BudgetFifo45bBreakdownDTO {
  /** FIFO-Reihenfolge: Übertrag zuerst, dann laufendes Jahr. */
  pots: BudgetFifoPotDTO[];
  carryoverExpiresAt: string | null;
  totalAllocatedCents: number;
  totalConsumedCents: number;
  totalPlannedCents: number;
  totalAvailableCents: number;
}
