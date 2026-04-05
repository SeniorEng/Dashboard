import { db } from "../lib/db";
import { encryptSecret, isEncrypted, isEncryptionConfigured } from "../lib/crypto";
import { log } from "../lib/log";

const SENSITIVE_FIELDS = [
  "smtp_pass", "epost_password", "epost_secret",
  "qonto_secret_key", "whatsapp_access_token", "twilio_auth_token",
];

export async function encryptExistingSecrets(): Promise<void> {
  if (!isEncryptionConfigured()) {
    log("ENCRYPTION_KEY nicht gesetzt — Verschlüsselung übersprungen", "startup");
    return;
  }

  const { companySettings } = await import("@shared/schema");
  const rows = await db.select().from(companySettings).limit(1);
  if (rows.length === 0) return;

  const row = rows[0] as Record<string, unknown>;
  const updates: Record<string, string> = {};

  for (const dbCol of SENSITIVE_FIELDS) {
    const camelKey = dbCol.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const val = row[camelKey];
    if (typeof val === "string" && val && !isEncrypted(val)) {
      updates[camelKey] = encryptSecret(val);
    }
  }

  if (Object.keys(updates).length === 0) return;

  const { eq } = await import("drizzle-orm");
  await db.update(companySettings)
    .set(updates as any)
    .where(eq(companySettings.id, row.id as number));

  log(`${Object.keys(updates).length} API-Secrets verschlüsselt: ${Object.keys(updates).join(", ")}`, "startup");
}
