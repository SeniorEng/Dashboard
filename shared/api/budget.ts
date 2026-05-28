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
