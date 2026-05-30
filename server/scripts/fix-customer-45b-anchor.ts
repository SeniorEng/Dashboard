/**
 * Task #856 — Datenfix: §45b-Startwert am Pflegegrad-Beginn verankern.
 *
 * Hintergrund: Bestandskunden, die VOR diesem Task angelegt wurden, haben ihren
 * §45b-Startwert (`budget_allocations.source = 'initial_balance'`) am
 * VERTRAGSbeginn statt am PFLEGEGRAD-Beginn sitzen. Da die Auto-Aufstockung
 * immer im Monat NACH dem spätesten Startwert beginnt, blockiert ein zu spät
 * sitzender Startwert die anrechenbaren Monate zwischen Pflegegrad- und
 * Vertragsbeginn.
 *
 * Beispiel Hannelore (Kunde #208): Pflegegrad ab März 2026, Vertrag ab Juni
 * 2026. Startwert sitzt fälschlich im Juni → März–Mai werden nicht aufgestockt.
 * Nach dem Fix: Startwert sitzt im März, April/Mai werden automatisch
 * aufgestockt → Verfügbar (Stand Mai 2026) = 3 × 131 € = 393 €.
 *
 * Was der Fix tut (idempotent, GoBD-konform):
 *  1. Frühesten Pflegegrad-Beginn aus `customer_care_level_history` lesen.
 *  2. Aufs rechtliche §45b-Carryover-/Verfalls-Fenster kappen
 *     (`clampDerived45bAnchor`) — ein weit zurückliegender Pflegegrad
 *     akkumuliert KEINE jahrelangen 131-€-Beträge.
 *  3. `budget_preferences.budget_start_date` auf das gekappte Datum setzen.
 *  4. Aktive §45b-`initial_balance`-Allokationen, die NICHT im Zielmonat sitzen,
 *     soft-deleten (Audit `budget_allocation_soft_deleted`).
 *  5. `initial_balance` im Zielmonat mit 131 € upserten (validFrom = Zieldatum,
 *     expiresAt = NULL — analog `/initial-budget`).
 *  6. Audit-Eintrag `budget_initial_setup` schreiben.
 *
 * Carryover-Zeilen (`source='carryover'`) werden NICHT angefasst — die regelt
 * der Auto-Pfad (`syncCarryoverAndExpiry`) beim nächsten Recompute selbst.
 *
 * Aufruf:
 *   tsx server/scripts/fix-customer-45b-anchor.ts                 # Dry-Run, Kunde 208
 *   tsx server/scripts/fix-customer-45b-anchor.ts --apply         # schreibend
 *   tsx server/scripts/fix-customer-45b-anchor.ts --customer=208  # anderer Kunde
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import {
  budgetAllocations,
  customerCareLevelHistory,
  users,
} from "@shared/schema";
import { budgetAllocationsRepo } from "../repos";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { auditService } from "../services/audit";
import { BUDGET_45B_MAX_MONTHLY_CENTS, clampDerived45bAnchor } from "@shared/domain/budgets";
import { parseLocalDate, todayISO } from "@shared/utils/datetime";

const BUDGET_TYPE = "entlastungsbetrag_45b" as const;

function parseCustomerId(): number {
  const arg = process.argv.find((a) => a.startsWith("--customer="));
  if (arg) {
    const n = Number(arg.split("=")[1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 208; // Default: Hannelore
}

async function findOperatorUserId(): Promise<number> {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isSuperAdmin, true))
    .limit(1);
  if (!u) throw new Error("Kein Superadmin gefunden — Operator für Audit-Log fehlt.");
  return u.id;
}

async function earliestCareLevelStart(customerId: number): Promise<string | null> {
  const rows = await db
    .select({ validFrom: customerCareLevelHistory.validFrom })
    .from(customerCareLevelHistory)
    .where(eq(customerCareLevelHistory.customerId, customerId))
    .orderBy(asc(customerCareLevelHistory.validFrom))
    .limit(1);
  return rows[0]?.validFrom ?? null;
}

async function main() {
  const customerId = parseCustomerId();
  const apply = process.argv.includes("--apply");

  console.log(`\n=== §45b-Pflegegrad-Anker-Fix · Kunde #${customerId} (Task #856) ===`);
  console.log(`Modus: ${apply ? "APPLY (schreibend)" : "DRY-RUN"}\n`);

  const pgStart = await earliestCareLevelStart(customerId);
  if (!pgStart) {
    console.warn(`[skip] Kunde #${customerId} hat keine Pflegegrad-Historie — nichts zu verankern.`);
    return;
  }

  const now = parseLocalDate(todayISO());
  const targetStart = clampDerived45bAnchor(pgStart, now.getFullYear(), now.getMonth() + 1);
  const targetDate = parseLocalDate(targetStart);
  const targetYear = targetDate.getFullYear();
  const targetMonth = targetDate.getMonth() + 1;

  console.log(`Frühester Pflegegrad-Beginn:   ${pgStart}`);
  console.log(`Gekappt aufs §45b-Fenster:     ${targetStart} (Jahr ${targetYear}, Monat ${targetMonth})`);

  // Aktive §45b-Startwerte (nur initial_balance — carryover bleibt unberührt).
  const existing = await budgetAllocationsRepo
    .selectFrom(db)
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, BUDGET_TYPE),
      eq(budgetAllocations.source, "initial_balance"),
      isNull(budgetAllocations.deletedAt),
    ));

  console.log(`\nAktive §45b-Startwerte: ${existing.length}`);
  for (const a of existing) {
    console.log(`  #${a.id}: ${a.year}-${String(a.month).padStart(2, "0")} · ${(a.amountCents / 100).toFixed(2)} € · validFrom ${a.validFrom}`);
  }

  const stale = existing.filter((a) => !(a.year === targetYear && a.month === targetMonth));
  const atTarget = existing.find((a) => a.year === targetYear && a.month === targetMonth);

  const alreadyCorrect =
    stale.length === 0 &&
    atTarget != null &&
    atTarget.amountCents === BUDGET_45B_MAX_MONTHLY_CENTS &&
    atTarget.validFrom === targetStart;

  if (alreadyCorrect) {
    console.log(`\n✓ Startwert sitzt bereits korrekt im Zielmonat — nichts zu tun (idempotent).`);
    // budgetStartDate trotzdem prüfen/setzen (siehe unten), daher kein early return.
  }

  if (!apply) {
    console.log(`\n[dry] WÜRDE:`);
    for (const a of stale) {
      console.log(`  - Startwert #${a.id} (${a.year}-${String(a.month).padStart(2, "0")}) soft-deleten`);
    }
    console.log(`  - Startwert im Zielmonat ${targetYear}-${String(targetMonth).padStart(2, "0")} auf ${(BUDGET_45B_MAX_MONTHLY_CENTS / 100).toFixed(2)} € setzen (validFrom ${targetStart})`);
    console.log(`  - budget_start_date auf ${targetStart} setzen`);
    console.log(`\nMit --apply ausführen.`);
    return;
  }

  const operatorUserId = await findOperatorUserId();

  // 1. Stale Startwerte soft-deleten (GoBD: kein Hard-Delete, kein Resurrect).
  for (const a of stale) {
    await db.update(budgetAllocations)
      .set({ deletedAt: new Date() })
      .where(eq(budgetAllocations.id, a.id));
    await auditService.log(operatorUserId, "budget_allocation_soft_deleted", "budget", customerId, {
      customerId,
      budgetType: BUDGET_TYPE,
      allocationId: a.id,
      reason: "Task #856: §45b-Startwert vom Vertragsbeginn auf Pflegegrad-Beginn verankert.",
      previousYearMonth: `${a.year}-${String(a.month).padStart(2, "0")}`,
      targetYearMonth: `${targetYear}-${String(targetMonth).padStart(2, "0")}`,
    });
    console.log(`  [ok ] Startwert #${a.id} soft-deleted.`);
  }

  // 2. Startwert im Zielmonat anlegen/aktualisieren (expiresAt = NULL, analog /initial-budget).
  await budgetLedgerStorage.upsertInitialBalanceAllocation({
    customerId,
    budgetType: BUDGET_TYPE,
    year: targetYear,
    month: targetMonth,
    amountCents: BUDGET_45B_MAX_MONTHLY_CENTS,
    validFrom: targetStart,
    expiresAt: null,
    notes: `Startguthaben ${targetYear} (Pflegegrad-Anker, Task #856)`,
  }, operatorUserId);
  console.log(`  [ok ] Startwert im Zielmonat ${targetYear}-${String(targetMonth).padStart(2, "0")} = ${(BUDGET_45B_MAX_MONTHLY_CENTS / 100).toFixed(2)} € gesetzt.`);

  // 3. budget_start_date verankern.
  await budgetLedgerStorage.upsertBudgetPreferences({
    customerId,
    budgetStartDate: targetStart,
  }, operatorUserId);
  console.log(`  [ok ] budget_start_date = ${targetStart} gesetzt.`);

  await auditService.log(operatorUserId, "budget_initial_setup", "budget", customerId, {
    customerId,
    budgetType: BUDGET_TYPE,
    budgetStartDate: targetStart,
    targetYearMonth: `${targetYear}-${String(targetMonth).padStart(2, "0")}`,
    amountCents: BUDGET_45B_MAX_MONTHLY_CENTS,
    softDeletedAllocationIds: stale.map((a) => a.id),
    reason: "Task #856: §45b-Startwert am Pflegegrad-Beginn verankert (Datenfix Bestandskunde).",
  });

  // 4. Carryover/Expiry-Recompute anstoßen, damit Auto-Pfad konsistent ist.
  await budgetLedgerStorage.syncCarryoverAndExpiry(customerId);
  console.log(`  [ok ] Carryover/Expiry neu synchronisiert.`);

  console.log(`\n✓ Fertig für Kunde #${customerId}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
