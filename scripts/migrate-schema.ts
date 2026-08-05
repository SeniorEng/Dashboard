/**
 * Task #1902 (A3) — Programmatischer Schema-Migrator.
 *
 * ERSETZT `drizzle-kit push` als Weg, wie Schema-Änderungen auf eine Datenbank
 * kommen. `push` vergleicht Modell gegen DB und leitet die Änderung selbst ab —
 * es gibt keine versionierte, reviewbare Liste dessen, was passiert ist, und
 * `--force` darf destruktiv werden. Dieser Migrator führt stattdessen genau die
 * Dateien aus, die im Repo liegen, in fester Reihenfolge, je in einer
 * Transaktion, und schreibt mit, was gelaufen ist. `scripts/migrate.sh` (der
 * Coolify-Pre-Deploy-Wrapper um `push`) bleibt vorerst bestehen und wird erst
 * umgestellt, wenn dieser Migrator abgenommen ist — das ist bewusst NICHT Teil
 * von A3 (siehe „Nicht in A3" unten).
 *
 * ZWEI QUELLEN, EINE REIHENFOLGE
 *
 *   1. `migrations/` — die von `drizzle-kit generate` erzeugte Baseline,
 *      geführt über `migrations/meta/_journal.json`. Angewendet über drizzles
 *      eigenen Migrator, damit die Buchführung in `drizzle.__drizzle_migrations`
 *      exakt die ist, die drizzle-kit auch erwartet.
 *
 *   2. `migrations/manual/*.sql` — was Drizzle nicht ausdrücken kann (Trigger,
 *      Funktionen, Cutover-Aufräumung). Steht bewusst AUSSERHALB des Journals
 *      (`migrations/manual/README.md`): `drizzle-kit` fasst den Ordner nicht an,
 *      und `_journal.json` kennt nur `0000`. Der Migrator wendet sie deshalb
 *      EXPLIZIT an und führt dafür eine eigene Buchführung.
 *
 * Die Reihenfolge ist Baseline → manual, nicht umgekehrt: die Trigger aus
 * `0001` hängen an Tabellen, die die Baseline anlegt.
 *
 * BUCHFÜHRUNG LIEGT IM `drizzle`-SCHEMA, NICHT IN `public`
 *
 * `drizzle.__drizzle_migrations` (von drizzle) und `drizzle.__manual_migrations`
 * (von hier) stehen beide im `drizzle`-Schema. Das ist kein Ordnungsdetail:
 * `pg_dump --schema=public` — das Rezept, mit dem der Cutover verglichen wird
 * (`docs/schema-cutover.md`) — sieht sie dadurch nicht. Buchführung darf den
 * Schema-Vergleich nicht verfälschen. Aus demselben Grund NICHT die vorhandene
 * Tabelle `budget_migrations` mitbenutzt: die liegt in `public`, ist im
 * Drizzle-Modell deklariert und beantwortet eine andere Frage (einmalige
 * BUDGET-DATEN-Migrationen, `server/startup/ensure-migration-ledger.ts`).
 *
 * ZWEI MODI
 *
 *   Standard        — journaled Migrationen ausführen, dann manual.
 *                     Für eine LEERE DB und für jeden Folge-Deploy.
 *
 *   --stamp-baseline — die journaled Migrationen als „angewendet" STEMPELN,
 *                     ohne sie auszuführen; danach manual normal anwenden.
 *                     Genau einmal beim CUTOVER einer bestehenden Datenbank.
 *                     Die Baseline beschreibt den Zustand, den eine bestehende
 *                     DB schon hat (`migrations/README.md`: „zum STEMPELN da,
 *                     nicht zum Ausführen"); ausgeführt bräche sie am ersten
 *                     `CREATE TABLE` (kein `IF NOT EXISTS`).
 *
 * Der Stempel ist NICHT geschätzt: `hash` und `created_at` kommen aus drizzles
 * eigenem `readMigrationFiles()`, also aus derselben Funktion, die auch der
 * echte Lauf benutzt. Wichtig, weil drizzles Applied-Prüfung ausschliesslich
 * `created_at` vergleicht (`pg-core/dialect.js`: `order by created_at desc
 * limit 1`, dann `last.created_at < migration.folderMillis`) — ein falscher
 * Zeitstempel würde die Baseline später erneut anwenden.
 *
 * NICHT IN A3 (bewusst offen, siehe PR-Body):
 *   - Kein Aufruf aus dem Deploy. `scripts/migrate.sh` fährt weiter `push`.
 *   - Kein Wegwerf-DB-Guard: dieser Migrator SOLL irgendwann gegen Prod laufen,
 *     ein `cc_test_`-Zwang wäre sinnwidrig. Bis er im Deploy hängt, ist der
 *     Schutz der bewusste Aufruf.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";

const MIGRATIONS_FOLDER = "migrations";
const MANUAL_FOLDER = path.join(MIGRATIONS_FOLDER, "manual");

/** Buchführungs-Schema — dasselbe, das drizzle selbst benutzt. */
const BOOKKEEPING_SCHEMA = "drizzle";
const MANUAL_TABLE = "__manual_migrations";

/**
 * Ein Migrator, der zweimal gleichzeitig läuft, kann dieselbe DDL doppelt
 * fahren. `try` statt blockierend: hängt schon einer, ist Warten die falsche
 * Antwort — der zweite Aufruf soll mit klarer Meldung abbrechen, nicht bis zum
 * Deploy-Timeout stehen.
 */
const LOCK_KEY_SQL = `SELECT pg_try_advisory_lock(hashtext('careconnect_schema_migration')) AS ok`;

interface ManualMigration {
  name: string;
  filePath: string;
  sqlText: string;
  hash: string;
}

function readManualMigrations(): ManualMigration[] {
  if (!fs.existsSync(MANUAL_FOLDER)) return [];
  return fs
    .readdirSync(MANUAL_FOLDER)
    .filter((f) => f.endsWith(".sql"))
    // Lexikalisch = numerisch, solange die Dateien führende Nullen tragen
    // (`0001_`, `0002_`). Das ist die Konvention des Ordners.
    .sort()
    .map((name) => {
      const filePath = path.join(MANUAL_FOLDER, name);
      const sqlText = fs.readFileSync(filePath, "utf8");
      return {
        name,
        filePath,
        sqlText,
        hash: crypto.createHash("sha256").update(sqlText).digest("hex"),
      };
    });
}

async function ensureBookkeeping(client: pg.Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${BOOKKEEPING_SCHEMA}"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${BOOKKEEPING_SCHEMA}"."${MANUAL_TABLE}" (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Legt Schema + Tabelle für drizzles eigene Buchführung an — wortgleich zu
 * `pg-core/dialect.js`. Nötig nur im Stempel-Modus, weil dort drizzles
 * `migrate()` nicht läuft und die Tabelle sonst nicht existierte.
 */
async function ensureDrizzleBookkeeping(client: pg.Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${BOOKKEEPING_SCHEMA}"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${BOOKKEEPING_SCHEMA}"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

async function stampBaseline(client: pg.Client, dryRun: boolean): Promise<void> {
  const journaled = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

  // Der Stempel ist die einzige unumkehrbare Handlung dieses Skripts: er sagt
  // „diese DB hat den Zustand, den 0000 beschreibt", und legt die Baseline
  // damit dauerhaft stumm. Auf einer LEEREN DB ist das eine Fehlbedienung mit
  // üblem Ausgang — die Baseline liefe nie mehr, ein anschliessender
  // Standard-Lauf meldete Erfolg und baute nichts, und geradeziehen ginge nur
  // per Hand-DELETE in der Buchführung. Auf Prod wäre das genau der Eingriff,
  // den CLAUDE.md ausschliesst. Deshalb vorher hinsehen statt unterstellen.
  const built = await client.query<{ present: string | null }>(
    `SELECT to_regclass('public.audit_log')::text AS present`,
  );
  if (!built.rows[0]?.present) {
    throw new Error(
      "--stamp-baseline auf einer Datenbank ohne Schema (public.audit_log fehlt).\n" +
        "  Stempeln behauptet, die Baseline sei bereits angewendet — hier ist sie es nicht.\n" +
        "  Für eine leere DB ist der Standard-Modus richtig (ohne --stamp-baseline).",
    );
  }

  if (dryRun) {
    for (const m of journaled) {
      console.log(`[migrate-schema] DRY-RUN würde stempeln: created_at=${m.folderMillis}`);
    }
    return;
  }

  await ensureDrizzleBookkeeping(client);

  for (const m of journaled) {
    const existing = await client.query(
      `SELECT 1 FROM "${BOOKKEEPING_SCHEMA}"."__drizzle_migrations" WHERE created_at = $1`,
      [m.folderMillis],
    );
    if ((existing.rowCount ?? 0) > 0) {
      console.log(`[migrate-schema] journaled ${m.folderMillis}: bereits gestempelt — übersprungen`);
      continue;
    }
    await client.query(
      `INSERT INTO "${BOOKKEEPING_SCHEMA}"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
      [m.hash, m.folderMillis],
    );
    console.log(
      `[migrate-schema] journaled gestempelt (NICHT ausgeführt): created_at=${m.folderMillis} hash=${m.hash.slice(0, 12)}…`,
    );
  }
}

async function applyManual(client: pg.Client, dryRun: boolean): Promise<void> {
  const manual = readManualMigrations();

  // Im Dry-Run wird NICHTS angelegt — auch keine Buchführung. Vorher lief
  // `ensureBookkeeping()` bedingungslos: der Probelauf legte Schema und Tabelle
  // an, während er „es wird nichts geschrieben" meldete. Das ist genau der
  // Lauf, den CLAUDE.md Gate 4 vor einer Prod-Schreiboperation verlangt — er
  // darf die Datenbank nicht anfassen.
  if (dryRun) {
    for (const m of manual) {
      console.log(`[migrate-schema] DRY-RUN würde anwenden: manual ${m.name}`);
    }
    return;
  }

  await ensureBookkeeping(client);

  for (const m of manual) {
    const prev = await client.query<{ hash: string }>(
      `SELECT hash FROM "${BOOKKEEPING_SCHEMA}"."${MANUAL_TABLE}" WHERE name = $1`,
      [m.name],
    );

    if ((prev.rowCount ?? 0) > 0) {
      const recorded = prev.rows[0].hash;
      if (recorded === m.hash) {
        console.log(`[migrate-schema] manual ${m.name}: unverändert angewendet — übersprungen`);
        continue;
      }
      // FAIL-CLOSED, bewusst kein automatisches Neu-Anwenden. Ein abweichender
      // Hash heisst entweder „von Hand editiert" (bei `0001` laut README
      // verboten) oder „neu generiert" — welche der beiden gilt, kann dieses
      // Skript nicht wissen, und die Antwort entscheidet über eine DDL auf
      // einer echten Datenbank.
      throw new Error(
        `manual ${m.name}: Inhalt hat sich seit dem Anwenden geändert ` +
          `(gespeichert ${recorded.slice(0, 12)}…, jetzt ${m.hash.slice(0, 12)}…).\n` +
          `  Kein automatisches Neu-Anwenden. Entscheiden und dann handeln:\n` +
          `  - neu generiert und soll erneut laufen -> Zeile in ` +
          `${BOOKKEEPING_SCHEMA}.${MANUAL_TABLE} löschen und Migrator erneut fahren\n` +
          `  - unbeabsichtigt editiert -> Datei zurücksetzen`,
      );
    }

    // Eine Transaktion pro Datei: entweder die Migration ist ganz da oder gar
    // nicht, und der Buchführungs-Eintrag fällt mit ihr zurück.
    await client.query("BEGIN");
    try {
      await client.query(m.sqlText);
      await client.query(
        `INSERT INTO "${BOOKKEEPING_SCHEMA}"."${MANUAL_TABLE}" (name, hash) VALUES ($1, $2)`,
        [m.name, m.hash],
      );
      await client.query("COMMIT");
      console.log(`[migrate-schema] manual ${m.name}: angewendet`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`manual ${m.name} fehlgeschlagen (zurückgerollt): ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stampBaselineMode = args.includes("--stamp-baseline");
  const dryRun = args.includes("--dry-run");

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate-schema] FEHLER: DATABASE_URL ist nicht gesetzt.");
    process.exit(1);
  }

  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  console.log(
    `[migrate-schema] Ziel-Datenbank '${dbName}'` +
      `${stampBaselineMode ? " — CUTOVER (Baseline wird gestempelt, nicht ausgeführt)" : ""}` +
      `${dryRun ? " — DRY-RUN, es wird nichts geschrieben" : ""}`,
  );

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const lock = await client.query<{ ok: boolean }>(LOCK_KEY_SQL);
  if (!lock.rows[0]?.ok) {
    console.error(
      "[migrate-schema] ABBRUCH: ein anderer Migrator hält den Lock auf dieser Datenbank.",
    );
    await client.end();
    process.exit(1);
  }

  try {
    if (stampBaselineMode) {
      await stampBaseline(client, dryRun);
    } else if (dryRun) {
      // drizzles `migrate()` kennt keinen Dry-Run — deshalb hier nur die
      // Absicht melden statt so zu tun, als könnte man sie zeigen.
      const journaled = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
      console.log(
        `[migrate-schema] DRY-RUN: ${journaled.length} journaled Migration(en) im Ordner; ` +
          "ob sie anstehen, entscheidet drizzle erst beim echten Lauf.",
      );
    } else {
      const db = drizzle(client);
      await db.execute(sql`SELECT 1`);
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      console.log("[migrate-schema] journaled Migrationen: fertig (drizzle-Migrator)");
    }

    await applyManual(client, dryRun);
    console.log("[migrate-schema] fertig.");
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('careconnect_schema_migration'))`);
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate-schema] FEHLER:", err instanceof Error ? err.message : err);
  process.exit(1);
});
