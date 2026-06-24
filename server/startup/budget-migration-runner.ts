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
  const { backfillImportUpdateBudgetDrift } = await import(
    "./backfill-import-update-budget-drift"
  );
  const { backfillDuplicateWizardCarryovers } = await import(
    "./backfill-duplicate-wizard-carryovers"
  );
  const { backfillTask684OrphanAutoCarryovers } = await import(
    "./backfill-task-684-orphan-auto-carryovers"
  );
  const { backfillTask685RelinkOrphanCarryoverTx } = await import(
    "./backfill-task-685-relink-orphan-carryover-tx"
  );
  const { backfillMissingImportConsumption } = await import(
    "./backfill-missing-import-consumption"
  );
  const { reclassifyCustomer202To45b } = await import(
    "./reclassify-customer-202-to-45b"
  );
  const { cleanupLegacyAutoAllocations } = await import(
    "./cleanup-legacy-auto-allocations-migration"
  );

  // Reihenfolge ist relevant: #685 hängt von der Keep-Wahl aus #684 ab.
  // Alle vier Carryover-/Drift-Backfills setzen voraus, dass
  // `backfillBudgetHistorization` (partieller Unique-Index auf
  // budget_allocations) bereits gelaufen ist — der Entry-Point wird in
  // `server/index.ts` daher NACH der Historisierung aufgerufen (Task #896).
  const migrations: GuardedBudgetMigration[] = [
    {
      name: "backfill-import-update-budget-drift",
      version: "1",
      migrate: backfillImportUpdateBudgetDrift,
    },
    {
      name: "backfill-duplicate-wizard-carryovers-601",
      version: "1",
      migrate: backfillDuplicateWizardCarryovers,
    },
    {
      name: "backfill-task-684-orphan-auto-carryovers",
      version: "1",
      migrate: backfillTask684OrphanAutoCarryovers,
    },
    {
      name: "backfill-task-685-relink-orphan-carryover-tx",
      version: "1",
      migrate: backfillTask685RelinkOrphanCarryoverTx,
    },
    {
      name: "backfill-missing-import-consumption-1191",
      version: "1",
      migrate: backfillMissingImportConsumption,
    },
  ];

  // Task #1296 — Diese Migration korrigiert PRODUKTIV-Echtdaten eines einzelnen
  // Kunden (#202) und erfordert ausdrückliche Freigabe ("sign-off") VOR dem
  // Lauf. Sie wird daher NUR registriert, wenn das Approval-Flag
  // `APPROVED_RECLASSIFY_CUSTOMER_202_45B` (=1/true) gesetzt ist. Default =
  // nicht registriert ⇒ kein Ledger-Eintrag ⇒ die Migration kann nach erteilter
  // Freigabe beim nächsten Boot noch laufen (kein vorzeitiges "applied").
  const reclassifyApproved = /^(1|true)$/i.test(
    (process.env.APPROVED_RECLASSIFY_CUSTOMER_202_45B ?? "").trim(),
  );
  if (reclassifyApproved) {
    migrations.push({
      name: "reclassify-customer-202-to-45b-1296",
      version: "1",
      migrate: reclassifyCustomer202To45b,
    });
  } else {
    log(
      "[budget-migration] 'reclassify-customer-202-to-45b-1296' übersprungen: " +
        "Freigabe-Flag APPROVED_RECLASSIFY_CUSTOMER_202_45B nicht gesetzt " +
        "(Sign-off erforderlich, kein Ledger-Eintrag).",
      "startup",
    );
  }

  // Task #1409 — Hard-Delete der aktiven Altlast-Auto-Allocation-Zeilen
  // (`monthly_auto`/`yearly_auto`) über den GoBD-konformen
  // FK-Null-dann-Delete-Pfad (ERSETZT die frühere
  // `cleanup-legacy-allocation-sources-1324`). Mutiert GoBD-historisierte Daten
  // ⇒ nur bei ausdrücklicher Freigabe
  // `APPROVED_CLEANUP_LEGACY_AUTO_ALLOCATIONS_1409` registriert (Default = nicht
  // registriert, kein Ledger-Eintrag). Transaktional + Conservation-/GoBD-Guard
  // über den Wrapper (Defaults true).
  const cleanupApproved = /^(1|true)$/i.test(
    (process.env.APPROVED_CLEANUP_LEGACY_AUTO_ALLOCATIONS_1409 ?? "").trim(),
  );
  if (cleanupApproved) {
    migrations.push({
      name: "cleanup-legacy-auto-allocations-1409",
      version: "1",
      migrate: cleanupLegacyAutoAllocations,
    });
  } else {
    log(
      "[budget-migration] 'cleanup-legacy-auto-allocations-1409' übersprungen: " +
        "Freigabe-Flag APPROVED_CLEANUP_LEGACY_AUTO_ALLOCATIONS_1409 nicht gesetzt " +
        "(Sign-off erforderlich, kein Ledger-Eintrag).",
      "startup",
    );
  }

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
