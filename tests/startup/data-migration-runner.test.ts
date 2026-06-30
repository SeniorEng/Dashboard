/**
 * Task #1428 — Exactly-once-Gating einmaliger, NICHT-Budget Daten-Migrationen
 * über DENSELBEN `runGuardedBudgetMigration`-Wrapper (und damit denselben
 * `budget_migrations`-Ledger) wie die Budget-Migrationen.
 *
 * Das eigentliche „applies-once-then-skips"- und Transaktions-/Re-Arm-Verhalten
 * wird zentral im Wrapper getestet (`tests/startup/budget-migration-runner*`).
 * Dieser Test verifiziert ausschließlich, dass die NICHT-Budget-Registry korrekt
 * gebaut wird:
 *  - vollständig (alle 15 Migrationen, korrekte Reihenfolge, eindeutige Namen),
 *  - GoBD-Bypass NUR für die drei GoBD-budget_transactions-Backfills aktiv,
 *  - Conservation-Check für ALLE deaktiviert (keine Budget-Topf-Mutation),
 *  - jede Migration liefert einen ausführbaren `migrate(tx)`-Callback.
 */
import { describe, it, expect } from "vitest";
import {
  buildPreBudgetRegistry,
  buildPostBudgetRegistry,
} from "../../server/startup/data-migration-runner";

const PRE_BUDGET_ORDER = [
  "migrate-km-geo-to-numeric",
  "migrate-monthly-work-hours-to-numeric",
  "backfill-orphan-reversal-appointment-id",
  "backfill-storno-transaction-date",
  "backfill-avis-received-status",
  "clear-45b-monthly-limits",
  "migrate-in-progress-appointments",
  "migrate-task-status-in-progress",
  "migrate-expired-unsigned-appointments",
  "dedupe-pending-monthly-service-records-1534",
];

const POST_BUDGET_ORDER = [
  "restore-storno-deleted-service-records",
  "migrate-erstberatung-customers",
  "cleanup-orphan-erstberatung-customers",
  "migrate-prospect-statuses",
  "migrate-schulung-besprechung-to-sonstiges",
  "cleanup-vacation-on-holidays",
];

// GoBD-Bypass darf NUR für die drei Backfills aktiv sein, die GoBD-historisierte
// budget_transactions-/Avis-Daten mutieren.
const GOBD_BYPASS_NAMES = new Set([
  "backfill-orphan-reversal-appointment-id",
  "backfill-storno-transaction-date",
  "backfill-avis-received-status",
]);

describe("Task #1428 — NICHT-Budget Daten-Migrations-Registry", () => {
  it("pre-budget: vollständig, geordnet, eindeutige Namen", async () => {
    const registry = await buildPreBudgetRegistry();
    expect(registry.map((m) => m.name)).toEqual(PRE_BUDGET_ORDER);
    expect(new Set(registry.map((m) => m.name)).size).toBe(registry.length);
  });

  it("post-budget: vollständig, geordnet, eindeutige Namen", async () => {
    const registry = await buildPostBudgetRegistry();
    expect(registry.map((m) => m.name)).toEqual(POST_BUDGET_ORDER);
    expect(new Set(registry.map((m) => m.name)).size).toBe(registry.length);
  });

  it("registriert genau 16 NICHT-Budget Migrationen mit eindeutigen Namen", async () => {
    const [pre, post] = await Promise.all([
      buildPreBudgetRegistry(),
      buildPostBudgetRegistry(),
    ]);
    const all = [...pre, ...post];
    expect(all).toHaveLength(16);
    expect(new Set(all.map((m) => m.name)).size).toBe(16);
  });

  it("aktiviert GoBD-Bypass NUR für die drei GoBD-Backfills", async () => {
    const [pre, post] = await Promise.all([
      buildPreBudgetRegistry(),
      buildPostBudgetRegistry(),
    ]);
    for (const m of [...pre, ...post]) {
      expect(m.gobdBypass).toBe(GOBD_BYPASS_NAMES.has(m.name));
    }
  });

  it("deaktiviert den Conservation-Check für ALLE NICHT-Budget Migrationen", async () => {
    const [pre, post] = await Promise.all([
      buildPreBudgetRegistry(),
      buildPostBudgetRegistry(),
    ]);
    for (const m of [...pre, ...post]) {
      expect(m.conservationCheck).toBe(false);
    }
  });

  it("liefert für jede Migration einen ausführbaren migrate(tx)-Callback", async () => {
    const [pre, post] = await Promise.all([
      buildPreBudgetRegistry(),
      buildPostBudgetRegistry(),
    ]);
    for (const m of [...pre, ...post]) {
      expect(typeof m.migrate).toBe("function");
    }
  });
});
