import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "../lib/db";
import { budgetAllocations, customers, users } from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

/**
 * Task #1324 (A) — Gated Startup-Variante des manuellen Cleanup-Skripts
 * `server/scripts/cleanup-legacy-allocation-sources.ts`.
 *
 * `budget_allocations` soll nur noch MANUELLE Fakten enthalten
 * (`initial_balance`/`carryover`/`manual_adjustment`). Die früher zusätzlich
 * materialisierten Auto-Aufstockungen (`monthly_auto`/`yearly_auto`) werden nicht
 * mehr gelesen — die monatliche/jährliche Aufstockung wird rein rechnerisch
 * ermittelt (`calculateAllocated45b`/`…45a`/`…39_42a`). Diese Migration räumt die
 * verbliebenen AKTIVEN Auto-Zeilen auf.
 *
 * Abgrenzung zum Skript: Das Skript löscht vier Quellen
 * (`monthly_auto`/`monthly`/`yearly_auto`/`statutory_monthly`) inkl. bereits
 * soft-gelöschter Zeilen. Diese Migration ist enger auf den vereinbarten
 * Scope beschränkt — sie hard-löscht ausschließlich die AKTIVEN Zeilen
 * (`deleted_at IS NULL`) mit `source IN ('monthly_auto','yearly_auto')`.
 *
 * Sicherheit / Lauf-Garantien (über `runGuardedBudgetMigration`):
 *   - EINE Transaktion mit transaktions-lokalem GoBD-Bypass
 *     (`app.allow_gobd_mutation`) — der Wrapper setzt ihn (gobdBypass=true).
 *   - Conservation-Pre-/Post-Check (Rollback bei JEDER neu eingeführten
 *     Topf-Überziehung) — der Wrapper führt ihn aus (conservationCheck=true).
 *   - Exactly-once via Migrations-Ledger.
 *   - Idempotent: ein Re-Lauf findet keine aktiven Auto-Zeilen mehr ⇒ No-Op.
 *
 * Freigabe: registriert NUR bei gesetztem Flag
 * `APPROVED_CLEANUP_LEGACY_ALLOCATIONS` (=1/true). Default = nicht registriert ⇒
 * kein Ledger-Eintrag ⇒ kann nach erteilter Freigabe noch laufen.
 */
const LEGACY_AUTO_SOURCES = ["monthly_auto", "yearly_auto"] as const;

export async function cleanupLegacyAllocationSources(
  tx: Tx,
): Promise<BudgetMigrationSummary> {
  // 1. Aktive Auto-Allocation-Zeilen ermitteln.
  const rows = await tx
    .select({
      id: budgetAllocations.id,
      customerId: budgetAllocations.customerId,
      budgetType: budgetAllocations.budgetType,
      source: budgetAllocations.source,
      year: budgetAllocations.year,
      month: budgetAllocations.month,
      amountCents: budgetAllocations.amountCents,
    })
    .from(budgetAllocations)
    .where(
      and(
        inArray(budgetAllocations.source, [...LEGACY_AUTO_SOURCES]),
        isNull(budgetAllocations.deletedAt),
      ),
    )
    .orderBy(asc(budgetAllocations.customerId), asc(budgetAllocations.id));

  if (rows.length === 0) {
    return {
      changed: 0,
      note: "keine aktiven monthly_auto/yearly_auto-Allocation-Zeilen — No-Op",
    };
  }

  // 2. Pflicht-Audit-Akteur (ältester Superadmin, Fallback ältester Admin).
  const [superActor] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let actorId: number | null = superActor?.id ?? null;
  if (actorId == null) {
    const [adminActor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    actorId = adminActor?.id ?? null;
  }
  if (actorId == null) {
    log(
      "[budget-migration] cleanup-legacy-allocation-sources übersprungen: " +
        "kein Super-/Admin-Akteur für Audit-Log vorhanden.",
      "startup",
    );
    return { changed: 0, note: "kein Audit-Akteur — No-Op" };
  }
  const auditActorId = actorId;

  // 3. Hard-Delete der aktiven Auto-Zeilen. Der GoBD-Bypass ist durch den
  //    Guarded-Wrapper bereits transaktions-lokal gesetzt; der Conservation-
  //    Post-Check des Wrappers rollt bei einer neuen Überziehung zurück.
  const ids = rows.map((r) => r.id);
  await tx.delete(budgetAllocations).where(inArray(budgetAllocations.id, ids));

  // 4. Audit-Log je gelöschter Zeile (innerhalb derselben Transaktion).
  for (const r of rows) {
    await auditService.log(
      auditActorId,
      "budget_legacy_allocation_source_deleted",
      "budget",
      r.customerId,
      {
        customerId: r.customerId,
        allocationId: r.id,
        budgetType: r.budgetType,
        source: r.source,
        year: r.year,
        month: r.month,
        amountCents: r.amountCents,
        reason:
          "Task #1324 (A) — aktive Altlast-Auto-Allocation entfernt " +
          "(virtuelle Aufstockung ersetzt Materialisierung).",
      },
      undefined,
      tx,
    );
  }

  const totalCents = rows.reduce((sum, r) => sum + r.amountCents, 0);
  const note =
    `gelöscht=${ids.length} aktive Auto-Allocation-Zeile(n) ` +
    `(${LEGACY_AUTO_SOURCES.join("/")}), Σ=${totalCents}c`;
  log(`[budget-migration] cleanup-legacy-allocation-sources: ${note}`, "startup");

  return { changed: ids.length, note };
}
