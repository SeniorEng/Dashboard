import { db } from "../lib/db";
import { encryptSecret, isEncrypted, isEncryptionConfigured } from "../lib/crypto";
import { log } from "../lib/log";
import { getSensitivePropsForTable } from "../lib/encrypted-row";

export async function encryptExistingSecrets(): Promise<void> {
  if (!isEncryptionConfigured()) {
    log("ENCRYPTION_KEY nicht gesetzt — Verschlüsselung übersprungen", "startup");
    return;
  }

  const { companySettings } = await import("@shared/schema");
  const rows = await db.select().from(companySettings).limit(1);
  if (rows.length === 0) return;

  const row = rows[0] as Record<string, unknown>;
  const sensitiveProps = getSensitivePropsForTable(companySettings);
  const updates: Record<string, string> = {};

  for (const prop of sensitiveProps) {
    const val = row[prop];
    if (typeof val === "string" && val && !isEncrypted(val)) {
      updates[prop] = encryptSecret(val);
    }
  }

  if (Object.keys(updates).length === 0) return;

  const { eq } = await import("drizzle-orm");
  await db.update(companySettings)
    .set(updates as any)
    .where(eq(companySettings.id, row.id as number));

  log(`${Object.keys(updates).length} API-Secrets verschlüsselt: ${Object.keys(updates).join(", ")}`, "startup");
}
