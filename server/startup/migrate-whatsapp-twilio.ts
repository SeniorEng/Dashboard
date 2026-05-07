import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";

/**
 * Einmalige Migration nach Wechsel Meta Cloud API → Twilio WhatsApp Content API.
 *
 * - Setzt veraltete Meta-spezifische Felder (whatsapp_phone_number_id, whatsapp_business_account_id) auf NULL,
 *   damit niemand sie versehentlich weiterverwendet (Spalten bleiben aus Sicherheitsgründen stehen).
 * - Deaktiviert WhatsApp einmalig (whatsapp_enabled = false), wenn noch alte Meta-Konfiguration vorhanden ist
 *   und noch kein Twilio-Sender (whatsapp_from_or_service) eingetragen wurde – Admin muss neu konfigurieren.
 * - Leert den alten Meta-Bearer-Token (whatsapp_access_token), damit das Feld für den optionalen
 *   Twilio-Auth-Token-Override frei ist.
 *
 * Idempotent: Greift nur, solange whatsapp_phone_number_id IS NOT NULL und whatsapp_from_or_service IS NULL.
 */
export async function migrateWhatsAppToTwilio(): Promise<void> {
  const result = await db.execute(sql`
    UPDATE company_settings
    SET
      whatsapp_phone_number_id = NULL,
      whatsapp_business_account_id = NULL,
      whatsapp_access_token = NULL,
      whatsapp_enabled = false,
      updated_at = NOW()
    WHERE whatsapp_phone_number_id IS NOT NULL
      AND whatsapp_from_or_service IS NULL
  `);

  const rowCount = (result as { rowCount?: number }).rowCount ?? 0;
  if (rowCount > 0) {
    log(
      `WhatsApp-Provider auf Twilio umgestellt: ${rowCount} company_settings-Zeile(n) bereinigt. Admin muss Twilio-Sender neu eintragen.`,
      "startup",
    );
  }
}
