import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #521: stellt die Spalten `leistungsnachweis_path` und
 * `leistungsnachweis_hash` auf `invoices` sicher, damit der LN-PDF-Cache
 * (analog zum Rechnungs-PDF-Cache aus Task #T01) in jeder Umgebung
 * funktioniert, auch wenn `drizzle-kit push` nicht gelaufen ist.
 * Idempotente DDL — beim nächsten Boot ein No-Op.
 */
// Task #922 — rohes DDL als Konstante exportiert (Drift-Wächter-SSoT).
export const INVOICE_LEISTUNGSNACHWEIS_COLUMNS_SQL = `
  ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS leistungsnachweis_path text,
  ADD COLUMN IF NOT EXISTS leistungsnachweis_hash text
`;

export async function ensureInvoiceLeistungsnachweisColumns(): Promise<void> {
  await db.execute(sql.raw(INVOICE_LEISTUNGSNACHWEIS_COLUMNS_SQL));
  log("Invoice-Schema-Migration: leistungsnachweis_path/hash sichergestellt", "startup");
}
