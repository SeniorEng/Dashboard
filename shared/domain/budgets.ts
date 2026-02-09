// shared/domain/budgets.ts
// Central source of truth for all budget rules per German care law (SGB XI, PUEG 2025)

// ============================================
// §45b Entlastungsbetrag
// ============================================
export const BUDGET_45B_MAX_MONTHLY_CENTS = 13100; // 131€ max per month
export const BUDGET_45B_CARRYOVER_DEADLINE_MONTH = 6; // Expires June 30 of following year

// ============================================
// §45a Umwandlungsanspruch (40% of unused Pflegesachleistungen)
// ============================================
// Max monthly amounts per Pflegegrad (in cents)
// These are 40% of the Sachleistung amounts per §36 SGB XI
export const BUDGET_45A_MAX_BY_PFLEGEGRAD: Record<number, number> = {
  1: 0,      // PG1: not eligible
  2: 31840,  // PG2: 318.40€ (40% of 796€)
  3: 59880,  // PG3: 598.80€ (40% of 1,497€)
  4: 74360,  // PG4: 743.60€ (40% of 1,859€)
  5: 91960,  // PG5: 919.60€ (40% of 2,299€)
};

// Full Sachleistung amounts per Pflegegrad (for reference/display)
export const SACHLEISTUNG_BY_PFLEGEGRAD: Record<number, number> = {
  1: 0,
  2: 79600,   // 796€
  3: 149700,  // 1,497€
  4: 185900,  // 1,859€
  5: 229900,  // 2,299€
};

// ============================================
// §39/§42a Gemeinsamer Jahresbetrag
// ============================================
export const BUDGET_39_42A_MAX_YEARLY_CENTS = 353900; // 3,539€/year (from July 2025)

// ============================================
// Budget Types
// ============================================
export const BUDGET_TYPES = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;

export type BudgetType = typeof BUDGET_TYPES[number];

export const BUDGET_TYPE_LABELS: Record<BudgetType, string> = {
  entlastungsbetrag_45b: "§45b Entlastungsbetrag",
  umwandlung_45a: "§45a Umwandlungsanspruch",
  ersatzpflege_39_42a: "§39/§42a Gemeinsamer Jahresbetrag",
};

// ============================================
// Validation Functions
// ============================================

/**
 * Validate §45b monthly amount (max 131€)
 * Returns error message or null if valid
 */
export function validate45bAmount(amountCents: number): string | null {
  if (amountCents < 0) return "Betrag darf nicht negativ sein";
  if (amountCents > BUDGET_45B_MAX_MONTHLY_CENTS) {
    return `§45b Entlastungsbetrag darf maximal ${(BUDGET_45B_MAX_MONTHLY_CENTS / 100).toFixed(2)} €/Monat betragen`;
  }
  return null;
}

/**
 * Validate §45a monthly amount based on Pflegegrad
 * Returns error message or null if valid
 */
export function validate45aAmount(amountCents: number, pflegegrad: number | null): string | null {
  if (amountCents < 0) return "Betrag darf nicht negativ sein";
  if (!pflegegrad || pflegegrad < 2) {
    if (amountCents > 0) return "§45a Umwandlungsanspruch ist erst ab Pflegegrad 2 verfügbar";
    return null;
  }
  const maxCents = BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? 0;
  if (amountCents > maxCents) {
    return `§45a Umwandlungsanspruch darf bei Pflegegrad ${pflegegrad} maximal ${(maxCents / 100).toFixed(2)} €/Monat betragen`;
  }
  return null;
}

/**
 * Validate §39/§42a yearly amount (max 3,539€)
 * Returns error message or null if valid
 */
export function validate39_42aAmount(amountCents: number): string | null {
  if (amountCents < 0) return "Betrag darf nicht negativ sein";
  if (amountCents > BUDGET_39_42A_MAX_YEARLY_CENTS) {
    return `§39/§42a Gemeinsamer Jahresbetrag darf maximal ${(BUDGET_39_42A_MAX_YEARLY_CENTS / 100).toFixed(2)} €/Jahr betragen`;
  }
  return null;
}

/**
 * Get the max §45a amount for a given Pflegegrad
 */
export function get45aMaxForPflegegrad(pflegegrad: number | null): number {
  if (!pflegegrad || pflegegrad < 2) return 0;
  return BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? 0;
}
