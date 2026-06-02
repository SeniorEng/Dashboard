import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #757: stellt die Spalte `bank_account_holder` auf `company_settings`
 * sicher (optionaler abweichender Kontoinhaber für den Zahlungsblock und
 * PayeeFinancialAccount.AccountName im ZUGFeRD-XML). Idempotent — beim
 * nächsten Boot ein No-Op.
 */
// Task #922 — rohes DDL als Konstante exportiert (Drift-Wächter-SSoT).
export const COMPANY_BANK_ACCOUNT_HOLDER_COLUMN_SQL = `
  ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS bank_account_holder text
`;

export async function ensureCompanyBankAccountHolderColumn(): Promise<void> {
  await db.execute(sql.raw(COMPANY_BANK_ACCOUNT_HOLDER_COLUMN_SQL));
  log("Company-Settings-Migration: bank_account_holder sichergestellt", "startup");
}
