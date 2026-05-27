import { and, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, budgetTransactions } from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";

/**
 * Task #684 — §45b-Carryover: Doppel-Allokationen (manuell + automatisch) für
 * dasselbe Quelljahr/Zieljahr bereinigen.
 *
 * Hintergrund: Der partielle Unique-Index auf `budget_allocations`
 * (`(customer_id, budget_type, year, month, source) WHERE deleted_at IS NULL`)
 * verhindert Duplikate NICHT, wenn `month IS NULL` — Postgres behandelt
 * NULL ≠ NULL in Unique-Constraints. Carryover-Zeilen haben `month=null`,
 * also konnten Auto- und Manuell-Pfad parallel zwei aktive Zeilen mit
 * gleichem `year=targetYear` erzeugen (z.B. eine alte 131 €-Auto-Zeile
 * blieb neben einer manuell gesetzten 344,50 €-Zeile bestehen → §45b-
 * Übersicht überzählte um exakt den Auto-Betrag).
 *
 * Dieser Backfill läuft beim Start idempotent:
 *   1) Gruppiere alle aktiven §45b-Carryover-Allokationen pro
 *      (customer_id, year) — was effektiv pro (Kunde, Quelljahr) ist.
 *   2) Bei ≥ 2 aktiven Zeilen pro Gruppe: bevorzugt User-erstellte
 *      (`created_by_user_id IS NOT NULL`); bei Gleichstand die mit höherem
 *      Betrag (manueller Wert üblicherweise > automatischer 131 €);
 *      Tiebreaker: kleinere ID (älter).
 *   3) Andere Zeilen → soft-deleted, Audit-Log
 *      `budget_allocation_soft_deleted` mit Begründung Task #684.
 *      Zeilen mit verlinkten `budget_transactions` werden übersprungen
 *      (manuelle Auflösung nötig).
 *
 * Nach dem Backfill greift der erweiterte Dedup in
 * `ensureYearlyCarryover45b` (aktiv + soft-gelöscht), sodass auch zukünftig
 * keine neuen Doppel-Carryovers entstehen.
 */
export async function backfillTask684OrphanAutoCarryovers(): Promise<void> {
  const activeCarryovers = await db
    .select()
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
      ),
    );

  if (activeCarryovers.length === 0) return;

  const groups = new Map<string, typeof activeCarryovers>();
  for (const row of activeCarryovers) {
    const key = `${row.customerId}|${row.year}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  let softDeletedCount = 0;
  let skippedLinkedCount = 0;
  const affectedCustomers = new Set<number>();

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;

    // Sortieren: User-erstellt zuerst → höchster Betrag → kleinste ID.
    const sorted = [...rows].sort((a, b) => {
      const aHasUser = a.createdByUserId != null ? 0 : 1;
      const bHasUser = b.createdByUserId != null ? 0 : 1;
      if (aHasUser !== bHasUser) return aHasUser - bHasUser;
      if (a.amountCents !== b.amountCents) return b.amountCents - a.amountCents;
      return a.id - b.id;
    });

    const keep = sorted[0];
    const toDelete = sorted.slice(1);

    for (const dupe of toDelete) {
      const linkedTx = await db
        .select({ id: budgetTransactions.id })
        .from(budgetTransactions)
        .where(eq(budgetTransactions.allocationId, dupe.id))
        .limit(1);

      if (linkedTx.length > 0) {
        log(
          `[Backfill #684] Carryover-Allokation ${dupe.id} (Kunde ${dupe.customerId}) hat verlinkte Transaktionen — überspringe Soft-Delete, manuelle Auflösung nötig.`,
          "startup",
        );
        skippedLinkedCount++;
        continue;
      }

      await db
        .update(budgetAllocations)
        .set({ deletedAt: new Date() })
        .where(eq(budgetAllocations.id, dupe.id));

      const actorId = dupe.createdByUserId ?? keep.createdByUserId ?? null;
      if (actorId != null) {
        await auditService.log(
          actorId,
          "budget_allocation_soft_deleted",
          "budget",
          dupe.customerId,
          {
            reason: "duplicate_auto_vs_manual_carryover",
            task: "#684",
            deletedAllocationId: dupe.id,
            keptAllocationId: keep.id,
            budgetType: "entlastungsbetrag_45b",
            source: "carryover",
            year: dupe.year,
            deletedAmountCents: dupe.amountCents,
            keptAmountCents: keep.amountCents,
            validFrom: dupe.validFrom,
            expiresAt: dupe.expiresAt,
          },
        );
      }

      softDeletedCount++;
      affectedCustomers.add(dupe.customerId);
    }
  }

  if (softDeletedCount > 0 || skippedLinkedCount > 0) {
    log(
      `Backfill #684: ${softDeletedCount} doppelte §45b-Carryover-Allokation(en) soft-gelöscht (${affectedCustomers.size} Kunden betroffen, ${skippedLinkedCount} mit verlinkten Tx übersprungen).`,
      "startup",
    );
  }
}
