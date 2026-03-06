import type { Customer, CustomerContact, CustomerCareLevelHistory, CustomerNeedsAssessment, CustomerPricing } from "./customers";
import type { CustomerInsuranceHistory, InsuranceProvider } from "./insurance";
import type { CustomerContract, CustomerContractRate } from "./contracts";
import type { CustomerBudget, BudgetSummary } from "./budget";

// Customer with all related data for detail view
export type CustomerWithDetails = Customer & {
  insurance?: CustomerInsuranceHistory & { provider: InsuranceProvider };
  contacts: CustomerContact[];
  careLevelHistory: CustomerCareLevelHistory[];
  needsAssessment?: CustomerNeedsAssessment;
  budget?: CustomerBudget;
  contract?: CustomerContract & { rates: CustomerContractRate[] };
  primaryEmployee?: { id: number; displayName: string };
  backupEmployee?: { id: number; displayName: string };
  pricingHistory?: CustomerPricing[];
  currentPricing?: CustomerPricing;
  budgetSummary?: BudgetSummary;
};
