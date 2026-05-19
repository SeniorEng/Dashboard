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
export async function ensureInvoiceLeistungsnachweisColumns(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS leistungsnachweis_path text,
    ADD COLUMN IF NOT EXISTS leistungsnachweis_hash text
  `);
  log("Invoice-Schema-Migration: leistungsnachweis_path/hash sichergestellt", "startup");
}
