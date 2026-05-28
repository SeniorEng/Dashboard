import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #757: stellt die Spalte `bank_account_holder` auf `company_settings`
 * sicher (optionaler abweichender Kontoinhaber für den Zahlungsblock und
 * PayeeFinancialAccount.AccountName im ZUGFeRD-XML). Idempotent — beim
 * nächsten Boot ein No-Op.
 */
export async function ensureCompanyBankAccountHolderColumn(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE company_settings
    ADD COLUMN IF NOT EXISTS bank_account_holder text
  `);
  log("Company-Settings-Migration: bank_account_holder sichergestellt", "startup");
}
