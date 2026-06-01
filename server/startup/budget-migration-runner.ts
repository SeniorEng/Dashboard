/**
 * Task #895 — Verlässliches Budget-Migrations-Framework.
 *
 * Einmalige (one-shot) Budget-DATEN-Migrationen sind GoBD-kritisch: sie mutieren
 * historisierte Finanztabellen und dürfen weder doppelt laufen noch eine
 * Erhaltungs-Invariante (kein Topf überzogen) verletzen. Dieses Modul stellt
 * dafür drei Bausteine bereit:
 *
 *  1. **Migrations-Ledger** (`budget_migrations`) — jede erfolgreiche Migration
 *     wird per Name protokolliert. Beim nächsten Boot wird sie übersprungen
 *     (exactly-once, beweisbar). Der Ledger-Insert läuft INNERHALB der
 *     Migrations-Transaktion → ein Rollback entfernt auch den Ledger-Eintrag,
 *     sodass die Migration beim nächsten Boot erneut versucht wird.
 *
 *  2. **Guarded Wrapper** (`runGuardedBudgetMigration`) — führt die Migration in
 *     EINER Transaktion mit transaktions-lokalem GoBD-Bypass aus, klammert sie
 *     mit einem Conservation-Pre- und Post-Check ein und ROLLT ZURÜCK, sobald
 *     die Migration eine NEUE Erhaltungs-Verletzung einführt (vorbestehende
 *     Verletzungen blockieren legitime Migrationen NICHT).
 *
 *  3. **Registry/Entry-Point** (`runBudgetDataMigrations`) — deterministische
 *     Reihenfolge + Fault-Isolation: eine fehlschlagende Migration wird geloggt
 *     und übersprungen, ohne die übrigen abzuwürgen.
 *
 * Die Migrations-Funktionen MÜSSEN idempotent bleiben: Der Ledger verhindert
 * Re-Runs nur NACH dem ersten erfolgreichen Lauf. In einer DB, die VOR der
 * Ledger-Einführung bereits migriert wurde, läuft die Migration genau einmal
 * (No-Op) durch, um den Ledger-Eintrag nachzutragen.
 */
import { sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "../lib/db";
import { log } from "../lib/log";
import { checkBudgetConservation, type ConservationResult } from "../lib/budget-conservation";

export interface BudgetMigrationSummary {
  /** Anzahl geänderter Zeilen (0 = No-Op). */
  changed: number;
  /** Optionale menschenlesbare Notiz fürs Ledger/Log. */
  note?: string;
}

export interface GuardedBudgetMigration {
  /** Eindeutiger, stabiler Name — Primärschlüssel im Ledger. */
  name: string;
  /** Version (nur Forensik; das Gating erfolgt über den Namen). */
  version?: string;
  /** Transaktions-lokalen GoBD-Bypass setzen (default true). */
  gobdBypass?: boolean;
  /** Conservation-Pre-/Post-Check ausführen (default true). */
  conservationCheck?: boolean;
  /** Die eigentliche Migration. Läuft in der bereitgestellten Transaktion. */
  migrate: (tx: Tx) => Promise<BudgetMigrationSummary | void>;
}

export type MigrationOutcome = "applied" | "skipped";

/**
 * Wirft der Guarded-Wrapper, wenn die Migration eine NEUE Conservation-
 * Verletzung einführt → Transaktion rollt zurück.
 */
export class BudgetConservationViolationError extends Error {
  constructor(
    public readonly migrationName: string,
    public readonly newPotViolationKeys: string[],
    public readonly newCrossDetails: string[],
  ) {
    super(
      `Budget-Migration '${migrationName}' wurde zurückgerollt: sie würde ${newPotViolationKeys.length} neue Topf-Überziehung(en) ` +
        `[${newPotViolationKeys.join(", ")}] und ${newCrossDetails.length} neue Ledger-Kreuzcheck-Verletzung(en) einführen` +
        (newCrossDetails.length > 0 ? ` [${newCrossDetails.join("; ")}]` : "") +
        `.`,
    );
    this.name = "BudgetConservationViolationError";
  }
}

/**
 * Vergleicht Pre-/Post-Conservation. Toleriert VORBESTEHENDE Verletzungen,
 * blockiert aber jede NEU eingeführte. Wirft bei Neu-Verletzung.
 *
 * Der Kreuzcheck wird IDENTITÄTS-basiert verglichen (Set-Diff über
 * `crossDetails`), nicht nur über die Anzahl — sonst würde eine Migration, die
 * eine alte Verletzung durch eine ANDERE neue ersetzt (Count gleich), fälschlich
 * durchgehen.
 *
 * Exportiert für den Unit-Test (reine Funktion, keine DB nötig).
 */
export function assertNoNewConservationViolations(
  migrationName: string,
  pre: ConservationResult,
  post: ConservationResult,
): void {
  const preKeys = new Set(pre.potViolationKeys);
  const newPotViolationKeys = post.potViolationKeys.filter((k) => !preKeys.has(k));

  const preCross = new Set(pre.crossDetails);
  const newCrossDetails = post.crossDetails.filter((d) => !preCross.has(d));

  if (newPotViolationKeys.length > 0 || newCrossDetails.length > 0) {
    throw new BudgetConservationViolationError(migrationName, newPotViolationKeys, newCrossDetails);
  }
}

async function isMigrationApplied(exec: DbOrTx, name: string): Promise<boolean> {
  const result = await exec.execute(
    sql`SELECT 1 FROM budget_migrations WHERE name = ${name} LIMIT 1`,
  );
  return ((result as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

async function recordMigrationApplied(
  tx: DbOrTx,
  args: { name: string; version: string; summary: BudgetMigrationSummary },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO budget_migrations (name, version, summary, applied_at)
    VALUES (${args.name}, ${args.version}, ${JSON.stringify(args.summary)}, NOW())
    ON CONFLICT (name) DO NOTHING
  `);
}

/**
 * Führt EINE Budget-Daten-Migration verlässlich aus:
 *  - bereits im Ledger → übersprungen (`"skipped"`).
 *  - sonst: Transaktion (GoBD-Bypass) → Pre-Check → migrate → Post-Check →
 *    Guard → Ledger-Insert → commit. Jede Verletzung/Exception rollt ALLES
 *    zurück (inkl. Ledger-Eintrag) und propagiert den Fehler an den Aufrufer.
 */
export async function runGuardedBudgetMigration(m: GuardedBudgetMigration): Promise<MigrationOutcome> {
  const version = m.version ?? "1";
  const gobdBypass = m.gobdBypass ?? true;
  const conservationCheck = m.conservationCheck ?? true;

  // Schneller Pfad (außerhalb der Transaktion): bereits angewendet → kein
  // Transaktions-Overhead. Die verbindliche Prüfung passiert nochmal INNERHALB
  // der Transaktion unter dem Advisory-Lock (Race-Schutz).
  if (await isMigrationApplied(db, m.name)) {
    log(`[budget-migration] '${m.name}' bereits im Ledger — übersprungen.`, "startup");
    return "skipped";
  }

  let outcome: MigrationOutcome = "applied";

  await db.transaction(async (tx) => {
    // Exactly-once unter Nebenläufigkeit: ein transaktions-gebundener
    // Advisory-Lock serialisiert konkurrierende Boot-Prozesse pro Migrations-
    // Namen. Der zweite Prozess blockiert hier, bis der erste committet/rollt,
    // und sieht beim anschließenden Re-Check entweder den Ledger-Eintrag
    // (→ skip) oder einen sauberen Zustand (→ retry). Der Lock wird beim
    // Transaktionsende automatisch freigegeben.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${m.name}))`);

    if (await isMigrationApplied(tx, m.name)) {
      log(
        `[budget-migration] '${m.name}' wurde nebenläufig angewendet — übersprungen.`,
        "startup",
      );
      outcome = "skipped";
      return;
    }

    if (gobdBypass) {
      await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
    }

    const pre = conservationCheck ? await checkBudgetConservation(tx) : null;
    const summary = (await m.migrate(tx)) ?? { changed: 0 };

    if (pre) {
      const post = await checkBudgetConservation(tx);
      assertNoNewConservationViolations(m.name, pre, post);
    }

    await recordMigrationApplied(tx, { name: m.name, version, summary });
    log(
      `[budget-migration] '${m.name}' angewendet (changed=${summary.changed}${summary.note ? `, ${summary.note}` : ""}).`,
      "startup",
    );
  });

  return outcome;
}

/**
 * Deterministische Registry aller startup-getriebenen Budget-Daten-Migrationen.
 * Reihenfolge = Array-Reihenfolge. Jede Migration ist fault-isoliert: ein
 * Fehlschlag (inkl. Conservation-Rollback) wird geloggt und übersprungen, ohne
 * die übrigen Migrationen oder den Boot abzubrechen.
 */
export async function runBudgetDataMigrations(): Promise<void> {
  const { migrateBudgetSources } = await import("./migrate-budget-sources");

  const migrations: GuardedBudgetMigration[] = [
    { name: "migrate-budget-sources", version: "2", migrate: migrateBudgetSources },
  ];

  for (const m of migrations) {
    try {
      await runGuardedBudgetMigration(m);
    } catch (err) {
      log(
        `[budget-migration] '${m.name}' fehlgeschlagen (Transaktion zurückgerollt) — Boot wird fortgesetzt: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        "startup",
      );
    }
  }
}
