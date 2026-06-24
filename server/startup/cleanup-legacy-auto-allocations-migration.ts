import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "../lib/db";
import {
  budgetAllocations,
  budgetTransactions,
  budgetReservations,
  budgetLedger,
  users,
} from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

/**
 * Task #1409 — Gegatete Startup-Variante des früheren manuellen Cleanup-Skripts
 * (`server/scripts/cleanup-legacy-allocation-sources.ts`, seit Task #1416
 * entfernt). ERSETZT die frühere `cleanup-legacy-allocation-sources-1324`-
 * Migration (nackter Delete) durch den GoBD-konformen FK-Null-dann-Delete-Pfad.
 *
 * `budget_allocations` soll nur noch MANUELLE Fakten enthalten
 * (`initial_balance`/`carryover`/`manual_adjustment`). Die früher zusätzlich
 * materialisierten Auto-Aufstockungen (`monthly_auto`/`yearly_auto`) werden nicht
 * mehr gelesen — die monatliche/jährliche Aufstockung wird rein rechnerisch
 * ermittelt (`calculateAllocated45b`/`…45a`/`…39_42a`). Diese Migration räumt die
 * verbliebenen AKTIVEN Auto-Zeilen auf.
 *
 * ## Warum FK-Null-dann-Delete (nicht nackter Delete)
 * Einige `budget_transactions` (GoBD-immutable, append-only) zeigen über ihre
 * `allocation_id`-FK noch auf diese Altlast-Auto-Zeilen. Ein nackter
 * `DELETE budget_allocations` würde am FK scheitern (oder — schlimmer — eine
 * Buchungs-Zeile mitlöschen). Daher wird ZUERST der INTERNE FK-Zeiger genullt
 * (`allocation_id = NULL` auf den referenzierenden Buchungen) und DANN die
 * Allocation hart gelöscht. Es wird NIEMALS eine `budget_transactions`-Zeile
 * gelöscht (GoBD).
 *
 * ## Warum das Nullen conservation-invariant ist (Δ=0)
 * Die App-Reader lesen `allocation_id` AUSSCHLIESSLICH für die §45b-Spezial-Sets
 * (`carryover`/`initial_balance`-Spezial-Allokationen in consumption-engine,
 * summary-queries, fifo-breakdown, net-available-45b). Auto-Allocations sind NIE
 * Teil dieser Sets. Der Netto-Konsum eines Topfes wird per `budget_type`
 * aggregiert (NICHT per `allocation_id`), und die projizierte Allocation
 * (`readUnifiedBudgetAvailability`) liest Auto-Zeilen ohnehin nicht. Sowohl das
 * Nullen der FK als auch das Löschen der Auto-Zeilen lassen damit jede
 * (Kunde, Topf)-Verfügbarkeit unverändert ⇒ Conservation-Δ=0.
 *
 * Defensiv werden auch `budget_reservations`/`budget_ledger` geprüft und ihre
 * `allocation_id` genullt, falls sie referenzieren — sonst blockiert die FK den
 * Delete. In Prod ist das 0 Zeilen; diese beiden Tabellen tragen KEINEN
 * GoBD-Immutability-Trigger.
 *
 * ## Sicherheit / Lauf-Garantien (über `runGuardedBudgetMigration`)
 *   - EINE Transaktion mit transaktions-lokalem GoBD-Bypass
 *     (`app.allow_gobd_mutation`) — der Wrapper setzt ihn (gobdBypass=true).
 *     Dieser Bypass deckt sowohl das `budget_transactions`-UPDATE als auch den
 *     `budget_allocations`-DELETE (gleiches GUC).
 *   - Conservation-Pre-/Post-Check (Rollback bei JEDER neu eingeführten
 *     Topf-Überziehung) — der Wrapper führt ihn aus (conservationCheck=true).
 *   - Exactly-once via Migrations-Ledger.
 *   - Idempotent: ein Re-Lauf findet keine aktiven Auto-Zeilen mehr ⇒ No-Op.
 *
 * Abgrenzung zum Skript: Das Skript löscht vier Quellen
 * (`monthly_auto`/`monthly`/`yearly_auto`/`statutory_monthly`) inkl. bereits
 * soft-gelöschter Zeilen. Diese Migration ist enger auf den vereinbarten Scope
 * beschränkt — sie hard-löscht ausschließlich die AKTIVEN Zeilen
 * (`deleted_at IS NULL`) mit `source IN ('monthly_auto','yearly_auto')`.
 *
 * Freigabe: registriert NUR bei gesetztem Flag
 * `APPROVED_CLEANUP_LEGACY_AUTO_ALLOCATIONS_1409` (=1/true). Default = nicht
 * registriert ⇒ kein Ledger-Eintrag ⇒ kann nach erteilter Freigabe noch laufen.
 */
const LEGACY_AUTO_SOURCES = ["monthly_auto", "yearly_auto"] as const;

export async function cleanupLegacyAutoAllocations(
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
  const ids = rows.map((r) => r.id);

  // 2. Referenzierende GoBD-Buchungen ermitteln (deren interner FK-Zeiger wird
  //    genullt — die Buchungs-Zeile selbst bleibt unangetastet).
  const refTx = await tx
    .select({
      id: budgetTransactions.id,
      customerId: budgetTransactions.customerId,
      budgetType: budgetTransactions.budgetType,
      transactionType: budgetTransactions.transactionType,
      transactionDate: budgetTransactions.transactionDate,
      amountCents: budgetTransactions.amountCents,
      allocationId: budgetTransactions.allocationId,
    })
    .from(budgetTransactions)
    .where(inArray(budgetTransactions.allocationId, ids))
    .orderBy(asc(budgetTransactions.id));

  // Defensiv: operative/interim Tabellen, deren FK den Delete sonst blockt.
  const refReservations = await tx
    .select({ id: budgetReservations.id })
    .from(budgetReservations)
    .where(inArray(budgetReservations.allocationId, ids));
  const refLedger = await tx
    .select({ id: budgetLedger.id })
    .from(budgetLedger)
    .where(inArray(budgetLedger.allocationId, ids));

  // 3. Pflicht-Audit-Akteur (ältester Superadmin, Fallback ältester Admin).
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
      "[budget-migration] cleanup-legacy-auto-allocations übersprungen: " +
        "kein Super-/Admin-Akteur für Audit-Log vorhanden.",
      "startup",
    );
    return { changed: 0, note: "kein Audit-Akteur — No-Op" };
  }
  const auditActorId = actorId;

  // 4. INTERNEN FK-Zeiger nullen — ZUERST auf den GoBD-Buchungen, defensiv auch
  //    auf den operativen/interim Tabellen. budget_reservations/budget_ledger
  //    tragen keinen Trigger. Der GoBD-Bypass des Wrappers deckt das
  //    budget_transactions-UPDATE bereits; wir setzen den Bypass-GUC hier
  //    transaktions-lokal NOCHMALS explizit (idempotent) — bewusster,
  //    audit-pflichtiger Korrekturpfad, sichtbar für den Append-only-Wächter.
  await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
  if (refTx.length > 0) {
    await tx
      .update(budgetTransactions)
      .set({ allocationId: null })
      .where(
        inArray(
          budgetTransactions.id,
          refTx.map((t) => t.id),
        ),
      );
  }
  if (refReservations.length > 0) {
    await tx
      .update(budgetReservations)
      .set({ allocationId: null })
      .where(
        inArray(
          budgetReservations.id,
          refReservations.map((r) => r.id),
        ),
      );
  }
  if (refLedger.length > 0) {
    await tx
      .update(budgetLedger)
      .set({ allocationId: null })
      .where(
        inArray(
          budgetLedger.id,
          refLedger.map((r) => r.id),
        ),
      );
  }

  // 5. Hard-Delete der aktiven Auto-Zeilen (FK ist nun frei). Der GoBD-Bypass
  //    ist durch den Wrapper transaktions-lokal gesetzt; der Conservation-
  //    Post-Check des Wrappers rollt bei einer neuen Überziehung zurück.
  await tx.delete(budgetAllocations).where(inArray(budgetAllocations.id, ids));

  // 6. Audit-Log je genullter Buchung + je gelöschter Allocation-Zeile
  //    (innerhalb derselben Transaktion ⇒ keine Mutation ohne Audit).
  for (const t of refTx) {
    await auditService.log(
      auditActorId,
      "budget_legacy_allocation_link_cleared",
      "budget",
      t.customerId,
      {
        customerId: t.customerId,
        transactionId: t.id,
        previousAllocationId: t.allocationId,
        budgetType: t.budgetType,
        transactionType: t.transactionType,
        transactionDate: t.transactionDate,
        amountCents: t.amountCents,
        reason:
          "Task #1409 — interner FK-Zeiger auf Altlast-Auto-Allocation genullt " +
          "(Buchungs-Zeile bleibt GoBD-konform erhalten).",
      },
      undefined,
      tx,
    );
  }
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
          "Task #1409 — aktive Altlast-Auto-Allocation entfernt " +
          "(virtuelle Aufstockung ersetzt Materialisierung).",
      },
      undefined,
      tx,
    );
  }

  const totalCents = rows.reduce((sum, r) => sum + r.amountCents, 0);
  const note =
    `gelöscht=${ids.length} aktive Auto-Allocation-Zeile(n) ` +
    `(${LEGACY_AUTO_SOURCES.join("/")}), Σ=${totalCents}c, ` +
    `genullte Buchungen=${refTx.length}` +
    (refReservations.length > 0
      ? `, Reservierungen=${refReservations.length}`
      : "") +
    (refLedger.length > 0 ? `, Ledger=${refLedger.length}` : "");
  log(`[budget-migration] cleanup-legacy-auto-allocations: ${note}`, "startup");

  return { changed: ids.length, note };
}
