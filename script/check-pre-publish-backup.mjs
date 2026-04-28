import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";

const MIGRATIONS_DIR = "migrations";
const BACKUP_DIR = "tmp/db-backups";
const RUNBOOK = "docs/pre-publish-backup-runbook.md";
const BACKUP_SCRIPT = "scripts/backup-prod-db.sh";

const DESTRUCTIVE_PATTERN = /\bDROP\s+(COLUMN|TABLE)\b/i;
const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

export async function findLatestMigration() {
  let entries;
  try {
    entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const sqls = entries
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();
  return sqls.length === 0 ? null : sqls[sqls.length - 1];
}

export async function migrationDestructiveStatements(filename) {
  if (!filename) return [];
  const content = await readFile(join(MIGRATIONS_DIR, filename), "utf-8");
  const matches = [];
  for (const rawLine of content.split("\n")) {
    const stripped = rawLine.replace(/--.*$/, "").trim();
    if (!stripped) continue;
    if (DESTRUCTIVE_PATTERN.test(stripped)) {
      matches.push(stripped);
    }
  }
  return matches;
}

export async function findRecentBackup(now = Date.now()) {
  let entries;
  try {
    entries = await readdir(BACKUP_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(BACKUP_DIR, entry.name);
    let st;
    try {
      st = await stat(fullPath);
    } catch {
      continue;
    }
    const ageMs = now - st.mtimeMs;
    if (ageMs <= MAX_BACKUP_AGE_MS && (!newest || st.mtimeMs > newest.mtimeMs)) {
      newest = { path: fullPath, mtimeMs: st.mtimeMs, ageMs };
    }
  }
  return newest;
}

export async function checkPrePublishBackup({ now = Date.now() } = {}) {
  const latest = await findLatestMigration();
  const destructive = await migrationDestructiveStatements(latest);
  const hasDrop = destructive.length > 0;
  const recentBackup = hasDrop ? await findRecentBackup(now) : null;

  let status;
  if (!hasDrop) status = "no-destructive-change";
  else if (recentBackup) status = "ok";
  else status = "missing-backup";

  return { status, latestMigration: latest, destructive, recentBackup };
}

function formatAge(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} Sek.`;
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return `${Math.round(ms / 60_000)} Min.`;
  return `${hours.toFixed(1)} h`;
}

export function printPrePublishBackupResult(result, { quietWhenOk = false } = {}) {
  if (result.status === "no-destructive-change") {
    if (!quietWhenOk) {
      console.log(
        `✓ Pre-Publish-Backup-Check: Letzte Migration (${result.latestMigration ?? "keine"}) enthält keine DROP COLUMN/DROP TABLE.`,
      );
    }
    return;
  }
  if (result.status === "ok") {
    if (!quietWhenOk) {
      console.log(
        `✓ Pre-Publish-Backup vorhanden: ${result.recentBackup.path} (Alter: ${formatAge(result.recentBackup.ageMs)})`,
      );
    }
    return;
  }
  const lines = [
    "",
    "============================================================",
    "⚠️  PRE-PUBLISH-BACKUP FEHLT — bitte vor dem Publish nachholen!",
    "============================================================",
    `Letzte Migration: ${result.latestMigration}`,
    "Enthält destruktive Schema-Änderungen:",
    ...result.destructive.slice(0, 10).map((m) => `  - ${m}`),
    "",
    `In ${BACKUP_DIR}/ wurde keine Datei gefunden, die jünger als 24 Stunden ist.`,
    "(Backups werden bewusst nicht eingecheckt; der Build bricht deshalb NICHT ab.)",
    "",
    "Empfohlene Schritte vor dem Publish:",
    `  1. PROD_DATABASE_URL aus dem Replit Publishing-Tab setzen.`,
    `  2. bash ${BACKUP_SCRIPT}`,
    `  3. Dump lokal/extern sichern und Eintrag in docs/deployment-log.md ergänzen.`,
    `  4. Vollständige Checkliste: ${RUNBOOK}`,
    "============================================================",
    "",
  ];
  console.warn(lines.join("\n"));
}

const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const result = await checkPrePublishBackup();
  printPrePublishBackupResult(result);
  process.exit(0);
}
