/**
 * Task #1794 — Einmalige Neu-Verschlüsselung der Firmen-Secrets nach
 * ENCRYPTION_KEY-Rotation.
 *
 * Kontext
 * -------
 * Der `ENCRYPTION_KEY` wurde auf einen brandneuen Wert rotiert (der alte Wert
 * lag im Klartext in `.replit`, jetzt in den Secrets). Alle at-rest
 * verschlüsselten Daten wurden mit dem ALTEN Schlüssel verschlüsselt und lassen
 * sich mit dem neuen Schlüssel nicht mehr entschlüsseln. Weil die
 * Entschlüsselung STILL fehlschlägt (`decryptSecret` gibt "" zurück), würde ein
 * Republish die betroffenen Felder klammheimlich leeren.
 *
 * Verschlüsselung betrifft GENAU EINE Tabelle — `company_settings` (Singleton) —
 * über die per `encryptedText(...)` deklarierten Felder (iban, bic, smtp_pass,
 * letterxpress_api_key, qonto_secret_key, whatsapp_access_token,
 * twilio_auth_token). Die Feldliste wird NICHT hartkodiert, sondern über die
 * bestehende Sensitive-Feld-Erkennung (`getSensitivePropsForTable`) ermittelt.
 *
 * Ablauf pro Feld
 * ---------------
 *   - leer/unset            → überspringen
 *   - nicht `enc:`-Präfix   → überspringen (Klartext / Pass-through)
 *   - entschlüsselt mit dem AKTUELLEN Schlüssel → bereits migriert, überspringen
 *   - entschlüsselt mit dem ALTEN Schlüssel → mit dem aktuellen Schlüssel
 *     neu verschlüsseln und für ein einziges UPDATE vormerken
 *   - weder alt noch aktuell → NICHT anfassen, explizit als unrecoverable melden
 *
 * Sicherheit
 * ----------
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in.
 *   - Der alte Schlüssel wird NIE hartkodiert, sondern kommt aus der temporären
 *     Env-Variable `OLD_ENCRYPTION_KEY` (nach Erfolg wieder entfernen).
 *   - Vor jeder Änderung wird empirisch geprüft, dass der alte Schlüssel
 *     TATSÄCHLICH ein aktuelles Feld entschlüsselt — sonst Abbruch, damit keine
 *     Daten korrumpiert werden.
 *   - `--apply` erfordert `--user=<superadmin-id>` (Audit-Attribution) UND
 *     `--reason="…"` (≥10 Zeichen, landet im Audit-Log). Der Audit-Eintrag wird
 *     in DERSELBEN Transaktion wie das UPDATE geschrieben (GoBD).
 *   - `--apply` erfordert ZUSÄTZLICH `--confirm-db=<name>`, der EXAKT dem
 *     tatsächlichen Ziel-DB-Namen (aus `DATABASE_URL`) entsprechen muss. Da das
 *     Skript bewusst in BEIDEN Umgebungen (Dev UND Prod) läuft, ist ein pauschaler
 *     Prod-Hard-Stop unmöglich; der explizite Ziel-Bestätigungs-Flag verhindert
 *     stattdessen ein versehentliches Schreiben in die falsche Datenbank.
 *   - Idempotent: Ein erneuter Lauf nach erfolgreicher Migration ist ein No-op.
 *
 * Aufruf
 * ------
 *   - Trockenlauf:  OLD_ENCRYPTION_KEY=<hex64> tsx server/scripts/reencrypt-company-secrets.ts
 *   - Scharf:       OLD_ENCRYPTION_KEY=<hex64> tsx server/scripts/reencrypt-company-secrets.ts \
 *                     --apply --user=<superadmin-id> --reason="Key-Rotation #1794" --confirm-db=<name>
 *
 * Exit-Code: 0 = nichts zu tun / erfolgreich migriert, 1 = unrecoverable Felder
 * gefunden ODER alter Schlüssel entschlüsselt nichts (Abbruch).
 */

import { createDecipheriv } from "crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { withAudit } from "../lib/with-audit";
import { companySettings, users } from "@shared/schema";
import { getSensitivePropsForTable } from "../lib/encrypted-row";
import { encryptSecret, isEncrypted } from "../lib/crypto";

const PREFIX = "enc:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MIN_PAYLOAD_LENGTH = IV_LENGTH + TAG_LENGTH;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

interface Args {
  apply: boolean;
  userId: number | undefined;
  reason: string | undefined;
  confirmDb: string | undefined;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const apply = argv.includes("--apply");
  const userArg = get("--user=");
  const userId = userArg ? parseInt(userArg, 10) : undefined;
  return {
    apply,
    userId: userId !== undefined && Number.isFinite(userId) ? userId : undefined,
    reason: get("--reason="),
    confirmDb: get("--confirm-db="),
  };
}

/** Ziel-DB-Name + Host aus DATABASE_URL (best effort, für Safety-Guard + Log). */
function resolveDbTarget(): { name: string; host: string } {
  const url = process.env.DATABASE_URL || "";
  try {
    const u = new URL(url);
    return { name: u.pathname.replace(/^\//, ""), host: u.hostname.toLowerCase() };
  } catch {
    return { name: "", host: "" };
  }
}

/**
 * Entschlüsselt einen `enc:`-Wert mit einem EXPLIZITEN Schlüssel (nicht dem
 * modul-gecachten ENCRYPTION_KEY). Gibt `null` bei jedem Fehler zurück —
 * bewusst unterscheidbar von einem leeren Klartext.
 */
function decryptWith(ciphertext: string, key: Buffer): string | null {
  if (!ciphertext || !ciphertext.startsWith(PREFIX)) return null;
  try {
    const combined = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
    if (combined.length < MIN_PAYLOAD_LENGTH) return null;
    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final("utf8");
  } catch {
    return null;
  }
}

function requireHexKey(value: string | undefined, name: string): Buffer {
  if (!value) throw new Error(`${name} ist nicht gesetzt.`);
  if (!HEX_KEY_PATTERN.test(value)) {
    throw new Error(`${name} muss ein 64-stelliger Hex-String sein (32 Bytes für AES-256).`);
  }
  return Buffer.from(value, "hex");
}

async function resolveSystemActorOrThrow(userId: number): Promise<void> {
  const [row] = await db
    .select({
      id: users.id,
      isSuperAdmin: users.isSuperAdmin,
      isActive: users.isActive,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `Die Re-Verschlüsselung (Task #1794) ist auf Superadmins beschränkt.`,
    );
  }
}

type FieldOutcome = "skip_empty" | "skip_plaintext" | "already_current" | "reencrypt" | "unrecoverable";

interface FieldResult {
  prop: string;
  outcome: FieldOutcome;
}

async function main() {
  const args = parseArgs();

  const currentKey = requireHexKey(process.env.ENCRYPTION_KEY, "ENCRYPTION_KEY");
  const oldKey = requireHexKey(process.env.OLD_ENCRYPTION_KEY, "OLD_ENCRYPTION_KEY");
  const dbTarget = resolveDbTarget();

  if (args.apply) {
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für die GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="..." (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    // Ziel-DB-Safety-Guard: das Skript läuft bewusst in Dev UND Prod, daher
    // kein pauschaler Prod-Hard-Stop, sondern eine explizite Ziel-Bestätigung.
    if (!dbTarget.name) {
      console.error(
        "Fehler: Ziel-DB-Name konnte nicht aus DATABASE_URL ermittelt werden — " +
          "Sicherheits-Guard kann das Schreibziel nicht bestätigen. Abbruch.",
      );
      process.exit(1);
    }
    if (args.confirmDb !== dbTarget.name) {
      console.error(
        `Fehler: --apply erfordert --confirm-db=<name>, der dem tatsächlichen Ziel entspricht.\n` +
          `  Ziel-DB (aus DATABASE_URL): "${dbTarget.name}" @ ${dbTarget.host || "?"}\n` +
          `  Übergeben:                  ${args.confirmDb ? `"${args.confirmDb}"` : "(fehlt)"}\n` +
          `  Schutz gegen versehentliches Schreiben in die falsche Datenbank.`,
      );
      process.exit(1);
    }
    await resolveSystemActorOrThrow(args.userId);
  }

  console.log(`\n=== Firmen-Secrets Re-Verschlüsselung · Task #1794 ===`);
  console.log(`Modus: ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only)"}`);
  console.log(`Ziel-DB: "${dbTarget.name || "(unbekannt)"}" @ ${dbTarget.host || "(unbekannt)"}`);
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  const rows = await db.select().from(companySettings).orderBy(asc(companySettings.id)).limit(1);
  if (rows.length === 0) {
    console.log("\nKeine company_settings-Zeile vorhanden — nichts zu tun.");
    process.exit(0);
  }
  const row = rows[0] as Record<string, unknown>;
  const rowId = row.id as number;
  const sensitiveProps = getSensitivePropsForTable(companySettings);

  const results: FieldResult[] = [];
  const updates: Record<string, string> = {};
  let oldKeyProved = false;

  for (const prop of sensitiveProps) {
    const val = row[prop];
    if (typeof val !== "string" || !val) {
      results.push({ prop, outcome: "skip_empty" });
      continue;
    }
    if (!isEncrypted(val)) {
      results.push({ prop, outcome: "skip_plaintext" });
      continue;
    }
    // Bereits unter dem aktuellen Schlüssel lesbar → nichts tun (idempotent).
    if (decryptWith(val, currentKey) !== null) {
      results.push({ prop, outcome: "already_current" });
      continue;
    }
    // Unter dem alten Schlüssel lesbar → neu verschlüsseln.
    const plaintextOld = decryptWith(val, oldKey);
    if (plaintextOld !== null) {
      oldKeyProved = true;
      updates[prop] = encryptSecret(plaintextOld);
      results.push({ prop, outcome: "reencrypt" });
      continue;
    }
    // Weder alt noch aktuell → NICHT anfassen, explizit melden.
    results.push({ prop, outcome: "unrecoverable" });
  }

  const label: Record<FieldOutcome, string> = {
    skip_empty: "leer/unset — übersprungen",
    skip_plaintext: "Klartext (kein enc:) — übersprungen",
    already_current: "bereits unter neuem Schlüssel — übersprungen",
    reencrypt: "→ NEU verschlüsseln (alt → neu)",
    unrecoverable: "‼ NICHT wiederherstellbar (weder alt noch neu)",
  };

  console.log(`\nFelder (${sensitiveProps.length}):`);
  for (const r of results) console.log(`  ${r.prop.padEnd(22)} ${label[r.outcome]}`);

  const toReencrypt = results.filter((r) => r.outcome === "reencrypt").map((r) => r.prop);
  const unrecoverable = results.filter((r) => r.outcome === "unrecoverable").map((r) => r.prop);
  const anyEncrypted = results.some(
    (r) => r.outcome === "reencrypt" || r.outcome === "already_current" || r.outcome === "unrecoverable",
  );

  // Empirischer Schutz: Wenn es überhaupt verschlüsselte Felder gibt, aber der
  // alte Schlüssel KEINES davon entschlüsselt und auch der aktuelle Schlüssel
  // nichts löst, ist der OLD_ENCRYPTION_KEY vermutlich falsch → Abbruch.
  const anyAlreadyCurrent = results.some((r) => r.outcome === "already_current");
  if (anyEncrypted && !oldKeyProved && !anyAlreadyCurrent) {
    console.error(
      "\n‼ Abbruch: Der OLD_ENCRYPTION_KEY entschlüsselt KEIN einziges Feld und " +
        "kein Feld ist bereits unter dem neuen Schlüssel lesbar.\n" +
        "  Vermutlich ist der alte Schlüssel falsch. Es wurde NICHTS geschrieben.",
    );
    process.exit(1);
  }

  if (unrecoverable.length > 0) {
    console.error(
      `\n‼ ${unrecoverable.length} Feld(er) sind mit keinem der Schlüssel lesbar: ` +
        `${unrecoverable.join(", ")}.\n  Diese werden NICHT verändert (kein stilles Leeren).`,
    );
  }

  if (toReencrypt.length === 0) {
    console.log("\n✓ Nichts neu zu verschlüsseln (alles bereits auf dem neuen Schlüssel oder leer).");
    process.exit(unrecoverable.length > 0 ? 1 : 0);
  }

  if (!args.apply) {
    console.log(
      `\nHinweis: Trockenlauf — keine Änderungen geschrieben. ${toReencrypt.length} Feld(er) würden neu ` +
        `verschlüsselt.\n  Scharf: OLD_ENCRYPTION_KEY=… --apply --user=<superadmin-id> --reason="…"`,
    );
    process.exit(unrecoverable.length > 0 ? 1 : 0);
  }

  await withAudit(async (tx, audit) => {
    await tx.update(companySettings).set(updates as any).where(eq(companySettings.id, rowId));
    audit.record({
      userId: args.userId!,
      action: "company_secrets_reencrypted",
      entityType: "company_settings",
      entityId: rowId,
      metadata: {
        reason: args.reason,
        reencryptedFields: toReencrypt,
        unrecoverableFields: unrecoverable,
        task: "1794",
      },
    });
  }, {});

  console.log(`\n✓ ${toReencrypt.length} Feld(er) neu verschlüsselt: ${toReencrypt.join(", ")}`);
  console.log(
    "  Nächster Schritt: Integrationen verifizieren, dann OLD_ENCRYPTION_KEY aus der Umgebung entfernen.",
  );
  process.exit(unrecoverable.length > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
