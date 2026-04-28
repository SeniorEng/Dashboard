import {
  checkPrePublishBackup,
  printPrePublishBackupResult,
} from "./check-pre-publish-backup.mjs";

const items = [];

function record(label, status, hint) {
  items.push({ label, status, hint });
}

const result = await checkPrePublishBackup();

if (result.status === "no-destructive-change") {
  record(
    "Letzte Migration enthält keine destruktiven Änderungen",
    "ok",
    `Migration: ${result.latestMigration ?? "keine"}`,
  );
  record(
    "Pre-Publish-Backup nicht zwingend nötig (keine DROP-Statements)",
    "ok",
    "Trotzdem: bei Daten-Migrationen oder neuen NOT-NULL-Constraints manuell prüfen.",
  );
} else if (result.status === "ok") {
  record(
    "Letzte Migration enthält destruktive Änderungen",
    "warn",
    `Migration: ${result.latestMigration} (${result.destructive.length} DROP-Statement(s))`,
  );
  record(
    "Aktuelles Pre-Publish-Backup vorhanden (< 24 h)",
    "ok",
    `Datei: ${result.recentBackup.path}`,
  );
} else {
  record(
    "Letzte Migration enthält destruktive Änderungen",
    "warn",
    `Migration: ${result.latestMigration} (${result.destructive.length} DROP-Statement(s))`,
  );
  record(
    "Pre-Publish-Backup vorhanden (< 24 h)",
    "fail",
    "Bitte vor dem Publish ausführen: bash scripts/backup-prod-db.sh",
  );
}

record(
  "Replit/Neon-Auto-Backup im Workspace verifiziert (≤ 1 h alt)",
  "manual",
  "Tools → Database → Backups / History — Snapshot-Alter prüfen.",
);
record(
  "Eintrag in docs/deployment-log.md ergänzt",
  "manual",
  "Pflicht laut docs/pre-publish-backup-runbook.md §5.",
);
record(
  "PROD_DATABASE_URL nach dem Backup wieder unset gesetzt",
  "manual",
  "unset PROD_DATABASE_URL — Secret nicht in Shell-History stehen lassen.",
);

const icons = {
  ok: "[ ✓ ]",
  warn: "[ ! ]",
  fail: "[ ✗ ]",
  manual: "[ ? ]",
};

console.log("");
console.log("Pre-Publish-Checkliste");
console.log("=======================");
for (const item of items) {
  console.log(`${icons[item.status] ?? "[ - ]"} ${item.label}`);
  if (item.hint) console.log(`        ${item.hint}`);
}
console.log("");

const hasFail = items.some((i) => i.status === "fail");
const hasManual = items.some((i) => i.status === "manual");

if (hasFail) {
  console.log(
    "→ Status: NICHT bereit für Publish. Bitte fehlende Schritte oben nachholen.",
  );
} else if (hasManual) {
  console.log(
    "→ Status: Automatische Checks ok. Bitte die manuellen Punkte ([ ? ]) noch bestätigen, dann ist Publish freigegeben.",
  );
} else {
  console.log("→ Status: Bereit für Publish.");
}
console.log("");

printPrePublishBackupResult(result, { quietWhenOk: true });

process.exit(0);
