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
 * Leitet die `pg`-SSL-Option aus dem Connection-String ab.
 *
 * WICHTIG, gemessen (Gate-2-Notiz N5 zu #154): bei EXPLIZITEM `sslmode` im
 * Connection-String erreicht dieser Rückgabewert den Socket gar nicht — `pg`
 * baut seine Config als `Object.assign({}, config, parse(connectionString))`,
 * der geparste Wert gewinnt also. Wirksam ist unsere Entscheidung nur dort, wo
 * der String KEIN `sslmode` trägt; die Zweige mit `sslmode` beschreiben, was
 * wir wollten, und stimmen mit dem überein, was `pg` daraus ohnehin macht.
 * Der Rückgabewert ist trotzdem korrekt zu halten — er ist die Aussage dieses
 * Moduls, und ein künftiger Aufrufer ausserhalb von `pg` läse sie.
 * Lokale/Proxy-DBs ohne TLS (`sslmode=disable`, z.B. die Wegwerf-Test-DBs auf
 * dem lokalen Postgres) DÜRFEN NICHT mit erzwungenem SSL verbunden werden —
 * `pg` bricht sonst gegen einen Server ohne SSL hart ab. Damit ist der echte
 * DB-Fetch-Pfad integration-testbar, ohne das Prod-Verhalten zu ändern.
 */
export function resolveSchemaSnapshotSsl(connectionString) {
  try {
    const url = new URL(connectionString);
    const modus = url.searchParams.get("sslmode");
    if (modus === "disable") return false;
    // Ausdrücklich verlangtes SSL schlägt die Host-Regel darunter.
    if (modus) return { rejectUnauthorized: false };

    // OHNE `sslmode` entscheidet der Host. Das ERSETZT „ohne Parameter immer
    // SSL" — eine Regel, an der die Zusage im Absatz darüber („damit ist der
    // echte DB-Fetch-Pfad integration-testbar") seit jeher scheiterte:
    // `.env.test.local` und der CI-`postgres:16` tragen keinen `sslmode`, also
    // wurde SSL erzwungen, der Server kann keins, und
    // `tests/startup/schema-replica-diff-live.test.ts` brach im `beforeAll` ab
    // und ÜBERSPRANG sich still — gemessen am 18.09.2026: 5 von 5 Fällen
    // skipped, ohne eine einzige rote Zeile.
    //
    // Eine Loopback-Verbindung zu einem Wegwerf-Container braucht kein TLS.
    // Jeder andere Host bekommt es weiterhin, auch ohne Parameter — Prod-Neon
    // verhält sich damit unverändert.
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      return false;
    }
  } catch {
    // Kein parsebarer URL → konservativ tolerantes SSL.
  }
  return { rejectUnauthorized: false };
}

/**
 * Host einer Verbindung — OHNE Benutzer, Passwort, Port, Pfad.
 *
 * Die `DATABASE_URL` wird nie ausgegeben (CLAUDE.md). Der Hostname allein ist
 * kein Geheimnis und ist die einzige Hälfte der Identität, die vor dem
 * Verbinden feststeht; die andere (`current_database()`) kommt aus der OFFENEN
 * Verbindung — dieselbe Quelle, gegen die das Prod-Schreib-Gate vergleicht.
 *
 * ── `hostname`, NICHT `host` (Gate-2-Fund S1 zu #154) ────────────────────
 * Die erste Fassung nahm `.host`. Das hatte zwei Fehler auf einmal, beide
 * gemessen:
 *
 *  1. **Es konnte das Passwort auf den Schirm bringen.** `.host` trägt den
 *     Port mit, und bei unkodiertem `#` in der userinfo wandert ein Stück des
 *     Passworts genau dorthin:
 *     `new URL("postgres://user:12345#x@prod.example.com/db").host === "user:12345"`.
 *     Die Checkliste hätte „Verglichen wurde … user:12345/neondb" gedruckt.
 *  2. **Es schwächte den Identitätsriegel.** Mit Port verglichen gilt
 *     `host:5432` als verschieden von `host` — zwei Schreibweisen derselben
 *     Datenbank wären als echter Vergleich durchgegangen, und der leere Diff
 *     hätte wieder „keine Drops" geheißen. Das ist die unsichere Richtung.
 *
 * Beides verschwindet mit `hostname`. Der Port geht dabei absichtlich
 * verloren: er unterscheidet keine zwei Datenbanken, die wir auseinanderhalten
 * müssten, und er ist die Stelle, an der das Passwort landen kann.
 *
 * ── Warum das nicht die vorhandene SSoT benutzt ──────────────────────────
 * `shared/ephemeral-db-target.ts` hält mit `dbHostOf`/`istLoopback` die
 * gründlichere Fassung (Parser-Uneinigkeits-Riegel, alle Loopback-
 * Schreibweisen). **Sie ist von hier aus nicht importierbar:** diese Datei ist
 * `.mjs` und läuft im Release-Pfad unter blankem `node`, ohne
 * TypeScript-Transformation. Das ist der Grund, und er steht hier, damit die
 * Doppelung nicht wie Nachlässigkeit aussieht. Ein Paritäts-Wächter fehlt —
 * als FINDING vermerkt.
 */
export function connectionHost(connectionString) {
  try {
    return new URL(connectionString).hostname.toLowerCase() || "(kein Host)";
  } catch {
    return "(unlesbarer Connection-String)";
  }
}

/**
 * Zeigen zwei Verbindungen auf dieselbe Datenbank?
 *
 * ── Warum das hier steht ─────────────────────────────────────────────────
 * Der Detektor vergleicht ZWEI Schnappschüsse. Sind beide Connection-Strings
 * dieselbe Datenbank — etwa weil die Dev-URL versehentlich auch als
 * `PROD_DATABASE_URL` gesetzt wurde —, ist der Diff per Konstruktion leer, und
 * „0 Drops" liest sich wie „nichts zu befürchten". **Das ist dieselbe Klasse
 * wie der übersprungene Replica-Diff vom 17.09.2026**: eine Prüfung, die gar
 * nichts verglichen hat, wird als bestanden ausgewiesen. Der Unterschied ist
 * nur, dass sie diesmal sogar läuft.
 *
 * ── Was diese Prüfung NICHT fängt ────────────────────────────────────────
 * Zwei VERSCHIEDENE Hostnamen auf dieselbe Datenbank (Neon-Pooler-Endpunkt vs.
 * Direktverbindung, CNAME, Proxy) sehen hier verschieden aus und kommen durch.
 * Das ist bewusst offen gelassen: eine belastbare Cluster-Identität
 * (`system_identifier`) ist auf verwalteten Endpunkten nicht zuverlässig
 * lesbar, und ein Riegel, der falsch anschlägt, würde den Publish blockieren.
 * Gefangen wird der praktisch häufige Fall — zweimal derselbe String.
 */
export function isSameDatabase(a, b) {
  return a.host === b.host && a.database === b.database;
}

/**
 * Liest das öffentliche Schema (Tabellen + Spalten) UND die Identität der
 * offenen Verbindung. Zwei Abfragen, mehr nicht — deshalb läuft dieses Modul
 * auch gegen einen entfernten Prod-Endpunkt, an dem `drizzle-kit push` mit
 * seiner 69-fachen Katalog-Auffächerung scheitert (Ticket 6hWvrJgff5xr9hfp).
 *
 * SSL wird aus dem Connection-String abgeleitet (siehe `resolveSchemaSnapshotSsl`).
 */
export async function fetchSchemaSnapshotWithIdentity(connectionString) {
  const client = new pg.Client({
    connectionString,
    ssl: resolveSchemaSnapshotSsl(connectionString),
  });
  await client.connect();
  try {
    const [identityRes, columnsRes] = await Promise.all([
      client.query("SELECT current_database() AS db"),
      client.query(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name, column_name`,
      ),
    ]);
    const snapshot = {};
    for (const row of columnsRes.rows) {
      (snapshot[row.table_name] ??= []).push(row.column_name);
    }
    return {
      snapshot,
      identity: {
        host: connectionHost(connectionString),
        database: String(identityRes.rows[0]?.db ?? "(unbekannt)"),
      },
    };
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
  const [target, prod] = await Promise.all([
    fetchSchemaSnapshotWithIdentity(targetUrl),
    fetchSchemaSnapshotWithIdentity(prodUrl),
  ]);

  // Fail-closed VOR dem Diff: zeigen beide Verbindungen auf dieselbe Datenbank,
  // ist das Ergebnis per Konstruktion leer und sagt nichts. `available:false`
  // statt „0 Drops" — der Aufrufer behandelt es dann wie jede andere nicht
  // durchgeführte Messung, und die Checkliste wird rot statt grün.
  if (isSameDatabase(target.identity, prod.identity)) {
    return {
      available: false,
      reason:
        `Ziel und Prod sind dieselbe Datenbank (${prod.identity.host}/${prod.identity.database}) — `
        + "es wurde nichts verglichen. Vermutlich steht in PROD_DATABASE_URL die Dev-URL.",
      identity: { target: target.identity, prod: prod.identity },
    };
  }

  const diff = computeDestructiveSchemaDiff(target.snapshot, prod.snapshot);
  const drops = flattenDestructiveDiff(diff);
  const contractViolations = checkExpandMigrateContract(drops);
  return {
    available: true,
    ...diff,
    drops,
    contractViolations,
    /** Was tatsächlich verglichen wurde — ohne Connection-String. */
    identity: { target: target.identity, prod: prod.identity },
  };
}
