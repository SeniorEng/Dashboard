import { budgetLedgerStorage } from "../storage/budget-ledger";
import type { DbClient } from "../storage/budget/types";
import type { BudgetAllocation } from "@shared/schema";
import { todayISO, parseLocalDate } from "@shared/utils/datetime";
import { formatEuroDE } from "@shared/utils/money";
import { floorAutoAnchor45bToCurrentYear } from "@shared/domain/budgets";
import {
  eligible45bCarryoverMonths,
  max45bStartValueCents,
  max45bCarryoverCents,
  resolve45bAccrualAnchor,
} from "@shared/domain/budget/carryover-eligibility";
import { validateSelbstzahlerBudget } from "@shared/domain/budget-selbstzahler-validator";
import { validatePflegegradBudget } from "@shared/domain/budget-pflegegrad-validator";
import { getCustomerCareLevelHistory } from "../storage/customer-mgmt/care-level";
import { auditService } from "./audit";

/**
 * Typisierter Fehler des Initial-Budget-Setups. Trägt HTTP-Status + Wire-Code,
 * damit sowohl die Route (`POST /budget/:id/initial-budget`) als auch der
 * konsolidierte Kunden-Anlage-Flow (`POST /customers`) denselben Fehler in das
 * einheitliche Wire-Format (`error`/`code`/`message`) übersetzen können — ohne
 * dass diese reine Logik ein `res`-Objekt kennt.
 */
export class BudgetInitialSetupError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BudgetInitialSetupError";
  }
}

export interface ApplyInitialBudgetParams {
  customerId: number;
  budgetType: string;
  currentMonthAmountCents: number;
  carryoverAmountCents?: number;
  /** RAW-Anker (Pflegegrad-Beginn / Stichmonat), ungekappt. */
  budgetStartDate: string;
  /** Bereits geladene Kundenstammdaten für die Intent-Validierung. */
  customer: { billingType: string | null | undefined; pflegegrad: number | null | undefined };
  userId?: number;
  /** Optionale Tx — alle Schreibvorgänge laufen dann atomar im äußeren Commit. */
  tx?: DbClient;
  /** IP für das Audit-Log (optional). */
  ip?: string | null;
}

/**
 * SSoT für die Erfassung eines Startbudgets (`initial_balance` + §45b-Carryover
 * + Anker-Preferences) eines Budget-Topfes. Spiegelt 1:1 die Logik der Route
 * `POST /budget/:customerId/initial-budget`, wirft aber typisierte Fehler statt
 * `res`-Responses zu senden und honoriert eine optionale Transaktion.
 *
 * Verwendet von:
 *  - `routes/budget.ts` (Standalone-Route, übersetzt den Fehler in eine Response)
 *  - `lib/customer-creation-helpers.ts` (atomarer Kunden-Anlage-Flow, pro Topf)
 *
 * §45b-Kappung (Task #856/#860/#959) und die §45a/§39-In-place-Aktivierung
 * (Task #705/#876) sind hier zentralisiert — siehe Inline-Kommentare.
 */
export async function applyInitialBudget(params: ApplyInitialBudgetParams): Promise<BudgetAllocation[]> {
  const { customerId, budgetType, currentMonthAmountCents, customer, userId, tx } = params;
  const carryoverAmountCents = params.carryoverAmountCents ?? 0;
  const rawBudgetStartDate = params.budgetStartDate;

  // Selbstzahler-/Pflegegrad-Block via geteilte reine Validatoren (Task #705/
  // #716/#722). Wirft typisiert statt eine Response zu senden.
  const sz = validateSelbstzahlerBudget({
    billingType: customer.billingType,
    intent: { budgetType },
  });
  if (!sz.ok) throw new BudgetInitialSetupError(sz.httpStatus, sz.code, sz.message);
  const pg = validatePflegegradBudget({
    pflegegrad: customer.pflegegrad,
    intent: { budgetType },
  });
  if (!pg.ok) throw new BudgetInitialSetupError(pg.httpStatus, pg.code, pg.message);

  // §45b-Onboarding-Baseline: Startwert-/Carryover-Zeilen aufs laufende Jahr
  // boden (Task #860), identisch zum §45b-Lesepfad. Der RAW-Anker bleibt für
  // §45a/§39 in den Preferences erhalten.
  let budgetStartDate = rawBudgetStartDate;
  if (budgetType === "entlastungsbetrag_45b") {
    const now = parseLocalDate(todayISO());
    budgetStartDate = floorAutoAnchor45bToCurrentYear(budgetStartDate, now.getFullYear());
  }
  const startDate = parseLocalDate(budgetStartDate);
  const year = startDate.getFullYear();

  // §45b-Akkumulations-Obergrenzen (Task #959): Startwert + Carryover dürfen das
  // rechtlich mögliche Maximum nicht überschreiten. Accrual-Anker = frühester
  // Pflegegrad-Beginn (Care-Level-Historie), Fallback = RAW-Budget-Start.
  if (budgetType === "entlastungsbetrag_45b") {
    const careLevelHistory = await getCustomerCareLevelHistory(customerId);
    const accrualAnchor = resolve45bAccrualAnchor(careLevelHistory, rawBudgetStartDate);

    if (currentMonthAmountCents > 0) {
      const startCap = max45bStartValueCents(accrualAnchor, budgetStartDate);
      if (currentMonthAmountCents > startCap) {
        throw new BudgetInitialSetupError(
          400,
          "BUDGET_45B_START_VALUE_EXCEEDED",
          `§45b-Startguthaben darf höchstens ${formatEuroDE(startCap)} betragen (rechtlich mögliche Ansammlung bis zum Startmonat). Eingegeben: ${formatEuroDE(currentMonthAmountCents)}.`,
        );
      }
    }

    if (carryoverAmountCents > 0) {
      const carryoverCap = max45bCarryoverCents(
        eligible45bCarryoverMonths(accrualAnchor, year),
      );
      if (carryoverAmountCents > carryoverCap) {
        throw new BudgetInitialSetupError(
          400,
          "BUDGET_45B_CARRYOVER_EXCEEDED",
          `§45b-Übertrag aus ${year - 1} darf höchstens ${formatEuroDE(carryoverCap)} betragen (im Vorjahr berechtigte Monate). Eingegeben: ${formatEuroDE(carryoverAmountCents)}.`,
        );
      }
    }
  }

  // §45a/§39_42a: Topf idempotent in-place aktivieren, damit der Read-Pfad den
  // Startwert nicht herausfiltert (Task #705/#876).
  if ((budgetType === "umwandlung_45a" || budgetType === "ersatzpflege_39_42a") && currentMonthAmountCents > 0) {
    await budgetLedgerStorage.ensureBudgetTypeEnabledInPlace(customerId, budgetType, budgetStartDate, tx);
  }

  const allocations: BudgetAllocation[] = [];

  if (currentMonthAmountCents > 0) {
    const expiresAt = budgetType === "ersatzpflege_39_42a" ? `${year}-12-31` : null;
    const startMonth = startDate.getMonth() + 1;
    await budgetLedgerStorage.upsertInitialBalanceAllocation({
      customerId,
      budgetType,
      year,
      month: startMonth,
      amountCents: currentMonthAmountCents,
      validFrom: budgetStartDate,
      expiresAt,
      notes: `Startguthaben ${year}`,
    }, userId, tx);
    const allAllocations = await budgetLedgerStorage.getInitialBalanceAllocations(customerId, budgetType, tx);
    if (allAllocations.length > 0) allocations.push(allAllocations[0]);
  }

  if (carryoverAmountCents > 0 && budgetType === "entlastungsbetrag_45b") {
    // validFrom auf Jahresanfang (Task #116/#601), Zieljahr-konsistent zu
    // `ensureYearlyCarryover45b` (verhindert Doppel-Carryover via Auto-Dedup).
    const carryoverAllocation = await budgetLedgerStorage.createBudgetAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year,
      month: null,
      amountCents: carryoverAmountCents,
      source: "carryover",
      validFrom: `${year}-01-01`,
      expiresAt: `${year}-06-30`,
      notes: `Übertrag aus ${year - 1}`,
    }, userId, tx);
    allocations.push(carryoverAllocation);
  }

  // Task #1204 — Es gibt keinen persistierten kunden-weiten `budget_start_date`
  // mehr; der Anker wird zur Laufzeit pro Topf aus der Pflegegrad-Historie
  // abgeleitet (§45a/§39 roh, §45b aufs laufende Jahr gebodet). Daher wird hier
  // keine Anker-Preference mehr geschrieben; der `initial_balance`-Startwert oben
  // trägt den Stichmonat selbst.

  if (userId) {
    await auditService.log(userId, "budget_initial_setup", "budget", customerId, {
      customerId,
      budgetType,
      currentMonthAmountCents,
      carryoverAmountCents,
      budgetStartDate,
      allocationIds: allocations.map(a => a.id),
    }, params.ip ?? undefined);
  }

  return allocations;
}
