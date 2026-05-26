import { and, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, budgetTransactions } from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";

/**
 * Task #601 — Backfill: Duplikate §45b-Carryover (Wizard vs Auto).
 *
 * Vor #601 schrieben zwei Pfade Carryover-Zeilen mit unterschiedlichen
 * `year`-Konventionen:
 *   - Wizard / POST /initial-budget / customer-creation-helpers:
 *     `year = sourceYear` (z.B. 2025)
 *   - Auto (`ensureYearlyCarryover45b`):
 *     `year = targetYear` (z.B. 2026)
 * Der Dedup-Check im Auto-Pfad verglich nur `year` und hat die Wizard-Zeile
 * nicht erkannt → für jeden betroffenen Kunden gibt es bis zu zwei
 * lebende Carryover-Zeilen für dasselbe Zielfenster
 * (`validFrom = YYYY-01-01`, `expiresAt = YYYY-06-30`).
 *
 * Dieser Backfill läuft beim Start idempotent:
 *   1) Lade alle lebenden §45b-Carryover-Allokationen (`deleted_at IS NULL`).
 *   2) Gruppiere pro (customer_id, validFrom, expiresAt).
 *   3) In Gruppen mit ≥ 2 Zeilen: behalte genau eine — bevorzugt die
 *      User-erstellte (`created_by_user_id IS NOT NULL`); bei Gleichstand
 *      die mit kleinster ID (frühester Insert ist die manuell vom Wizard
 *      geschriebene Zeile, die Auto-Zeile kam erst beim ersten
 *      `syncCarryoverAndExpiry` danach).
 *   4) Andere Zeilen werden soft-gelöscht (`deleted_at = NOW()`). Falls
 *      `budget_transactions.allocation_id` auf eine zu löschende Zeile
 *      verweist (unwahrscheinlich, weil §45b-Buchungen nicht an
 *      Carryover-Allokationen gebunden werden — Allokations-FK wird nur für
 *      `umwandlung_45a` und `ersatzpflege_39_42a` gesetzt), wird die Zeile
 *      übersprungen und nur ein Warning geloggt — manuelle Auflösung
 *      erforderlich. Soft-Delete schreibt einen Audit-Log-Eintrag mit
 *      `reason: "duplicate_carryover_wizard_vs_auto"`.
 *
 * Nach dem Backfill greift der harte Dedup in
 * `ensureYearlyCarryover45b` (Year + validFrom/expiresAt-Fenster), sodass
 * keine neuen Duplikate entstehen.
 */
export async function backfillDuplicateWizardCarryovers(): Promise<void> {
  const allCarryovers = await db
    .select()
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
      ),
    );

  if (allCarryovers.length === 0) return;

  // Gruppe-Key: customer_id|validFrom|expiresAt
  const groups = new Map<string, typeof allCarryovers>();
  for (const row of allCarryovers) {
    const key = `${row.customerId}|${row.validFrom}|${row.expiresAt ?? ""}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  let softDeletedCount = 0;
  let skippedLinkedCount = 0;
  const affectedCustomers = new Set<number>();

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;

    // Reihenfolge: User-erstellt zuerst, dann nach ID asc → der erste
    // Eintrag wird behalten, alle weiteren sind Kandidaten für Soft-Delete.
    const sorted = [...rows].sort((a, b) => {
      const aHasUser = a.createdByUserId != null ? 0 : 1;
      const bHasUser = b.createdByUserId != null ? 0 : 1;
      if (aHasUser !== bHasUser) return aHasUser - bHasUser;
      return a.id - b.id;
    });

    const keep = sorted[0];
    const toDelete = sorted.slice(1);

    for (const dupe of toDelete) {
      // Schutz: niemals eine Zeile soft-löschen, an der noch Transaktionen
      // hängen — sonst würden Storno-/Audit-Pfade ins Leere zeigen.
      const linkedTx = await db
        .select({ id: budgetTransactions.id })
        .from(budgetTransactions)
        .where(eq(budgetTransactions.allocationId, dupe.id))
        .limit(1);

      if (linkedTx.length > 0) {
        log(
          `[Backfill #601] Carryover-Allokation ${dupe.id} (Kunde ${dupe.customerId}) hat verlinkte Transaktionen — überspringe Soft-Delete, manuelle Auflösung nötig.`,
          "startup",
        );
        skippedLinkedCount++;
        continue;
      }

      await db
        .update(budgetAllocations)
        .set({ deletedAt: new Date() })
        .where(eq(budgetAllocations.id, dupe.id));

      // Audit: actorId = createdByUserId der zu löschenden Zeile (User, der
      // die Duplikat-Zeile angelegt hat); falls NULL (Auto-Pfad), nehmen wir
      // den createdByUserId der behaltenen Zeile als Actor. Beides NULL →
      // wir überspringen den Audit-Schreib, weil `auditService.log` einen
      // numerischen User-FK verlangt; das Soft-Delete passiert trotzdem und
      // landet im Startup-Log.
      const actorId = dupe.createdByUserId ?? keep.createdByUserId ?? null;
      if (actorId != null) {
        await auditService.log(
          actorId,
          "budget_allocation_soft_deleted",
          "budget",
          dupe.customerId,
          {
            reason: "duplicate_carryover_wizard_vs_auto",
            deletedAllocationId: dupe.id,
            keptAllocationId: keep.id,
            budgetType: "entlastungsbetrag_45b",
            source: "carryover",
            year: dupe.year,
            keptYear: keep.year,
            validFrom: dupe.validFrom,
            expiresAt: dupe.expiresAt,
            amountCents: dupe.amountCents,
            task: "#601",
          },
        );
      }

      softDeletedCount++;
      affectedCustomers.add(dupe.customerId);
    }
  }

  if (softDeletedCount > 0 || skippedLinkedCount > 0) {
    log(
      `Backfill #601: ${softDeletedCount} doppelte §45b-Carryover-Allokation(en) soft-gelöscht (${affectedCustomers.size} Kunden betroffen, ${skippedLinkedCount} mit verlinkten Tx übersprungen).`,
      "startup",
    );
  }
}
