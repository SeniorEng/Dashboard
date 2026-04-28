import { eq, and, isNull, asc } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, customers, users } from "@shared/schema";
import { auditService } from "../services/audit";
import { log } from "../lib/log";

interface ObsoleteEntry {
  customerId: number;
  carryoverId: number;
  carryoverYear: number;
  carryoverAmountCents: number;
  initialBalanceYear: number;
  initialBalanceAmountCents: number;
}

async function findObsoleteCarryovers(): Promise<ObsoleteEntry[]> {
  const allCustomers = await db.select({ id: customers.id }).from(customers);
  const result: ObsoleteEntry[] = [];

  for (const c of allCustomers) {
    const allocs = await db.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, c.id),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        isNull(budgetAllocations.deletedAt),
      ));

    const ibByYear = new Map<number, number>();
    for (const a of allocs) {
      if (a.source === "initial_balance") {
        const existing = ibByYear.get(a.year);
        if (existing === undefined || a.amountCents > existing) {
          ibByYear.set(a.year, a.amountCents);
        }
      }
    }
    if (ibByYear.size === 0) continue;

    for (const a of allocs) {
      if (a.source !== "carryover") continue;
      const sourceYear = a.year - 1;
      const ibAmount = ibByYear.get(sourceYear);
      if (ibAmount === undefined) continue;
      result.push({
        customerId: c.id,
        carryoverId: a.id,
        carryoverYear: a.year,
        carryoverAmountCents: a.amountCents,
        initialBalanceYear: sourceYear,
        initialBalanceAmountCents: ibAmount,
      });
    }
  }

  return result;
}

export async function cleanupDuplicateCarryovers(): Promise<void> {
  const obsolete = await findObsoleteCarryovers();
  if (obsolete.length === 0) return;

  const [admin] = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(asc(users.id))
    .limit(1);
  const auditUserId = admin?.id ?? null;
  if (auditUserId == null) {
    log(
      `Carryover-Cleanup: ${obsolete.length} obsolete Allocations gefunden, aber kein Admin-User für Audit-Log – übersprungen`,
      "startup",
    );
    return;
  }

  log(
    `Carryover-Cleanup: ${obsolete.length} obsolete §45b-Carryovers gefunden, starte Bereinigung (Task #102)`,
    "startup",
  );

  let cleaned = 0;
  const cleanedCustomerIds = new Set<number>();
  for (const e of obsolete) {
    try {
      const updated = await db.update(budgetAllocations)
        .set({ deletedAt: new Date() })
        .where(and(
          eq(budgetAllocations.id, e.carryoverId),
          isNull(budgetAllocations.deletedAt),
        ))
        .returning({ id: budgetAllocations.id });
      if (updated.length === 0) continue;

      await auditService.log(
        auditUserId,
        "budget_carryover_cleanup_soft_deleted",
        "budget",
        e.customerId,
        {
          customerId: e.customerId,
          allocationId: e.carryoverId,
          carryoverYear: e.carryoverYear,
          carryoverAmountCents: e.carryoverAmountCents,
          obsoleteReason: `Manueller Startwert für Jahr ${e.initialBalanceYear} überlagert automatischen Carryover (Task #101)`,
          initialBalanceYear: e.initialBalanceYear,
          initialBalanceAmountCents: e.initialBalanceAmountCents,
          source: "startup_migration",
        },
        undefined,
      );
      cleaned++;
      cleanedCustomerIds.add(e.customerId);
    } catch (err) {
      log(
        `Carryover-Cleanup: Fehler bei Allocation #${e.carryoverId} (Kunde #${e.customerId}): ${err}`,
        "startup",
      );
    }
  }

  if (cleaned > 0) {
    log(
      `Carryover-Cleanup: ${cleaned}/${obsolete.length} doppelte §45b-Carryovers soft-deleted (${cleanedCustomerIds.size} Kunden, Task #102)`,
      "startup",
    );
  }
}
