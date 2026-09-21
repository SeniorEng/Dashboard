import {
  checkPrePublishBackup,
  printPrePublishBackupResult,
} from "./check-pre-publish-backup.mjs";
import {
  detectDestructiveSchemaDiffAgainstProd,
  flattenDestructiveDiff,
  partitionAcknowledgedDrops,
  parseAckList,
  describeDrop,
  dropKey,
  checkExpandMigrateContract,
} from "./schema-replica-diff.mjs";

const items = [];

function record(label, status, hint) {
  items.push({ label, status, hint });
}

const result = await checkPrePublishBackup();

// --- Destruktiv-Detektion: Migration-Grep (Legacy) + Schema-vs-Prod-Replica. ---
// Der Grep über die jüngste Migration ist nur ein Teilbild — der echte
// #1334-Drop kam aus dem Publish-Schema-Diff. Daher zusätzlich Dev-Schema gegen
// die read-only Prod-Replica diffen (Task #1339).
let replica = { available: false, reason: "nicht ausgeführt" };
try {
  replica = await detectDestructiveSchemaDiffAgainstProd();
} catch (err) {
  replica = { available: false, reason: `Replica-Diff fehlgeschlagen: ${err?.message ?? err}` };
}

const migrationDrops = (result.destructive ?? []).map((stmt) => ({ statement: stmt }));
const replicaDrops = replica.available ? flattenDestructiveDiff(replica) : [];
const hasDestructive = migrationDrops.length > 0 || replicaDrops.length > 0;

// --- (a) Harte Backup-Sperre. ---
//
// „Nichts gefunden" darf NUR dann grün sein, wenn auch nachgesehen wurde.
//
// Vorher stand hier ein `[✓] Keine destruktiven Schema-Änderungen erkannt`
// samt `[✓] Pre-Publish-Backup nicht zwingend nötig`, sobald beide Listen leer
// waren — und `replicaDrops` ist leer, wenn der Diff gar nicht LIEF
// (`replica.available === false` ⇒ `[]`). Aus dem Ausfall der einzigen
// Prüfung, die Dev gegen Prod stellt, wurde damit ein Häkchen plus die
// Empfehlung, das Backup wegzulassen.
//
// Das ist die Mechanik des 10.08.2026-Incidents: eine übersprungene Prüfung,
// die als bestanden ausgewiesen wird, ist gefährlicher als eine, die rot wird.
// `schema-replica-diff.mjs` meldet `available:false` ausdrücklich, damit der
// Aufrufer es „als manuellen Restpunkt behandeln kann (statt fälschlich
// ,keine Drops' zu melden)" — genau das wurde hier nicht getan.
//
// Zweite Hälfte desselben Problems: der Migrations-Grep ist bei `push` PER
// KONSTRUKTION blind (`drizzle-kit push` schreibt keine Migrationsdateien,
// siehe CLAUDE.md). Ohne Replica-Diff ist also nicht „die Hälfte" der Evidenz
// da, sondern keine. Deshalb nennt die Beschriftung jetzt die Quelle, die
// tatsächlich gelaufen ist, statt beide aufzuzählen.
// Was verglichen wurde, gehört auf den Schirm — nicht nur DASS verglichen wurde.
// Host + `current_database()` aus der OFFENEN Verbindung, nie der
// Connection-String (CLAUDE.md). Ohne diese Zeile ist „gemessen" eine
// Behauptung, die der Operator nicht nachprüfen kann; mit ihr sieht er sofort,
// wenn die Prod-Seite gar nicht Prod ist.
if (replica.identity) {
  record(
    "Verglichen wurde",
    replica.available ? "ok" : "fail",
    `Ziel ${replica.identity.target.host}/${replica.identity.target.database}`
      + ` gegen Prod ${replica.identity.prod.host}/${replica.identity.prod.database}`,
  );
} else {
  // Alriks zweite Bedingung für den ersten Prod-Lauf (18.09.2026), wörtlich:
  // „ein grünes Ergebnis ohne sichtbaren Vergleich gilt nicht als bestanden,
  // sondern als ungeklärt."
  //
  // Ohne Identität wurde keine Verbindung geöffnet — dann gibt es nichts zu
  // beurteilen. Der Riegel steht hier BEWUSST eigenständig und nicht als
  // Folge der anderen Zweige: er hält auch dann, wenn jemand später einen
  // dieser Zweige umbaut. Heute überlappt er mit dem „nicht gemessen"-Fall
  // unten; das ist Absicht, nicht Redundanz aus Versehen.
  record(
    "Verglichen wurde — NICHTS",
    "fail",
    "Es liegt keine Verbindungs-Identität vor, es wurde also keine Prod-Verbindung "
      + "geöffnet. Ein Ergebnis ohne sichtbaren Vergleich ist ungeklärt, nicht bestanden.",
  );
}

if (!hasDestructive && replica.available) {
  record(
    "Keine destruktiven Schema-Änderungen erkannt (Migration-Grep + Prod-Replica-Diff)",
    "ok",
    // Die Dateiangabe NICHT nackt: sie nennt die jüngste Datei in
    // `migrations/`, und die ist auf dem `push`-Pfad per Konstruktion alt —
    // `drizzle-kit push` schreibt keine Migrationsdateien (CLAUDE.md). Beim
    // ersten Prod-Lauf am 18.09.2026 stand dort `0001_right_scrambler.sql` vom
    // 09.08., also fünf Wochen alt, und las sich wie der Prüfgegenstand.
    // Dieselbe Klasse wie eine Beschreibung, die einen überholten Zustand
    // behauptet: sie wird als Beleg gelesen.
    `Belegt durch den Prod-Replica-Diff. Der Migrations-Grep steuert hier nichts `
      + `bei — bei \`drizzle-kit push\` entstehen keine Migrationsdateien, er ist `
      + `dafür blind (jüngste vorhandene: ${result.latestMigration ?? "keine"}).`,
  );
  record(
    "Pre-Publish-Backup nicht zwingend nötig (keine DROP-Statements)",
    "ok",
    "Trotzdem: bei Daten-Migrationen oder neuen NOT-NULL-Constraints manuell prüfen.",
  );
} else if (!hasDestructive) {
  record(
    "Schema-Diff gegen Prod NICHT gemessen — „keine Drops\" ist hier unbelegt",
    "fail",
    `${replica.reason}. Der Migrations-Grep allein beweist nichts: bei `
      + `\`drizzle-kit push\` entstehen keine Migrationsdateien, er ist dafür blind `
      + `(jüngste Migration: ${result.latestMigration ?? "keine"}). `
      + "PROD_DATABASE_URL aus dem Publishing-Tab setzen, erneut ausführen, danach wieder unset.",
  );
  record(
    "Pre-Publish-Backup vorhanden",
    result.recentBackup ? "ok" : "fail",
    result.recentBackup
      ? `Datei: ${result.recentBackup.path}`
      : "Ohne gemessenen Schema-Diff ist das Backup NICHT optional — die Aussage, "
        + "die es entbehrlich machen würde, ist ungeprüft. Ausführen: bash scripts/backup-prod-db.sh",
  );
} else {
  if (migrationDrops.length > 0) {
    record(
      "Jüngste Migration enthält destruktive Statements",
      "warn",
      `Migration: ${result.latestMigration} (${migrationDrops.length} DROP-Statement(s))`,
    );
  }
  if (replica.available && replicaDrops.length > 0) {
    record(
      "Prod-Replica-Diff: Schema-Diff würde Objekte droppen",
      "warn",
      `${replica.droppedTables.length} Tabelle(n), ${replica.droppedColumns.length} Spalte(n)`,
    );
  }
  if (!replica.available) {
    record(
      "Prod-Replica-Diff NICHT verfügbar — destruktive Drops könnten unentdeckt bleiben",
      "fail",
      `${replica.reason}. PROD_DATABASE_URL aus dem Publishing-Tab setzen und erneut ausführen.`,
    );
  }

  // (a) Backup-Sperre: destruktiv + kein frisches Backup < 24 h ⇒ blockierend.
  if (result.recentBackup) {
    record(
      "Aktuelles Pre-Publish-Backup vorhanden (< 24 h)",
      "ok",
      `Datei: ${result.recentBackup.path}`,
    );
  } else {
    record(
      "Aktuelles Pre-Publish-Backup vorhanden (< 24 h)",
      "fail",
      "BLOCKIEREND: destruktive Schema-Änderungen anstehend, aber kein frisches Backup. Ausführen: bash scripts/backup-prod-db.sh",
    );
  }

  // --- (d) Jeden DROP einzeln auflisten + explizite Bestätigung verlangen. ---
  const ackList = parseAckList(process.env.PUBLISH_ACK_DROPS);
  const { acknowledged, unacknowledged } = partitionAcknowledgedDrops(replicaDrops, ackList);
  if (replicaDrops.length > 0) {
    console.log("");
    console.log("Destruktive Schema-Diffs (jeder Eintrag braucht explizite Bestätigung):");
    for (const drop of replicaDrops) {
      const acked = acknowledged.includes(drop);
      console.log(`  [${acked ? "✓" : " "}] ${describeDrop(drop)}   (Key: ${dropKey(drop)})`);
    }
    if (unacknowledged.length > 0) {
      record(
        "Jeder destruktive DROP einzeln bestätigt (PUBLISH_ACK_DROPS)",
        "fail",
        `${unacknowledged.length} unbestätigt. Setze PUBLISH_ACK_DROPS mit den fehlenden Keys: ${unacknowledged.map(dropKey).join(",")}`,
      );
    } else {
      record(
        "Jeder destruktive DROP einzeln bestätigt (PUBLISH_ACK_DROPS)",
        "ok",
        `${acknowledged.length} Drop(s) bestätigt.`,
      );
    }
  }

  // --- (c) Expand-Migrate-Contract: keine noch referenzierte Tabelle droppen. ---
  const contractViolations = replica.available
    ? checkExpandMigrateContract(replicaDrops)
    : [];
  if (contractViolations.length > 0) {
    record(
      "Expand-Migrate-Contract: kein Drop einer noch von Startup-Migrationen genutzten Tabelle",
      "fail",
      `Verletzt durch: ${contractViolations.join(", ")}. Diese Tabelle(n) werden beim Boot noch gelesen — erst Contract-Phase (Boot-Pfad entfernen), dann Drop.`,
    );
  } else if (replica.available && replicaDrops.length > 0) {
    record(
      "Expand-Migrate-Contract eingehalten",
      "ok",
      "Keine zu droppende Tabelle wird noch von einem Startup-Migrations-Pfad referenziert.",
    );
  }
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

// (a) BLOCKIEREND: Exit≠0, sobald ein automatischer Check fehlschlägt — der
// Operator-Preflight ist damit kein bloßer Reminder mehr (die reine
// Build-Warnung in check-build.mjs bleibt bewusst non-blocking).
process.exit(hasFail ? 1 : 0);
