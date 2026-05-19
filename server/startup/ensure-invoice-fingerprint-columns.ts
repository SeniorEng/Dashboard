import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Task #522: stellt die Spalten `pdf_data_fingerprint` und
 * `leistungsnachweis_data_fingerprint` auf `invoices` sicher. Sie werden für
 * den Drift-Indikator gebraucht (Vergleich „aktuelle Live-Daten" vs.
 * „Fingerprint zum Zeitpunkt der PDF-Erstellung"). Idempotente DDL — beim
 * nächsten Boot ein No-Op.
 */
export async function ensureInvoiceFingerprintColumns(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS pdf_data_fingerprint text,
    ADD COLUMN IF NOT EXISTS leistungsnachweis_data_fingerprint text
  `);
  log("Invoice-Schema-Migration: pdf_data_fingerprint/leistungsnachweis_data_fingerprint sichergestellt", "startup");
}
