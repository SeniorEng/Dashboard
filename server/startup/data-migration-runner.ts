/**
 * Task #1428 — Exactly-once-Ledger für einmalige, NICHT-Budget Startup-Daten-
 * Migrationen.
 *
 * Diverse einmalige Daten-Migrationen (Status-Umstellungen, Spalten-Typ-
 * Migrationen, Backfills, Aufräum-Läufe) liefen bisher bei JEDEM Boot voll
 * durch — sie scannten ihre Zieltabellen und führten (idempotent) erneut ein
 * No-Op-UPDATE aus. Dieses Modul gatet sie über DENSELBEN verlässlichen
 * Migrations-Wrapper wie die Budget-Migrationen
 * (`runGuardedBudgetMigration` aus `server/startup/budget-migration-runner.ts`)
 * und damit über denselben Ledger (`budget_migrations`):
 *
 *  - **Frischer DB-Lauf:** Die Migration läuft GENAU EINMAL; ihre Schreibvorgänge
 *    UND der Ledger-Eintrag committen in EINER Transaktion (atomar, exactly-once).
 *  - **Jeder spätere Boot:** nur ein billiger, indizierter `SELECT 1`-Skip —
 *    KEIN Tabellen-Scan, KEIN UPDATE.
 *
 * Die Reviewer-Anforderung „Migrations-Schreibvorgänge + Ledger-INSERT in EINER
 * Transaktion" ist damit erfüllt: Der Wrapper öffnet die Transaktion, reicht sie
 * als `tx` in die Migration und schreibt am Ende in derselben Transaktion den
 * Ledger-Eintrag. Wirft die Migration, rollt ALLES zurück (kein Ledger-Eintrag)
 * → der nächste Boot versucht sie erneut ("re-arm").
 *
 * Für die GoBD-Backfills (`backfill-orphan-reversal-appointment-id`,
 * `backfill-storno-transaction-date`) setzt der
 * Wrapper den transaktions-lokalen GoBD-Bypass (`gobdBypass: true`); die übrigen
 * Migrationen berühren keine GoBD-geschützten Tabellen (`gobdBypass: false`).
 * Der Conservation-Check des Wrappers ist für alle hier registrierten
 * NICHT-Budget-Migrationen deaktiviert (`conservationCheck: false`), da sie keine
 * Budget-Töpfe verändern.
 *
 * WICHTIG: Die gegateten Funktionen MÜSSEN idempotent bleiben. Auf einer DB, die
 * VOR Einführung dieses Gatings bereits migriert wurde, läuft jede Migration
 * genau einmal (No-Op) durch, um den Ledger-Eintrag nachzutragen.
 */
import {
  runGuardedBudgetMigration,
  type GuardedBudgetMigration,
} from "./budget-migration-runner";
import { log } from "../lib/log";

/**
 * Phasen der einmaligen Daten-Migrationen relativ zum Budget-Migrations-Block
 * (`backfillBudgetHistorization` + `runBudgetDataMigrations`):
 *  - `"pre-budget"`: laufen VOR der Budget-Historisierung (Spalten-Typ-
 *    Migrationen, GoBD-budget_transactions-Backfills, Termin-/Avis-Status).
 *  - `"post-budget"`: laufen NACH dem Budget-Block (Service-Record-Restore,
 *    Erstberatungs-/Prospect-/Zeiterfassungs-Bereinigungen).
 * Die Aufteilung bewahrt die bisherige Boot-Reihenfolge (manche Migrationen
 * müssen vor, manche nach dem Budget-Block laufen).
 */
export type DataMigrationPhase = "pre-budget" | "post-budget";

/**
 * Baut die deterministische Registry der einmaligen, NICHT-Budget Daten-
 * Migrationen für die angegebene Phase und führt sie ledger-gegated +
 * fault-isoliert über `runGuardedBudgetMigration` aus. ERSETZT die zuvor einzeln
 * in `server/index.ts` verdrahteten `await import(...)`-Blöcke.
 *
 * Fault-Isolation: ein Fehlschlag (inkl. Transaktions-Rollback) wird geloggt und
 * übersprungen, ohne die übrigen Migrationen oder den Boot abzubrechen
 * (Reihenfolge = Array-Reihenfolge).
 */
export async function runOneTimeDataMigrations(phase: DataMigrationPhase): Promise<void> {
  const migrations =
    phase === "pre-budget"
      ? await buildPreBudgetRegistry()
      : await buildPostBudgetRegistry();

  for (const m of migrations) {
    try {
      await runGuardedBudgetMigration(m);
    } catch (err) {
      log(
        `[data-migration] '${m.name}' fehlgeschlagen (Transaktion zurückgerollt) — Boot wird fortgesetzt: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        "startup",
      );
    }
  }
}

/**
 * Baut die Registry der pre-budget Daten-Migrationen.
 *
 * Reihenfolge = bisherige Boot-Reihenfolge. KM-/Geo- und monthly_work_hours-
 * Typ-Migrationen zuerst (laufen wie bisher VOR `reconcileDriftedColumnTypes`).
 * Die drei GoBD-Backfills laufen mit `gobdBypass: true`; alle übrigen ohne.
 * `conservationCheck` ist für alle deaktiviert (keine Budget-Topf-Mutation).
 */
export async function buildPreBudgetRegistry(): Promise<GuardedBudgetMigration[]> {
  const { migrateKmGeoToNumeric } = await import("./migrate-km-geo-to-numeric");
  const { migrateMonthlyWorkHoursToNumeric } = await import("./migrate-monthly-work-hours-to-numeric");
  const { backfillOrphanReversalAppointmentId } = await import("./backfill-orphan-reversal-appointment-id");
  const { backfillStornoTransactionDate } = await import("./backfill-storno-transaction-date");
  const { backfillInvoiceIssuedAt } = await import("./backfill-invoice-issued-at");
  const { clear45bMonthlyLimits } = await import("./clear-45b-monthly-limits");
  const { migrateInProgressAppointments } = await import("./migrate-in-progress-appointments");
  const { migrateTaskStatusInProgress } = await import("./migrate-task-status-in-progress");
  const { migrateExpiredUnsignedAppointments } = await import("./migrate-expired-unsigned-appointments");
  const { dedupePendingMonthlyServiceRecords } = await import("./dedupe-pending-monthly-service-records");

  return [
    {
      name: "migrate-km-geo-to-numeric",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await migrateKmGeoToNumeric(tx);
      },
    },
    {
      name: "migrate-monthly-work-hours-to-numeric",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await migrateMonthlyWorkHoursToNumeric(tx);
      },
    },
    {
      name: "backfill-orphan-reversal-appointment-id",
      gobdBypass: true,
      conservationCheck: false,
      migrate: async (tx) => {
        await backfillOrphanReversalAppointmentId(undefined, tx);
      },
    },
    {
      name: "backfill-storno-transaction-date",
      gobdBypass: true,
      conservationCheck: false,
      migrate: async (tx) => {
        await backfillStornoTransactionDate(undefined, tx);
      },
    },
    {
      // #66 — ohne diesen Fix waeren Loeschschutz UND Nummernkreis fuer den
      // Bestand wirkungslos: `issued_at` kommt als NULL in die Welt, und die
      // Hochwassermarke wuerde erst beim ersten Zug eines Jahres geseedet.
      name: "backfill-invoice-issued-at",
      // KEIN GoBD-Bypass: auf `invoices` liegen nur ein DELETE- und ein
      // TRUNCATE-Trigger (`invoices_no_finalized_delete`, `..._no_truncate`),
      // kein UPDATE-Trigger. Dieser Backfill schreibt ausschliesslich UPDATEs
      // (plus INSERT in `invoice_number_sequence`, ungeschuetzt) — er laeuft
      // also gegen die aktiven Trigger durch. Der Bypass waere wirkungslos und
      // wuerde nur den Schutz fuer die Dauer der Transaktion abschalten.
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await backfillInvoiceIssuedAt(tx);
      },
    },
    {
      name: "clear-45b-monthly-limits",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async () => {
        await clear45bMonthlyLimits();
      },
    },
    {
      name: "migrate-in-progress-appointments",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await migrateInProgressAppointments(tx);
      },
    },
    {
      name: "migrate-task-status-in-progress",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await migrateTaskStatusInProgress(tx);
      },
    },
    {
      name: "migrate-expired-unsigned-appointments",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await migrateExpiredUnsignedAppointments(tx);
      },
    },
    {
      // Task #1534 — MUSS vor `ensureMonthlyServiceRecordPendingUnique`
      // (pre-budget-Phase läuft VOR der Index-Erstellung in server/index.ts)
      // laufen: konsolidiert bestehende Doppel-Monats-LNs, sonst scheitert der
      // partielle Unique-Index still an den Duplikaten.
      // monthly_service_records ist nicht GoBD-trigger-immutable (kein Bypass),
      // keine Budget-Topf-Mutation (kein Conservation-Check).
      name: "dedupe-pending-monthly-service-records-1534",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await dedupePendingMonthlyServiceRecords(tx);
      },
    },
  ];
}

/**
 * Baut die Registry der post-budget Daten-Migrationen.
 *
 * Reihenfolge = bisherige Boot-Reihenfolge. `migrateErstberatungCustomers`
 * MUSS vor `cleanupOrphanErstberatungCustomers` laufen (Waisen entstehen aus
 * der Migration). `migrateProspectStatuses` bleibt vor dem nicht-gegateten
 * `matchProspectsToCustomers` (in `server/index.ts`).
 * Keine dieser Migrationen berührt GoBD-Tabellen oder Budget-Töpfe
 * (`gobdBypass: false`, `conservationCheck: false`).
 */
export async function buildPostBudgetRegistry(): Promise<GuardedBudgetMigration[]> {
  const { restoreStornoDeletedServiceRecords } = await import("./restore-storno-deleted-service-records");
  const { migrateErstberatungCustomers } = await import("./migrate-erstberatung-customers");
  const { cleanupOrphanErstberatungCustomers } = await import("./cleanup-orphan-erstberatung-customers");
  const { migrateProspectStatuses } = await import("./migrate-prospect-statuses");
  const { migrateSchulungBesprechungToSonstiges } = await import("./migrate-schulung-besprechung-to-sonstiges");
  const { cleanupVacationOnHolidays } = await import("./cleanup-vacation-on-holidays");
  const { backfillNoShowKilometers } = await import("./backfill-no-show-kilometers");

  return [
    {
      name: "restore-storno-deleted-service-records",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await restoreStornoDeletedServiceRecords(tx);
      },
    },
    {
      name: "migrate-erstberatung-customers",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await migrateErstberatungCustomers(tx);
      },
    },
    {
      name: "cleanup-orphan-erstberatung-customers",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await cleanupOrphanErstberatungCustomers(tx);
      },
    },
    {
      name: "migrate-prospect-statuses",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await migrateProspectStatuses(tx);
      },
    },
    {
      name: "migrate-schulung-besprechung-to-sonstiges",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await migrateSchulungBesprechungToSonstiges(tx);
      },
    },
    {
      name: "cleanup-vacation-on-holidays",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await cleanupVacationOnHolidays(tx);
      },
    },
    {
      // Task #1565 — Backfill No-Show-Km auf die no_show_kilometers-SSoT.
      // appointments ist nicht GoBD-trigger-immutable (kein Bypass) und es
      // wird kein Budget-Topf verändert (kein Conservation-Check).
      name: "backfill-no-show-kilometers-1565",
      gobdBypass: false,
      conservationCheck: false,
      migrate: async (tx) => {
        await backfillNoShowKilometers(tx);
      },
    },
  ];
}
