/**
 * A2 — Struktur-Inventar: Was baut die Baseline, und was bleibt startup-only?
 *
 * Die Baseline (`migrations/0000_*.sql`) entsteht aus dem Drizzle-Modell. Alles,
 * was der Startup-Pfad per rohem DDL anlegt und was NICHT im Modell steht,
 * fehlt ihr — und genau daran würde die Reproduzierbarkeits-Gegenprobe in A3
 * scheitern („von Null gebaut == Prod, Diff 0").
 *
 * Dieser Test misst den Delta statt ihn zu behaupten: Er baut eine zweite
 * Wegwerf-DB NUR aus Baseline + handgeführter Trigger-Migration und vergleicht
 * ihren Katalog gegen die laufende Test-DB (= Modell + alle Startup-Effekte).
 *
 * Er ist bewusst als PIN gebaut, nicht als „muss leer sein": die bekannten
 * Ausnahmen stehen unten namentlich mit Begründung. Kommt eine NEUE dazu, wird
 * der Test rot — dann ist entweder ein Objekt ins Modell zu heben oder die
 * Ausnahme bewusst einzutragen. Verschwindet eine, ebenfalls: dann ist die
 * Liste veraltet.
 *
 * Skippt sauber, wenn `CREATE DATABASE` nicht möglich ist (wie
 * `schema-replica-diff-live.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";

const ADMIN_URL = process.env.DATABASE_URL;
const BASE_DB = `cc_test_baseline_${process.pid.toString(36)}_${randomBytes(3).toString("hex")}`;

/**
 * Constraints, die die Laufzeit-DB trägt, die Baseline aber nicht.
 *
 * Jeder Eintrag ist eine offene Aufgabe, kein Freibrief.
 *
 * Der frühere Eintrag `audit_log_parent_deletion_id_fkey` ist WEG: er war kein
 * fehlender Constraint, sondern ein Duplikat aus einem Deploy-Ping-Pong. Der
 * Startup-Pfad prüft jetzt SPALTEN-basiert und erzeugt keinen Zweitling mehr
 * (`server/startup/ensure-audit-parent-deletion.ts`, gepinnt in
 * `tests/startup/startup-schema-drift.test.ts`).
 *
 * ANNAHME: Die Laufzeit-DB wurde nach `push` auch GEBOOTET. Ein Snapshot
 * dazwischen hätte die startup-erzeugten Objekte nicht und liesse diesen Test
 * rot laufen. Orchestrator und CI garantieren die Reihenfolge.
 *
 * ZWEITE ANNAHME: Die Laufzeit-DB wurde mit dem AKTUELLEN Code gebootet. Eine DB,
 * die noch ein Boot der namensbasierten FK-Fassung gesehen hat, traegt den
 * `..._fkey` weiterhin — dort meldet dieser Test zu Recht eine veraltete Liste.
 * Abhilfe: neu pushen.
 *
 * DRITTE ANNAHME: Die Laufzeit-DB ist FRISCH. Fuer den CHECK unten gilt die
 * Abhilfe von oben NICHT — sie ist dort die Ursache. `drizzle-kit push` droppt
 * ihn (er steht nicht mehr im Modell), und `scripts/post-merge.sh` faehrt
 * `npm run db:push` unbeaufsichtigt gegen die Dev-DB. Zurueck kommt er nicht:
 * die Anlage ist ledger-gegated (`budget_migrations`) und dort laengst als
 * gelaufen vermerkt. Auf so einer DB meldet dieser Test „Liste ist veraltet" —
 * richtig ist dann eine frische DB oder das Loeschen des Ledger-Eintrags
 * `migrate-erstberatung-customers`, nicht ein weiterer Push.
 */
const KNOWN_STARTUP_ONLY_CONSTRAINTS: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: "appointments_prospect_or_customer_check",
    why:
      "ABSICHTLICH startup-only. GEMESSEN: in Prod existiert der CHECK nicht " +
      "(Schema-Dump 03.08.2026). Im Drizzle-Modell waere er ein Constraint, den " +
      "jede frisch gebaute DB haette und Prod nicht: genau die Asymmetrie, an " +
      "der die A3-Gegenprobe (von Null == Prod, Diff 0) scheitern wuerde. " +
      "WARUM er in Prod fehlt, ist OFFEN — `migrate-erstberatung-customers.ts` " +
      "hat das ADD CONSTRAINT bei seinem EINMALIGEN, ledger-gegateten Lauf " +
      "uebersprungen (`budget_migrations`; laeuft nicht bei jedem Boot). Ob das " +
      "an verletzenden Bestandsdaten lag oder ob ein Replit-Publish-Diff den " +
      "Constraint gedroppt hat, ist unbelegt; zwei read-only Queries in " +
      "docs/schema-baseline-inventory.md entscheiden es. Ihn zu erzwingen ist " +
      "eine fachliche Entscheidung und braucht wegen des Ledgers eine NEUE " +
      "Migration, nicht nur den vorhandenen Startup-Pfad — siehe FINDING.",
  },
];

type Snapshot = Record<string, Map<string, string>>;

const QUERIES: Record<string, string> = {
  columns: `SELECT table_name||'.'||column_name AS k,
                   data_type||coalesce('('||numeric_precision||','||numeric_scale||')','')
                   ||' null='||is_nullable AS v
            FROM information_schema.columns WHERE table_schema='public'`,
  tables: `SELECT table_name AS k, '' AS v FROM information_schema.tables
           WHERE table_schema='public' AND table_type='BASE TABLE'`,
  // NUR den Namen ersetzen — `UNIQUE` MUSS im Vergleichswert bleiben. Wird es
  // mit weggeschnitten, ist ein verlorenes `uniqueIndex()` unsichtbar: der
  // spalten- und praedikatsgleiche Nicht-Unique-Index sieht dann identisch aus,
  // und ein Unique-Index erzeugt keinen `pg_constraint`-Eintrag, faellt also
  // auch im Constraint-Vergleich nicht auf.
  indexes: `SELECT indexname AS k,
                   regexp_replace(indexdef,'^CREATE (UNIQUE )?INDEX [^ ]+ ','CREATE \\1INDEX ') AS v
            FROM pg_indexes WHERE schemaname='public'`,
  constraints: `SELECT con.conname AS k, pg_get_constraintdef(con.oid) AS v
                FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND con.contype IN ('c','u','p','f')`,
  triggers: `SELECT c.relname||'.'||t.tgname AS k, pg_get_triggerdef(t.oid) AS v
             FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
             JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE NOT t.tgisinternal AND n.nspname='public'`,
  triggerFunctions: `SELECT p.proname AS k, '' AS v FROM pg_proc p
                     JOIN pg_namespace n ON n.oid=p.pronamespace
                     JOIN pg_type rt ON rt.oid=p.prorettype
                     WHERE n.nspname='public' AND rt.typname='trigger'`,
};

async function snapshot(url: string): Promise<Snapshot> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const out: Snapshot = {};
    for (const [name, q] of Object.entries(QUERIES)) {
      const r = await c.query(q);
      out[name] = new Map(
        (r.rows as Array<Record<string, unknown>>).map((x) => [String(x.k), String(x.v ?? "")]),
      );
    }
    return out;
  } finally {
    await c.end();
  }
}

function baselineUrl(): string {
  return ADMIN_URL!.replace(/\/[^/?]+(\?|$)/, `/${BASE_DB}$1`);
}

let available = false;
let setupError = "";
let fromBaseline: Snapshot;
let fromRuntime: Snapshot;

beforeAll(async () => {
  if (!ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${BASE_DB}`);
  } catch (err) {
    await admin.end().catch(() => {});
    // In CI ist `DATABASE_URL` direkt-TCP auf einen Superuser — `CREATE
    // DATABASE` MUSS dort gelingen. Ein stiller Skip waere dort besonders
    // heimtueckisch, weil das PR-Verfahren Test-MENGEN vergleicht: ein leer
    // laufender Test ist von einem echten Pass nicht zu unterscheiden.
    if (process.env.CI === "true") throw err;
    setupError = err instanceof Error ? err.message : String(err);
    return;
  }
  await admin.end();

  const c = new pg.Client({ connectionString: baselineUrl() });
  await c.connect();
  try {
    // drizzle trennt die Statements der generierten Migrationen mit
    // `--> statement-breakpoint`; die handgefuehrten laufen als Ganzes.
    for (const file of generatedMigrationFiles()) {
      for (const stmt of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
        const t = stmt.trim();
        if (t) await c.query(t);
      }
    }
    for (const file of manualMigrationFiles()) {
      await c.query(readFileSync(file, "utf8"));
    }
  } finally {
    await c.end();
  }

  fromBaseline = await snapshot(baselineUrl());
  fromRuntime = await snapshot(ADMIN_URL);
  available = true;
}, 120_000);

afterAll(async () => {
  if (!ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${BASE_DB}`).catch(() => {});
  await admin.end().catch(() => {});
});

/**
 * Alle generierten Migrationen in Journal-Reihenfolge.
 *
 * Bewusst NICHT „genau eine Datei": sobald eine zweite Migration entsteht,
 * waere das ein harter Fehler mitten im `beforeAll` — und die Meldung saehe wie
 * ein Konfigurationsfehler aus statt wie „Test muss nachziehen". Das Journal
 * ist ohnehin die maßgebliche Reihenfolge.
 */
function generatedMigrationFiles(): string[] {
  const journal = JSON.parse(
    readFileSync("migrations/meta/_journal.json", "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => `migrations/${e.tag}.sql`);
}

/** Alle handgefuehrten Migrationen (Trigger/Funktionen), alphabetisch. */
function manualMigrationFiles(): string[] {
  return readdirSync("migrations/manual")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `migrations/manual/${f}`);
}

describe("A2 — Baseline-Struktur-Inventar", () => {
  it("Baseline + Trigger-Migration bauen Tabellen, Spalten, Indizes, Trigger und Funktionen vollständig", (ctx) => {
    if (!available) return ctx.skip(`keine zweite DB moeglich: ${setupError}`);
    for (const kind of ["tables", "columns", "indexes", "triggers", "triggerFunctions"]) {
      const b = fromBaseline[kind], r = fromRuntime[kind];
      const missing = [...r.keys()].filter((k) => !b.has(k));
      const extra = [...b.keys()].filter((k) => !r.has(k));
      const differing = [...r.entries()]
        .filter(([k, v]) => b.has(k) && b.get(k) !== v)
        .map(([k, v]) => `${k}: Laufzeit "${v}" vs. Baseline "${b.get(k)}"`);

      expect(missing, `${kind}: in der Laufzeit-DB, aber NICHT in der Baseline`).toEqual([]);
      expect(extra, `${kind}: in der Baseline, aber NICHT in der Laufzeit-DB`).toEqual([]);
      expect(differing, `${kind}: unterschiedlich definiert`).toEqual([]);
    }
  });

  it("Constraints: exakt die dokumentierten Ausnahmen fehlen der Baseline", (ctx) => {
    if (!available) return ctx.skip(`keine zweite DB moeglich: ${setupError}`);
    const b = fromBaseline.constraints, r = fromRuntime.constraints;

    const missing = [...r.keys()].filter((k) => !b.has(k)).sort();
    const known = KNOWN_STARTUP_ONLY_CONSTRAINTS.map((e) => e.name).sort();

    expect(
      missing,
      "Der Satz startup-only Constraints hat sich geändert. Neu hinzugekommene " +
        "gehören ins Drizzle-Modell (dann verschwinden sie hier) oder bewusst in " +
        "KNOWN_STARTUP_ONLY_CONSTRAINTS mit Begründung. Verschwundene bedeuten, " +
        "dass die Liste veraltet ist.",
    ).toEqual(known);

    // Namensgleich ist nicht definitionsgleich: ein FK, der in der Baseline
    // `ON DELETE RESTRICT` statt `CASCADE` traegt, hiesse gleich und waere ohne
    // diesen Vergleich unsichtbar — bei `invoice_line_items` ein
    // Verhaltensunterschied mit Rechnungsbezug.
    const differing = [...r.entries()]
      .filter(([k, v]) => b.has(k) && b.get(k) !== v)
      .map(([k, v]) => `${k}: Laufzeit "${v}" vs. Baseline "${b.get(k)}"`);
    expect(differing, "Constraints mit gleichem Namen, aber anderer Definition").toEqual([]);

    // Die Gegenrichtung darf es nicht geben: die Baseline erfindet nichts.
    expect(
      [...b.keys()].filter((k) => !r.has(k)),
      "Constraints in der Baseline, die die Laufzeit-DB nicht hat",
    ).toEqual([]);
  });
});
