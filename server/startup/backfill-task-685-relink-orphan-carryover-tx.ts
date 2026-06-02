import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "../lib/db";
import { budgetAllocations, budgetTransactions, users } from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";
import { parseLocalDate } from "@shared/utils/datetime";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

/**
 * Task #685 — Auflösung der vom Backfill #684 übersprungenen Doppel-
 * §45b-Carryover-Zeilen, an denen bereits `budget_transactions` hängen.
 *
 * Hintergrund: `backfillTask684OrphanAutoCarryovers` soft-löscht
 * Doppel-Carryovers pro (customer_id, year) und bevorzugt dabei die
 * User-erstellte / höher dotierte / ältere (kleinere ID) Zeile als
 * „Keep". Hat eine zu löschende Zeile bereits verlinkte Buchungen, wird
 * sie aus GoBD-Gründen NICHT angefasst — Storno-/Audit-Pfade würden ins
 * Leere zeigen.
 *
 * Dieser Backfill behandelt genau diese übersprungenen Fälle:
 *
 *   1) Gleiche Gruppen-/Sortier-Logik wie #684 (User-erstellt → höherer
 *      Betrag → kleinere ID) bestimmt die zu behaltende Zeile.
 *   2) Pro „Dupe mit verlinkten Tx" wird geprüft, ob ALLE verlinkten
 *      Buchungen im Gültigkeitsfenster der Keep-Zeile liegen
 *      (`keep.validFrom ≤ tx.transactionDate ≤ keep.expiresAt`). Liegt
 *      auch nur eine Buchung außerhalb, wird der Fall übersprungen
 *      (Log + Manuell-Flag), damit wir nie Buchungen an eine bereits
 *      abgelaufene Allokation umhängen.
 *   3) Andernfalls werden in EINEM Savepoint: alle Buchungen via
 *      UPDATE auf die Keep-Zeile umgehängt, pro Buchung ein
 *      `budget_transaction_corrected`-Audit geschrieben, die Dupe-Zeile
 *      soft-gelöscht und ein abschließendes
 *      `budget_allocation_soft_deleted`-Audit angelegt. Audit-Writes
 *      laufen mit `exec=savepoint`, damit ein gescheiterter Audit-Insert
 *      die gesamte Umhängung zurückrollt (GoBD: keine Mutation ohne
 *      Audit).
 *   4) Vollständig idempotent: nach einmaligem Lauf ist die Dupe-Zeile
 *      soft-gelöscht und taucht in der Gruppen-Suche nicht mehr auf.
 *
 * Akteur für die Audit-Einträge: bevorzugt der User, der die Dupe- oder
 * Keep-Zeile angelegt hat; Fallback ist der niedrigste Super-/Admin-
 * User (analog `restore-storno-deleted-service-records`). Ohne
 * verfügbaren Akteur wird der Fall übersprungen — keine Mutation ohne
 * Audit.
 *
 * Task #896 — Auf das Budget-Migrations-Framework migriert: läuft jetzt als
 * (tx) => BudgetMigrationSummary innerhalb EINER guarded Transaktion
 * (GoBD-Bypass + Conservation-Pre-/Post-Check). Die per-Dupe-Atomarität wird
 * über einen Savepoint (`tx.transaction`) gewahrt. MUSS NACH #684 registriert
 * sein — der dort gewählte Keep stimmt damit garantiert mit dem hier
 * gewählten überein.
 */
export async function backfillTask685RelinkOrphanCarryoverTx(tx: Tx): Promise<BudgetMigrationSummary> {
  const activeCarryovers = await tx
    .select()
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        eq(budgetAllocations.source, "carryover"),
        isNull(budgetAllocations.deletedAt),
      ),
    );

  if (activeCarryovers.length === 0) return { changed: 0, note: "keine Carryover-Zeilen" };

  const groups = new Map<string, typeof activeCarryovers>();
  for (const row of activeCarryovers) {
    const key = `${row.customerId}|${row.year}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  // Frühe Prüfung: gibt es überhaupt Duplikat-Gruppen?
  const hasDupes = Array.from(groups.values()).some((rows) => rows.length >= 2);
  if (!hasDupes) return { changed: 0, note: "keine Duplikat-Gruppen" };

  // System-Actor-Fallback (Super-/Admin) für Audits, wenn weder Dupe
  // noch Keep einen `createdByUserId` haben.
  const [superActor] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  let systemActorId: number | null = superActor?.id ?? null;
  if (systemActorId == null) {
    const [adminActor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    systemActorId = adminActor?.id ?? null;
  }

  let relinkedTxCount = 0;
  let softDeletedCount = 0;
  let skippedOutOfWindowCount = 0;
  let skippedNoActorCount = 0;
  const affectedCustomers = new Set<number>();

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;

    const sorted = [...rows].sort((a, b) => {
      const aHasUser = a.createdByUserId != null ? 0 : 1;
      const bHasUser = b.createdByUserId != null ? 0 : 1;
      if (aHasUser !== bHasUser) return aHasUser - bHasUser;
      if (a.amountCents !== b.amountCents) return b.amountCents - a.amountCents;
      return a.id - b.id;
    });

    const keep = sorted[0];
    const toResolve = sorted.slice(1);

    const keepValidFrom = parseLocalDate(keep.validFrom);
    const keepExpiresAt = keep.expiresAt ? parseLocalDate(keep.expiresAt) : null;

    for (const dupe of toResolve) {
      const linkedTx = await tx
        .select({
          id: budgetTransactions.id,
          transactionDate: budgetTransactions.transactionDate,
          amountCents: budgetTransactions.amountCents,
          transactionType: budgetTransactions.transactionType,
        })
        .from(budgetTransactions)
        .where(eq(budgetTransactions.allocationId, dupe.id));

      if (linkedTx.length === 0) continue; // wird von #684 abgedeckt

      // Safety: alle Tx-Daten müssen im Keep-Fenster liegen.
      const outOfWindow = linkedTx.filter((t) => {
        const d = parseLocalDate(t.transactionDate);
        if (d < keepValidFrom) return true;
        if (keepExpiresAt && d > keepExpiresAt) return true;
        return false;
      });
      if (outOfWindow.length > 0) {
        log(
          `[Backfill #685] Carryover-Allokation ${dupe.id} (Kunde ${dupe.customerId}) hat ${outOfWindow.length} Buchung(en) außerhalb des Keep-Fensters ${keep.validFrom}…${keep.expiresAt ?? "∞"} — überspringe Relink, manuelle Auflösung nötig.`,
          "startup",
        );
        skippedOutOfWindowCount++;
        continue;
      }

      const actorId =
        dupe.createdByUserId ?? keep.createdByUserId ?? systemActorId;
      if (actorId == null) {
        log(
          `[Backfill #685] Kein Akteur für Audit von Carryover-Allokation ${dupe.id} (Kunde ${dupe.customerId}) verfügbar — überspringe (keine Mutation ohne Audit).`,
          "startup",
        );
        skippedNoActorCount++;
        continue;
      }

      const txIds = linkedTx.map((t) => t.id);

      // Atomar pro Dupe (Savepoint): Relink + per-Tx-Audit + Soft-Delete +
      // Soft-Delete-Audit. Audit-Writes mit `exec=savepoint`, damit Fehler
      // die Umhängung dieses Dupes zurückrollen (GoBD: keine Mutation ohne
      // Audit-Eintrag).
      await tx.transaction(async (sp) => {
        await sp
          .update(budgetTransactions)
          .set({ allocationId: keep.id })
          .where(inArray(budgetTransactions.id, txIds));

        for (const txRow of linkedTx) {
          await auditService.log(
            actorId,
            "budget_transaction_corrected",
            "budget",
            dupe.customerId,
            {
              reason: "task_685_relinked_carryover_tx",
              task: "#685",
              transactionId: txRow.id,
              previousAllocationId: dupe.id,
              newAllocationId: keep.id,
              transactionDate: txRow.transactionDate,
              transactionType: txRow.transactionType,
              amountCents: txRow.amountCents,
              budgetType: "entlastungsbetrag_45b",
              source: "carryover",
              year: dupe.year,
            },
            undefined,
            sp,
          );
        }

        await sp
          .update(budgetAllocations)
          .set({ deletedAt: new Date() })
          .where(eq(budgetAllocations.id, dupe.id));

        await auditService.log(
          actorId,
          "budget_allocation_soft_deleted",
          "budget",
          dupe.customerId,
          {
            reason: "task_685_relinked_carryover_tx",
            task: "#685",
            deletedAllocationId: dupe.id,
            keptAllocationId: keep.id,
            budgetType: "entlastungsbetrag_45b",
            source: "carryover",
            year: dupe.year,
            deletedAmountCents: dupe.amountCents,
            keptAmountCents: keep.amountCents,
            deletedValidFrom: dupe.validFrom,
            deletedExpiresAt: dupe.expiresAt,
            keptValidFrom: keep.validFrom,
            keptExpiresAt: keep.expiresAt,
            relinkedTransactionIds: txIds,
          },
          undefined,
          sp,
        );
      });

      relinkedTxCount += linkedTx.length;
      softDeletedCount++;
      affectedCustomers.add(dupe.customerId);
    }
  }

  if (
    relinkedTxCount > 0 ||
    softDeletedCount > 0 ||
    skippedOutOfWindowCount > 0 ||
    skippedNoActorCount > 0
  ) {
    log(
      `Backfill #685: ${relinkedTxCount} Buchung(en) auf Keep-Allokation umgehängt, ${softDeletedCount} Dupe-Carryover soft-gelöscht (${affectedCustomers.size} Kunden), ${skippedOutOfWindowCount} außerhalb des Keep-Fensters übersprungen, ${skippedNoActorCount} ohne Akteur übersprungen.`,
      "startup",
    );
  }

  return {
    changed: softDeletedCount,
    note: `relinkedTx=${relinkedTxCount}, soft-deleted=${softDeletedCount}, skippedOutOfWindow=${skippedOutOfWindowCount}, skippedNoActor=${skippedNoActorCount}, customers=${affectedCustomers.size}`,
  };
}
