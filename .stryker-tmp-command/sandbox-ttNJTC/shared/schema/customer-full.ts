// @ts-nocheck
import type { Customer, CustomerContact, CustomerCareLevelHistory, CustomerNeedsAssessment } from "./customers";
import type { CustomerInsuranceHistory, InsuranceProvider } from "./insurance";
import type { CustomerContract, CustomerContractRate } from "./contracts";
import type { BudgetSummary } from "./budget";

// Customer with all related data for detail view
export type CustomerWithDetails = Customer & {
  insurance?: CustomerInsuranceHistory & { provider: InsuranceProvider };
  contacts: CustomerContact[];
  careLevelHistory: CustomerCareLevelHistory[];
  needsAssessment?: CustomerNeedsAssessment;
  contract?: CustomerContract & { rates: CustomerContractRate[] };
  primaryEmployee?: { id: number; displayName: string };
  backupEmployee?: { id: number; displayName: string };
  backupEmployee2?: { id: number; displayName: string };
  budgetSummary?: BudgetSummary;
  /**
   * Task #729 — true bei pflegekassen-berechtigten Kunden (PG ≥ 2) ohne
   * aktive Zeile in `customer_budget_type_settings`
   * (`validTo IS NULL AND enabled = true`). Banner-/Listen-Marker für die
   * „Budget-Einrichtung steht noch aus"-UI.
   */
  budgetSetupMissing?: boolean;
};
