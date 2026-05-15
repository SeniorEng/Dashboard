// shared/domain/budgets.ts
// Central source of truth for all budget rules per German care law (SGB XI, PUEG 2025)
import { formatEuroDE } from "../utils/money";

// ============================================
// §45b Entlastungsbetrag
// ============================================
export const BUDGET_45B_MAX_MONTHLY_CENTS = 13100; // 131€ max per month

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
    return `§45b Entlastungsbetrag darf maximal ${formatEuroDE(BUDGET_45B_MAX_MONTHLY_CENTS)}/Monat betragen`;
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
    return `§45a Umwandlungsanspruch darf bei Pflegegrad ${pflegegrad} maximal ${formatEuroDE(maxCents)}/Monat betragen`;
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
    return `§39/§42a Gemeinsamer Jahresbetrag darf maximal ${formatEuroDE(BUDGET_39_42A_MAX_YEARLY_CENTS)}/Jahr betragen`;
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

// ============================================
// Cascade-Reihenfolge (Single Source of Truth, Task #441)
// ============================================
/**
 * Standard-Reihenfolge der Budget-Töpfe in der Cascade-Konsumption.
 *
 * Die Engine (`consumption-engine.ts`) iteriert in dieser Reihenfolge, sofern
 * keine kunden-spezifische `customer_budget_type_settings.priority`-Override
 * existiert. Hardcoded-Listen an anderen Stellen sind verboten — wer eine
 * neue Reihenfolge braucht, ändert hier zentral.
 */
export const DEFAULT_BUDGET_POT_ORDER: ReadonlyArray<{
  budgetType: BudgetType;
  enabled: boolean;
  priority: number;
}> = [
  { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1 },
  { budgetType: "umwandlung_45a", enabled: false, priority: 2 },
  { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3 },
];

// ============================================
// Statutorische Cap-Clamping (Task #441)
// ============================================
/**
 * Clampt Customer-Settings-Limits gegen die gesetzlichen Maxima.
 *
 * Wo gebraucht:
 *   - `cap-calculator.ts:computeCapSlot` — bevor das Cap-Window rechnet,
 *     damit eine fehlerhafte Migration / ein UI-Bypass nie über dem
 *     gesetzlichen Maximum buchen kann.
 *   - Zod-Refines / Storage-Hooks bei `customer_budget_type_settings` —
 *     dieselbe Funktion, damit Anzeige- und Schreibpfad nicht driften.
 *
 * Verhalten:
 *   - `null`/`undefined` bleibt `null` (= kein Limit konfiguriert).
 *   - Negative Werte werden auf `0` geklemmt.
 *   - §45b: monthlyLimit gegen `BUDGET_45B_MAX_MONTHLY_CENTS`.
 *     §45b kennt seit Task #425 keinen echten Monats-Cap mehr, das Clampen
 *     stellt jedoch sicher, dass eine versehentlich migrierte Zahl > 131€
 *     nicht in DB-Refines durchrutscht.
 *   - §45a: monthlyLimit gegen `BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad]`.
 *     Ohne Pflegegrad ≥ 2 → Cap = 0.
 *   - §39/§42a: yearlyLimit gegen `BUDGET_39_42A_MAX_YEARLY_CENTS`.
 *   - Andere Töpfe: unverändert durchgereicht.
 */
export interface ClampedLimits {
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
}

export function clampToStatutoryMax(args: {
  budgetType: string;
  monthlyLimitCents: number | null | undefined;
  yearlyLimitCents: number | null | undefined;
  pflegegrad: number | null | undefined;
}): ClampedLimits {
  const clamp = (v: number | null | undefined, max: number): number | null => {
    if (v == null) return null;
    if (v < 0) return 0;
    return Math.min(v, max);
  };

  switch (args.budgetType) {
    case "entlastungsbetrag_45b":
      return {
        monthlyLimitCents: clamp(args.monthlyLimitCents, BUDGET_45B_MAX_MONTHLY_CENTS),
        yearlyLimitCents: args.yearlyLimitCents ?? null,
      };
    case "umwandlung_45a": {
      const pgMax = args.pflegegrad && args.pflegegrad >= 2
        ? (BUDGET_45A_MAX_BY_PFLEGEGRAD[args.pflegegrad] ?? 0)
        : 0;
      return {
        monthlyLimitCents: clamp(args.monthlyLimitCents, pgMax),
        yearlyLimitCents: args.yearlyLimitCents ?? null,
      };
    }
    case "ersatzpflege_39_42a":
      return {
        monthlyLimitCents: args.monthlyLimitCents ?? null,
        yearlyLimitCents: clamp(args.yearlyLimitCents, BUDGET_39_42A_MAX_YEARLY_CENTS),
      };
    default:
      return {
        monthlyLimitCents: args.monthlyLimitCents ?? null,
        yearlyLimitCents: args.yearlyLimitCents ?? null,
      };
  }
}
