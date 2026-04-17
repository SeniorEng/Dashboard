/**
 * Cleanup-Skript für Task #101: §45b – Doppelte Carryover-Allokationen entfernen
 *
 * Identifiziert automatische Carryover-Einträge, die durch einen späteren manuellen
 * Startwert obsolet wurden:
 *   - Carryover für Jahr Y+1, wenn für Jahr Y bereits ein `initial_balance` existiert.
 *
 * Solche Carryovers sind Doppelzählungen, da der Startwert das Restguthaben ab seinem
 * Stichmonat bereits abbildet.
 *
 * Aufruf:
 *   - Trockenlauf (Default):  tsx server/scripts/cleanup-duplicate-carryovers.ts
 *   - Scharf ausführen:       tsx server/scripts/cleanup-duplicate-carryovers.ts --apply
 */

import { eq, and, isNull, asc } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations, customers, users } from "@shared/schema";
import { auditService } from "../services/audit";

interface ObsoleteEntry {
  customerId: number;
  customerName: string;
  carryoverId: number;
  carryoverYear: number;
  carryoverAmountCents: number;
  initialBalanceYear: number;
  initialBalanceAmountCents: number;
  initialBalanceMonth: number | null;
}

async function findObsoleteCarryovers(): Promise<ObsoleteEntry[]> {
  const allCustomers = await db.select({ id: customers.id, vorname: customers.vorname, nachname: customers.nachname })
    .from(customers);

  const result: ObsoleteEntry[] = [];

  for (const c of allCustomers) {
    const allocs = await db.select()
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, c.id),
        eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
        isNull(budgetAllocations.deletedAt),
      ));

    const ibByYear = new Map<number, { amountCents: number; month: number | null }>();
    for (const a of allocs) {
      if (a.source === "initial_balance") {
        const existing = ibByYear.get(a.year);
        if (!existing || a.amountCents > existing.amountCents) {
          ibByYear.set(a.year, { amountCents: a.amountCents, month: a.month });
        }
      }
    }
    if (ibByYear.size === 0) continue;

    for (const a of allocs) {
      if (a.source !== "carryover") continue;
      const sourceYear = a.year - 1;
      const ib = ibByYear.get(sourceYear);
      if (!ib) continue;
      result.push({
        customerId: c.id,
        customerName: `${c.vorname ?? ""} ${c.nachname ?? ""}`.trim() || `#${c.id}`,
        carryoverId: a.id,
        carryoverYear: a.year,
        carryoverAmountCents: a.amountCents,
        initialBalanceYear: sourceYear,
        initialBalanceAmountCents: ib.amountCents,
        initialBalanceMonth: ib.month,
      });
    }
  }

  return result;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mode = apply ? "APPLY (scharf)" : "DRY-RUN (Default)";
  console.log(`\n=== Cleanup duplicate carryovers (${mode}) ===\n`);

  const obsolete = await findObsoleteCarryovers();

  if (obsolete.length === 0) {
    console.log("Keine doppelten Carryover-Einträge gefunden. Nichts zu tun.");
    return;
  }

  const byCustomer = new Map<number, ObsoleteEntry[]>();
  for (const e of obsolete) {
    const arr = byCustomer.get(e.customerId) ?? [];
    arr.push(e);
    byCustomer.set(e.customerId, arr);
  }

  console.log(`Betroffene Kunden: ${byCustomer.size}, obsolete Carryovers: ${obsolete.length}\n`);

  let auditUserId: number | null = null;
  if (apply) {
    const [admin] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.id))
      .limit(1);
    if (admin) auditUserId = admin.id;
    else console.warn("Warnung: Kein Admin-User gefunden – Audit-Logs werden übersprungen.");
  }

  for (const [customerId, entries] of byCustomer) {
    const name = entries[0].customerName;
    const totalBefore = entries.reduce((s, e) => s + e.carryoverAmountCents, 0);
    console.log(`Kunde #${customerId} (${name})`);
    for (const e of entries) {
      console.log(
        `  - Carryover ID=${e.carryoverId} Jahr=${e.carryoverYear} Betrag=${(e.carryoverAmountCents / 100).toFixed(2)} € ` +
        `→ obsolet wegen Startwert ${e.initialBalanceYear}` +
        (e.initialBalanceMonth ? `-${String(e.initialBalanceMonth).padStart(2, "0")}` : "") +
        ` (${(e.initialBalanceAmountCents / 100).toFixed(2)} €)`
      );
    }
    console.log(`  Summe Carryover (vorher) = ${(totalBefore / 100).toFixed(2)} €  →  (nachher) = 0,00 €`);

    if (apply) {
      for (const e of entries) {
        await db.update(budgetAllocations)
          .set({ deletedAt: new Date() })
          .where(eq(budgetAllocations.id, e.carryoverId));

        if (auditUserId == null) continue;
        await auditService.log(
          auditUserId,
          "budget_carryover_cleanup_soft_deleted",
          "budget",
          customerId,
          {
            customerId,
            allocationId: e.carryoverId,
            carryoverYear: e.carryoverYear,
            carryoverAmountCents: e.carryoverAmountCents,
            obsoleteReason: `Manueller Startwert für Jahr ${e.initialBalanceYear} überlagert automatischen Carryover (Task #101)`,
            initialBalanceYear: e.initialBalanceYear,
            initialBalanceAmountCents: e.initialBalanceAmountCents,
          },
          undefined,
        );
      }
      console.log(`  ✓ Soft-deleted (${entries.length})`);
    }
    console.log("");
  }

  if (!apply) {
    console.log("\nTrockenlauf abgeschlossen. Mit --apply scharf ausführen.");
  } else {
    console.log("\nCleanup abgeschlossen.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cleanup fehlgeschlagen:", err);
    process.exit(1);
  });
