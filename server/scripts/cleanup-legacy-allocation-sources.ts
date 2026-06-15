/**
 * Task #1289 (Phase 3.1) — Gated Cleanup der Altlast-Allocation-Quellen.
 *
 * `budget_allocations` soll nur noch MANUELLE Fakten enthalten
 * (`initial_balance`/`carryover`/`manual_adjustment`). Die früher zusätzlich
 * materialisierten Quellen `monthly_auto`, `monthly` (Pre-Enum-Schreibweise),
 * `yearly_auto` und `statutory_monthly` werden NICHT mehr gelesen — die
 * monatliche/jährliche Aufstockung wird rein rechnerisch ermittelt
 * (`calculateAllocated45b`/`…45a`/`…39_42a`). Dieses Skript räumt die
 * verbliebenen Altlast-Zeilen auf.
 *
 * ## Sicherheits-Design (mensch-gegated)
 *  - DRY-RUN (Default): erzeugt einen cent-exakten SCHATTEN-DIFF-REPORT je
 *    Kunde/Topf (Summe aktiver Altlast-Zeilen) und SIMULIERT die Konservierung
 *    NACH der Löschung. Erzeugt die Löschung eine NEUE Conservation-Verletzung
 *    (Topf würde überzogen), wird sie im Report markiert. Rein lesend.
 *  - `--apply`: löscht in EINER Transaktion mit GoBD-Bypass
 *    (`app.allow_gobd_mutation`), prüft Conservation PRE/POST und ROLLT ZURÜCK,
 *    sobald eine neue Verletzung entsteht. Jede Löschung wird im Audit-Log
 *    protokolliert.
 *
 * ## Betriebs-Reihenfolge (verbindlich)
 *  1. DRY-RUN ausführen, Report archivieren, von Alrik abnehmen lassen
 *     (Soll: 0 Cent Conservation-Differenz / keine neuen Verletzungen).
 *  2. ZUERST in Dev mit `--apply` (vorher `npm run db:backup-dev` als
 *     Restore-Pfad).
 *  3. Erst nach abgenommenem Report in Prod mit `--apply` (Pre-Publish-Backup
 *     gem. docs/pre-publish-backup-runbook.md vorhalten).
 *
 * Aufruf:
 *   - Trockenlauf (Default):  tsx server/scripts/cleanup-legacy-allocation-sources.ts
 *   - Scharf ausführen:       tsx server/scripts/cleanup-legacy-allocation-sources.ts --apply
 */

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, customers, users } from "@shared/schema";
import { auditService } from "../services/audit";
import {
  checkBudgetConservation,
  type ConservationResult,
} from "../lib/budget-conservation";

/** Die aus dem Enum entfernten Altlast-Quellen (inkl. Pre-Enum `monthly`). */
const LEGACY_SOURCES = ["monthly_auto", "monthly", "yearly_auto", "statutory_monthly"] as const;

interface LegacyRow {
  id: number;
  customerId: number;
  customerName: string;
  budgetType: string;
  source: string;
  year: number;
  month: number | null;
  amountCents: number;
  active: boolean;
}

async function loadLegacyRows(): Promise<LegacyRow[]> {
  const rows = await db
    .select({
      id: budgetAllocations.id,
      customerId: budgetAllocations.customerId,
      vorname: customers.vorname,
      nachname: customers.nachname,
      budgetType: budgetAllocations.budgetType,
      source: budgetAllocations.source,
      year: budgetAllocations.year,
      month: budgetAllocations.month,
      amountCents: budgetAllocations.amountCents,
      deletedAt: budgetAllocations.deletedAt,
    })
    .from(budgetAllocations)
    .leftJoin(customers, eq(customers.id, budgetAllocations.customerId))
    .where(inArray(budgetAllocations.source, [...LEGACY_SOURCES]))
    .orderBy(asc(budgetAllocations.customerId), asc(budgetAllocations.id));

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    customerName: `${r.vorname ?? ""} ${r.nachname ?? ""}`.trim() || `#${r.customerId}`,
    budgetType: r.budgetType,
    source: r.source,
    year: r.year,
    month: r.month,
    amountCents: r.amountCents,
    active: r.deletedAt == null,
  }));
}

const euro = (cents: number) => `${(cents / 100).toFixed(2)} €`;

/**
 * Cent-exakter Schatten-Diff: simuliert die Conservation NACH dem Entfernen der
 * aktiven Altlast-Zeilen und meldet jeden Topf, der dadurch NEU überzogen wäre.
 */
function simulatePostDeleteViolations(
  pre: ConservationResult,
  activeLegacyByPot: Map<string, number>,
): { key: string; allocatedBefore: number; allocatedAfter: number; netConsumed: number }[] {
  const newViolations: {
    key: string;
    allocatedBefore: number;
    allocatedAfter: number;
    netConsumed: number;
  }[] = [];
  for (const row of pre.potRows) {
    const key = `${row.customerId}|${row.budgetType}`;
    const removed = activeLegacyByPot.get(key) ?? 0;
    if (removed === 0) continue;
    const allocatedAfter = row.allocatedCents - removed;
    const overdrawnAfter = row.netConsumedCents > allocatedAfter;
    if (overdrawnAfter && !row.overdrawn) {
      newViolations.push({
        key,
        allocatedBefore: row.allocatedCents,
        allocatedAfter,
        netConsumed: row.netConsumedCents,
      });
    }
  }
  return newViolations;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mode = apply ? "APPLY (scharf)" : "DRY-RUN (Default)";
  console.log(`\n=== Cleanup Legacy-Allocation-Quellen (${mode}) ===\n`);
  console.log(`Altlast-Quellen: ${LEGACY_SOURCES.join(", ")}\n`);

  const legacy = await loadLegacyRows();

  if (legacy.length === 0) {
    console.log("Keine Altlast-Allocation-Zeilen gefunden. Nichts zu tun.");
    return;
  }

  // Aggregation für Report + Conservation-Simulation.
  const activeLegacyByPot = new Map<string, number>();
  const byCustomer = new Map<number, LegacyRow[]>();
  let totalActiveCents = 0;
  let activeCount = 0;
  for (const r of legacy) {
    const arr = byCustomer.get(r.customerId) ?? [];
    arr.push(r);
    byCustomer.set(r.customerId, arr);
    if (r.active) {
      const key = `${r.customerId}|${r.budgetType}`;
      activeLegacyByPot.set(key, (activeLegacyByPot.get(key) ?? 0) + r.amountCents);
      totalActiveCents += r.amountCents;
      activeCount++;
    }
  }

  console.log(
    `Betroffene Kunden: ${byCustomer.size} · Altlast-Zeilen gesamt: ${legacy.length} ` +
      `(aktiv: ${activeCount}, bereits soft-gelöscht: ${legacy.length - activeCount})`,
  );
  console.log(`Σ aktive Altlast-Allocation: ${euro(totalActiveCents)}\n`);

  // Schatten-Diff über die Conservation.
  const pre = await checkBudgetConservation(db);
  const simulated = simulatePostDeleteViolations(pre, activeLegacyByPot);

  for (const [customerId, rows] of byCustomer) {
    const name = rows[0].customerName;
    console.log(`Kunde #${customerId} (${name})`);
    for (const r of rows) {
      console.log(
        `  - ID=${r.id} ${r.budgetType} source=${r.source} ${r.year}` +
          (r.month ? `-${String(r.month).padStart(2, "0")}` : "") +
          ` ${euro(r.amountCents)}${r.active ? "" : " [soft-deleted]"}`,
      );
    }
    console.log("");
  }

  console.log("=== Schatten-Diff (Conservation) ===");
  if (simulated.length === 0) {
    console.log("✓ 0 Cent Auswirkung: keine NEUE Conservation-Verletzung durch die Löschung.\n");
  } else {
    console.log("✗ ACHTUNG — Löschung würde folgende Töpfe NEU überziehen:");
    for (const v of simulated) {
      console.log(
        `  - ${v.key}: allocated ${euro(v.allocatedBefore)} → ${euro(v.allocatedAfter)}, ` +
          `netConsumed ${euro(v.netConsumed)}`,
      );
    }
    console.log(
      "\nDiese Altlast-Zeilen TRAGEN aktiv Konsum (z. B. nie auf den virtuellen\n" +
        "Renewal-Pfad migriert). NICHT löschen, bevor das fachlich geklärt ist.\n",
    );
  }

  if (!apply) {
    console.log("Trockenlauf abgeschlossen. Report archivieren + abnehmen lassen, dann --apply.");
    return;
  }

  if (simulated.length > 0) {
    console.error(
      "ABBRUCH: --apply verweigert — die Löschung würde neue Conservation-Verletzungen erzeugen (s. o.).",
    );
    process.exitCode = 1;
    return;
  }

  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  if (!admin) {
    console.warn("Warnung: Kein Admin-User gefunden – Audit-Logs werden übersprungen.");
  }

  const ids = legacy.map((r) => r.id);
  await db.transaction(async (tx) => {
    // GoBD-Immutability-Trigger für budget_allocations transaktions-lokal lösen.
    await tx.execute(sql`SET LOCAL app.allow_gobd_mutation = 'on'`);
    await tx.delete(budgetAllocations).where(inArray(budgetAllocations.id, ids));

    // Verbindlicher Post-Check INNERHALB der Transaktion — Rollback bei neuer Verletzung.
    const post = await checkBudgetConservation(tx);
    const preKeys = new Set(pre.potViolationKeys);
    const newViolations = post.potViolationKeys.filter((k) => !preKeys.has(k));
    if (newViolations.length > 0) {
      throw new Error(
        `Conservation-Verletzung nach Löschung — Rollback. Neu überzogene Töpfe: ${newViolations.join(", ")}`,
      );
    }
  });

  if (admin) {
    for (const r of legacy.filter((x) => x.active)) {
      await auditService.log(
        admin.id,
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
            "Task #1289 Phase 3.1 — Altlast-Allocation-Quelle entfernt (virtuelle Aufstockung ersetzt Materialisierung).",
        },
        undefined,
      );
    }
  }

  console.log(`\n✓ Gelöscht: ${ids.length} Altlast-Allocation-Zeile(n). Conservation unverändert.`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("Cleanup fehlgeschlagen:", err);
    process.exit(1);
  });
