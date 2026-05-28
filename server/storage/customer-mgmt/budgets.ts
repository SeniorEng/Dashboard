import {
  type CustomerBudget,
  type InsertCustomerBudget,
} from "@shared/schema";
import { type DbOrTx } from "../../lib/db";

/**
 * Task #728 (Phase 2.1): No-Op. Die Tabelle `customer_budgets` wird nicht
 * mehr beschrieben — die SSoT-Topfkonfiguration lebt in
 * `customer_budget_type_settings` und wird über
 * `budgetLedgerStorage.upsertBudgetTypeSettings` aktualisiert.
 *
 * Die Funktion bleibt mit unveränderter Signatur als Stub bestehen, damit
 * Bestandsaufrufer (Admin-POST `/admin/customers/:id/budgets`, Legacy-Pfad
 * in `customer-creation-helpers.ts`) kompilieren und ohne Crash returnen.
 * Aufrufer werden in Folge-Tasks auf den SSoT-Writer umgezogen.
 *
 * Liefert einen synthetischen `CustomerBudget`-Stub (id = -1, dehydriert)
 * zurück, damit die Rückgabe-Form stabil bleibt — geschrieben wird NICHTS.
 */
export async function addCustomerBudget(
  data: InsertCustomerBudget,
  _userId?: number,
  _tx?: DbOrTx,
): Promise<CustomerBudget> {
  void _userId;
  void _tx;
  console.warn(
    `[addCustomerBudget] No-Op (Task #728 Phase 2.1) — customer_budgets ist abgeschaltet. customerId=${data.customerId}. SSoT-Writer: budgetLedgerStorage.upsertBudgetTypeSettings.`,
  );
  return {
    id: -1,
    customerId: data.customerId,
    entlastungsbetrag45b: data.entlastungsbetrag45b ?? 0,
    verhinderungspflege39: data.verhinderungspflege39 ?? 0,
    pflegesachleistungen36: data.pflegesachleistungen36 ?? 0,
    validFrom: data.validFrom,
    validTo: data.validTo ?? null,
    notes: data.notes ?? null,
    createdAt: new Date(),
    createdByUserId: null,
  } as CustomerBudget;
}
