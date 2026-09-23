import type { Customer, CustomerContact, CustomerCareLevelHistory, CustomerNeedsAssessment } from "./customers";
import type { CustomerInsuranceHistory, InsuranceProvider } from "./insurance";
import type { CustomerContract, CustomerContractRate } from "./contracts";

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
  /**
   * `budgetSummary` ist am 23.09.2026 ENTFERNT.
   *
   * Das Feld war optional und wurde von KEINEM Pfad gefuellt (gemessen: kein
   * einziges `budgetSummary:` in server/, client/ oder shared/). Sein Typ war
   * eine zweite, kuerzere `BudgetSummary`-Fassung neben der produzierten in
   * `server/storage/budget/types.ts` — und genau daran ist ein Feld-Eintrag
   * schon einmal in der falschen Datei gelandet.
   *
   * Ein oeffentlicher Typ, den niemand fuellt, ist ein Versprechen ohne
   * Deckung: der naechste Leser haelt die Daten fuer vorhanden. Wer eine
   * Budget-Zusammenfassung braucht, liest `GET /api/budget/:id/overview`.
   */
  /**
   * Task #729 — true bei pflegekassen-berechtigten Kunden (PG ≥ 2) ohne
   * aktive Zeile in `customer_budget_type_settings`
   * (`validTo IS NULL AND enabled = true`). Banner-/Listen-Marker für die
   * „Budget-Einrichtung steht noch aus"-UI.
   */
  budgetSetupMissing?: boolean;
};
