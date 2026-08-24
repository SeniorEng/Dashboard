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
 *   - `--apply` erfordert eine ausdrueckliche ZIELKLASSE: `--target=prod`
 *     oder `--target=dev`. Sie wird NICHT abgeleitet — sonst haenge die
 *     Sicherheitsstufe an einem vergessenen Flag.
 *       · `--target=prod` verlangt `--confirm-target=<host>/<datenbank>`,
 *         `--user`, `--reason`, `NODE_ENV=production` und ein gesetztes
 *         `PROD_DATABASE_URL`.
 *       · `--target=dev`  verlangt `DEV_WRITE_CONFIRM_TARGET=<host>/<datenbank>`
 *         und ebenfalls ein gesetztes `PROD_DATABASE_URL` (fuer den
 *         Prod-Reject) sowie `--user` (Aktor-Pruefung).
 *     Der Datenbankname wird in BEIDEN Faellen an der OFFENEN Verbindung
 *     geprueft, nicht aus der URL gelesen — das frueher hier stehende
 *     `--confirm-db=<name>` tat genau das und war damit der Defekt vom
 *     18.08.2026.
 *     ACHTUNG: `docs/pre-publish-backup-runbook.md` weist an,
 *     `PROD_DATABASE_URL` nach dem Backup zu `unset`en. Fuer diesen Lauf muss
 *     sie WIEDER gesetzt sein.
 *   - Idempotent: Ein erneuter Lauf nach erfolgreicher Migration ist ein No-op.
 *
 * Aufruf
 * ------
 *   - Trockenlauf:  OLD_ENCRYPTION_KEY=<hex64> tsx server/scripts/reencrypt-company-secrets.ts
 *   - Scharf:       OLD_ENCRYPTION_KEY=<hex64> tsx server/scripts/reencrypt-company-secrets.ts \
 *                     --apply --target=prod --user=<superadmin-id> \
 *                     --reason="Key-Rotation #1794" --confirm-target=<host>/<datenbank>
 *
 * Exit-Code: 0 = nichts zu tun / erfolgreich migriert, 1 = unrecoverable Felder
 * gefunden ODER alter Schlüssel entschlüsselt nichts (Abbruch).
 */

import { createDecipheriv } from "crypto";
import { dbHostOf, dbNameOf } from "@shared/ephemeral-db-target";
import { asc, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { withAudit } from "../lib/with-audit";
import { companySettings, users } from "@shared/schema";
import { getSensitivePropsForTable } from "../lib/encrypted-row";
import { encryptSecret, isEncrypted } from "../lib/crypto";
import { assertDualTargetOrThrow } from "./lib/dual-target-gate";
import { parseProdWriteArgs } from "./lib/prod-write-gate";

const PREFIX = "enc:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MIN_PAYLOAD_LENGTH = IV_LENGTH + TAG_LENGTH;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Die gemeinsamen Flags kommen aus der SSoT `parseProdWriteArgs` — inklusive
 * `--target`. Der frueher hier stehende lokale Leser benutzte
 * `.split("=")[1]` und schnitt eine Begruendung am ERSTEN `=` ab; der
 * abgeschnittene Text landete im Audit-Log (siehe PR #119).
 */
type Args = ReturnType<typeof parseProdWriteArgs>;

function parseArgs(): Args {
  return parseProdWriteArgs(process.argv);
}

/** Ziel-DB-Name + Host aus DATABASE_URL (best effort, für Safety-Guard + Log). */
function resolveDbTarget(): { name: string; host: string } {
  // ERSETZT das lokale `new URL(...)` durch die SSoT. Die Eigenform kannte
  // weder den Regex-Fallback noch die Uneinigkeits-Pruefung aus W3 — sie
  // haette aus `postgres://u:p?x@host/db` still den BENUTZERNAMEN als Host
  // geliefert, waehrend psql zu einem anderen Ziel faehrt.
  const url = process.env.DATABASE_URL || "";
  return { name: dbNameOf(url) ?? "", host: dbHostOf(url) ?? "" };
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
    // Ziel-Gate. ERSETZT das eigene `--confirm-db=<name>`, das den Namen aus
    // der DATABASE_URL las — genau der Defekt vom 18.08.2026: die URL sagte
    // `neondb`, verbunden war `heliumdb`.
    //
    // Dieses Skript laeuft bewusst in BEIDEN Umgebungen (Key-Rotation passiert
    // in Dev wie Prod), deshalb das Dual-Target-Gate: der Operator NENNT die
    // Klasse (`--target=prod|dev`), und beide Wege pruefen den Datenbanknamen
    // an der OFFENEN Verbindung.
    const freigabe = await assertDualTargetOrThrow(
      // Direkt durchgereicht. Vorher `{ ...args, target: args.target }` — der
      // Spread trug `target` laengst, die Wiederholung suggerierte nur, das
      // Feld brauche eine Sonderbehandlung.
      args,
      "Der Lauf verschluesselt Firmen-Secrets neu (at-rest, AES-256-GCM).",
    );
    console.log(`Ziel-Klasse: ${freigabe.klasse} · bestaetigt: ${freigabe.ziel}`);
    // Der Prod-Zweig prueft den Superadmin im Gate. Der Dev-Zweig nicht — er
    // kennt keine Aktor-Frage. Ohne diese Zeile waere `resolveSystemActorOrThrow`
    // still verwaist und ein beliebiger (existierender) Nicht-Superadmin haette
    // sich in den Audit-Eintrag geschrieben; eine nicht existierende Id waere
    // erst an der Fremdschluessel-Bedingung gekippt, mitten in der Transaktion.
    if (freigabe.klasse === "dev") {
      await resolveSystemActorOrThrow(args.userId);
    }
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
  /** prop -> Klartext aus dem ALTEN Schluessel, fuer die Post-Write-Verifikation. */
  const klartextVorher = new Map<string, string>();
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
      // Klartext merken: die Post-Write-Verifikation vergleicht spaeter gegen
      // ihn. Ohne diesen Vergleich pruefte sie nur "irgendetwas ist lesbar",
      // nicht "es ist DASSELBE".
      klartextVorher.set(prop, plaintextOld);
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

    // ── Post-Write-Verifikation, IN der Transaktion ───────────────────────
    //
    // Das Ziel-Gate deckt die falsche DATENBANK ab. Es deckt NICHT den
    // falschen SCHLUESSEL ab — und der ist hier der teurere Fehler: ein
    // Chiffrat, das mit einem falschen `ENCRYPTION_KEY` geschrieben wurde,
    // ist mit KEINEM Schluessel mehr lesbar. Das laesst sich durch keinen
    // zweiten Lauf reparieren.
    //
    // Der Pre-Flight oben beweist, dass der ALTE Schluessel echt ist. Er
    // beweist NICHT, dass der aktuelle Schluessel etwas Lesbares erzeugt —
    // `encryptSecret` nimmt jeden 64-hex-Wert an, auch einen vertippten.
    // Deshalb hier: zurueckLESEN, was gerade geschrieben wurde, und mit dem
    // aktuellen Schluessel entschluesseln. Ergebnis muss dem Klartext
    // entsprechen, der aus dem alten Schluessel kam.
    //
    // Ein `throw` rollt die Transaktion zurueck — inklusive des
    // Audit-Eintrags. Lieber kein Lauf als ein halber.
    const [nachher] = await tx
      .select()
      .from(companySettings)
      .where(eq(companySettings.id, rowId))
      .limit(1);
    if (!nachher) {
      throw new Error("ABBRUCH: Zeile nach dem UPDATE nicht mehr lesbar. Rollback.");
    }
    const kaputt: string[] = [];
    for (const prop of toReencrypt) {
      const geschrieben = (nachher as Record<string, unknown>)[prop];
      const zurueck =
        typeof geschrieben === "string" ? decryptWith(geschrieben, currentKey) : null;
      if (zurueck === null || zurueck !== klartextVorher.get(prop)) {
        kaputt.push(prop);
      }
    }
    if (kaputt.length > 0) {
      throw new Error(
        `ABBRUCH: ${kaputt.length} Feld(er) sind nach der Neu-Verschluesselung NICHT ` +
          `mit dem aktuellen Schluessel lesbar bzw. weichen vom Klartext ab: ` +
          `${kaputt.join(", ")}.\n` +
          `Die Transaktion wird zurueckgerollt — die alten Chiffrate bleiben erhalten.\n` +
          `Pruefen: ist ENCRYPTION_KEY wirklich der Schluessel, unter dem die App laeuft?`,
      );
    }
    console.log(`  Post-Write-Verifikation: ${toReencrypt.length} Feld(er) zurueckgelesen, alle lesbar.`);

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
