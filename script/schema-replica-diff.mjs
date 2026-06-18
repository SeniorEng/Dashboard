/**
 * Task #1339 — Destruktiv-Detektor für den Publish-Schema-Diff.
 *
 * Die KERN-LEHRE aus dem Preis-Cutover-Datenverlust (#1325/#1326/#1334): der
 * wirkliche DROP kam NICHT aus einer committeten `migrations/*.sql`, sondern aus
 * dem automatischen Replit-Publish-Schema-Diff (Drizzle-/Dev-Schema vs. Prod).
 * Ein Grep über die jüngste Migration übersieht genau diese Drops. Dieser Modul
 * erkennt destruktive Änderungen daher durch VERGLEICH des Ziel-Schemas (= die
 * Dev-DB, die der Publish nach Prod überträgt) gegen die read-only Prod-Replica
 * (über `PROD_DATABASE_URL`, wie der bestehende Backup-Flow).
 *
 * Aufteilung: die reine Diff-/Vertrags-Logik (`computeDestructiveSchemaDiff`,
 * `checkExpandMigrateContract`, `dropKey`, `partitionAcknowledgedDrops`) ist
 * DB-frei und unit-getestet; nur `fetchSchemaSnapshot` /
 * `detectDestructiveSchemaDiffAgainstProd` sprechen Postgres.
 */
import pg from "pg";

/**
 * Tabellen, die ein REGISTRIERTER Startup-Migrations-/Boot-Pfad noch liest oder
 * als Quelle braucht. Expand-Migrate-Contract: solange ein Boot-Schritt eine
 * Tabelle noch referenziert, darf der Publish-Diff sie NICHT droppen (sonst
 * läuft der Boot-Schritt als stiller No-Op gegen eine fehlende Quelle — exakt
 * der #1334-Datenverlust). Erst wenn KEIN Boot-Pfad die Tabelle mehr braucht,
 * darf der Drop in einem späteren Publish folgen (Contract-Phase).
 *
 * Hier MUSS jede Tabelle stehen, die ein server/startup/*-Schritt per Name
 * liest/droppt, solange dieser Schritt aktiv ist. Aktuell: die drei
 * Alt-Preis-Tabellen (gelesen von populate-prices-from-legacy /
 * drop-legacy-price-tables).
 */
export const STARTUP_MIGRATION_REFERENCED_TABLES = [
  "service_rates",
  "customer_contract_rates",
  "customer_service_prices",
];

/** Stabiler, vergleichbarer Schlüssel pro destruktiver Einzeländerung. */
export function dropKey(drop) {
  return drop.column
    ? `column:${drop.table}.${drop.column}`
    : `table:${drop.table}`;
}

/** Menschlich lesbare Beschreibung einer destruktiven Einzeländerung. */
export function describeDrop(drop) {
  return drop.column
    ? `DROP COLUMN ${drop.table}.${drop.column}`
    : `DROP TABLE ${drop.table}`;
}

/**
 * Reiner Diff: was existiert in der Prod-Replica, aber NICHT mehr im Ziel-Schema
 * (Dev/Drizzle)? Genau das würde der Publish-Schema-Diff droppen.
 *
 * Snapshot-Form: `{ [tableName]: string[] /* Spalten *\/ }`.
 * Rückgabe: `{ droppedTables: string[], droppedColumns: {table,column}[] }`.
 */
export function computeDestructiveSchemaDiff(targetSnapshot, prodSnapshot) {
  const droppedTables = [];
  const droppedColumns = [];

  for (const table of Object.keys(prodSnapshot).sort()) {
    if (!(table in targetSnapshot)) {
      // Tabelle existiert in Prod, fehlt im Ziel → Publish droppt sie.
      droppedTables.push(table);
      continue;
    }
    const targetCols = new Set(targetSnapshot[table]);
    for (const column of [...prodSnapshot[table]].sort()) {
      if (!targetCols.has(column)) {
        droppedColumns.push({ table, column });
      }
    }
  }

  return { droppedTables, droppedColumns };
}

/** Beide Diff-Hälften zu einer flachen Liste destruktiver Drops vereinen. */
export function flattenDestructiveDiff(diff) {
  return [
    ...diff.droppedTables.map((table) => ({ table })),
    ...diff.droppedColumns.map(({ table, column }) => ({ table, column })),
  ];
}

/**
 * Expand-Migrate-Contract-Prüfung: meldet jeden zu droppenden Table, der noch
 * von einem registrierten Startup-Migrations-Pfad gebraucht wird. Solche Drops
 * dürfen NICHT in diesem Publish passieren.
 */
export function checkExpandMigrateContract(
  drops,
  referencedTables = STARTUP_MIGRATION_REFERENCED_TABLES,
) {
  const referenced = new Set(referencedTables);
  const violations = [];
  for (const drop of drops) {
    // Nur ganze Table-Drops verletzen den Contract (eine noch gelesene Quelle
    // verschwindet). Spalten-Drops referenzierter Tabellen sind separat zu
    // bewerten und hier bewusst nicht abgedeckt.
    if (!drop.column && referenced.has(drop.table)) {
      violations.push(drop.table);
    }
  }
  return violations;
}

/**
 * Teilt eine Drop-Liste in bestätigte und unbestätigte auf. `ackList` ist die
 * Liste der vom Operator EXPLIZIT bestätigten Drop-Keys (siehe `dropKey`).
 */
export function partitionAcknowledgedDrops(drops, ackList) {
  const ack = new Set(ackList);
  const acknowledged = [];
  const unacknowledged = [];
  for (const drop of drops) {
    if (ack.has(dropKey(drop))) acknowledged.push(drop);
    else unacknowledged.push(drop);
  }
  return { acknowledged, unacknowledged };
}

/** `PUBLISH_ACK_DROPS` (Komma-/Whitespace-separiert) → Liste von Drop-Keys. */
export function parseAckList(raw) {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Liest das öffentliche Schema (Tabellen + Spalten) aus einer Postgres-DB.
 * Nutzt `pg` mit toleranter TLS-Einstellung (Neon-Hosts verlangen SSL).
 */
export async function fetchSchemaSnapshot(connectionString) {
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, column_name`,
    );
    const snapshot = {};
    for (const row of rows) {
      (snapshot[row.table_name] ??= []).push(row.column_name);
    }
    return snapshot;
  } finally {
    await client.end();
  }
}

/**
 * Voller Detektor: Ziel-Schema (Dev/Drizzle, via `targetUrl`/`DATABASE_URL`)
 * gegen read-only Prod-Replica (`prodUrl`/`PROD_DATABASE_URL`) diffen und die
 * destruktiven Drops + Contract-Verletzungen zurückgeben.
 *
 * Ohne `prodUrl` (kein `PROD_DATABASE_URL`) ist keine Replica-Erkennung möglich
 * → `available:false`, damit der Aufrufer das sauber als manuellen Restpunkt
 * behandeln kann (statt fälschlich „keine Drops" zu melden).
 */
export async function detectDestructiveSchemaDiffAgainstProd({
  targetUrl = process.env.DATABASE_URL,
  prodUrl = process.env.PROD_DATABASE_URL,
} = {}) {
  if (!prodUrl) {
    return { available: false, reason: "PROD_DATABASE_URL nicht gesetzt" };
  }
  if (!targetUrl) {
    return { available: false, reason: "DATABASE_URL nicht gesetzt" };
  }
  const [targetSnapshot, prodSnapshot] = await Promise.all([
    fetchSchemaSnapshot(targetUrl),
    fetchSchemaSnapshot(prodUrl),
  ]);
  const diff = computeDestructiveSchemaDiff(targetSnapshot, prodSnapshot);
  const drops = flattenDestructiveDiff(diff);
  const contractViolations = checkExpandMigrateContract(drops);
  return {
    available: true,
    ...diff,
    drops,
    contractViolations,
  };
}
