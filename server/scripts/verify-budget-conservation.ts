/**
 * Task #871 — Read-only Conservation-Verifier (Invariante I13) für die Budget-
 * Domäne (Budget GF Phase 1).
 *
 * Dieser Report ÄNDERT NICHTS (nur `db.select`) und ist prod-runnable. Er prüft
 * die Erhaltungs-Invarianten, die im Drei-Tabellen-Modell IMMER gelten müssen:
 *
 *  (1) Kein Topf ist überzogen: pro (Kunde, budgetType) gilt
 *        NettoKonsum  ≤  Σ Allocated
 *      mit NettoKonsum = Σ|consumption| + Σ|write_off| − Σ|reversal| aus
 *      `budget_transactions` (der heutige Live-Engine-Ledger) und Σ Allocated =
 *      Σ aktiver `budget_allocations`. (I13: Allocated − Consumed = Available ≥ 0.)
 *
 *  (2) Reservation ↔ Ledger Kreuzcheck: jede `captured`-Reservierung MUSS auf
 *      eine existierende `budget_ledger`-Zeile zeigen, und jeder Ledger-Storno
 *      (`reverses_ledger_id`) MUSS auf eine existierende Ledger-Zeile zeigen.
 *      (In Phase 1 sind beide Tabellen leer → Check trivially grün, die Logik
 *      ist für Phase 2+ bereits scharf.)
 *
 * WICHTIG: I13 wird als NICHT-Überziehung geprüft, NICHT als strikte Gleichheit
 * `Allocated − Consumed == Available`. Wo statutarische Caps (§45a/§39+§42a)
 * binden, ist die nutzbare Verfügbarkeit kleiner als Allocated − Consumed; eine
 * strikte Gleichheit würde dort fälschlich anschlagen. Die Erhaltung, die immer
 * hält, ist „kein Topf wird über seine Allocation hinaus konsumiert".
 *
 * Aufruf:
 *   tsx server/scripts/verify-budget-conservation.ts             # nur Verletzungen
 *   tsx server/scripts/verify-budget-conservation.ts --all       # alle (Kunde,Topf)-Paare
 *
 * Exit-Code: 0 = alle Invarianten halten, 1 = mindestens eine Verletzung.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  budgetTransactions,
  budgetAllocations,
  budgetLedger,
  budgetReservations,
} from "@shared/schema";

const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

// Der Selbstzahler-Overflow-Topf hat per Design KEINE Allocation — er absorbiert
// den Cascade-Rest (uncapped). Für die No-Overdraw-Invariante ist er irrelevant.
const UNCAPPED_POTS = new Set(["private", "selbstzahler"]);

async function checkPotConservation(showAll: boolean): Promise<number> {
  // Netto-Konsum je (Kunde, Topf) aus dem Live-Engine-Ledger.
  const consumedRows = await db
    .select({
      customerId: budgetTransactions.customerId,
      budgetType: budgetTransactions.budgetType,
      consumed: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})) FILTER (WHERE ${budgetTransactions.transactionType} IN ('consumption','write_off')), 0)`,
      reversed: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})) FILTER (WHERE ${budgetTransactions.transactionType} = 'reversal'), 0)`,
    })
    .from(budgetTransactions)
    .groupBy(budgetTransactions.customerId, budgetTransactions.budgetType);

  // Σ aktiver Allocations je (Kunde, Topf).
  const allocatedRows = await db
    .select({
      customerId: budgetAllocations.customerId,
      budgetType: budgetAllocations.budgetType,
      allocated: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)`,
    })
    .from(budgetAllocations)
    .where(isNull(budgetAllocations.deletedAt))
    .groupBy(budgetAllocations.customerId, budgetAllocations.budgetType);

  const allocatedMap = new Map<string, number>();
  for (const r of allocatedRows) {
    allocatedMap.set(`${r.customerId}|${r.budgetType}`, Number(r.allocated));
  }

  let violations = 0;
  let checked = 0;

  for (const r of consumedRows) {
    if (UNCAPPED_POTS.has(r.budgetType)) continue;
    const key = `${r.customerId}|${r.budgetType}`;
    const allocated = allocatedMap.get(key) ?? 0;
    const netConsumed = Math.max(0, Number(r.consumed) - Number(r.reversed));
    const available = allocated - netConsumed;
    const overdrawn = netConsumed > allocated;
    checked++;

    if (overdrawn) violations++;
    if (overdrawn || showAll) {
      const flag = overdrawn ? "✗" : " ";
      console.log(
        `${flag} #${r.customerId} ${r.budgetType.padEnd(22)} ` +
        `Allocated ${euro(allocated)} − Konsum ${euro(netConsumed)} = ${euro(available)}` +
        (overdrawn ? `  ⚠ ÜBERZOGEN um ${euro(-available)}` : ""),
      );
    }
  }

  console.log(`\n  Geprüfte (Kunde,Topf)-Paare: ${checked} · Überzogen: ${violations}`);
  return violations;
}

async function checkLedgerReservationCrosslinks(): Promise<number> {
  let violations = 0;

  // (a) captured-Reservierungen ohne gültigen Ledger-Verweis.
  const orphanCaptured = await db
    .select({
      id: budgetReservations.id,
      capturedLedgerId: budgetReservations.capturedLedgerId,
    })
    .from(budgetReservations)
    .leftJoin(budgetLedger, eq(budgetLedger.id, budgetReservations.capturedLedgerId))
    .where(and(eq(budgetReservations.state, "captured"), isNull(budgetLedger.id)));

  for (const r of orphanCaptured) {
    violations++;
    console.log(`✗ Reservation #${r.id} ist 'captured', aber capturedLedgerId=${r.capturedLedgerId ?? "NULL"} zeigt auf keine Ledger-Zeile`);
  }

  // (b) Ledger-Stornos, deren reverses_ledger_id ins Leere zeigt.
  const ledgerRows = await db
    .select({ id: budgetLedger.id, reversesLedgerId: budgetLedger.reversesLedgerId })
    .from(budgetLedger);
  const ledgerIds = new Set(ledgerRows.map((r) => r.id));
  for (const r of ledgerRows) {
    if (r.reversesLedgerId !== null && !ledgerIds.has(r.reversesLedgerId)) {
      violations++;
      console.log(`✗ Ledger-Storno #${r.id} verweist auf nicht existierende Ledger-Zeile ${r.reversesLedgerId}`);
    }
  }

  console.log(`\n  Ledger/Reservation-Kreuzcheck-Verletzungen: ${violations}`);
  return violations;
}

async function main() {
  const showAll = process.argv.includes("--all");

  console.log(`\n=== Budget Conservation-Verifier · Read-only (Task #871, I13) ===`);
  console.log(`Modus: ${showAll ? "ALLE Paare" : "nur Verletzungen"}\n`);

  console.log(`--- (1) Kein Topf überzogen (NettoKonsum ≤ Allocated) ---`);
  const potViolations = await checkPotConservation(showAll);

  console.log(`\n--- (2) Reservation ↔ Ledger Kreuzcheck ---`);
  const crossViolations = await checkLedgerReservationCrosslinks();

  const total = potViolations + crossViolations;
  console.log(`\n--- Zusammenfassung ---`);
  if (total === 0) {
    console.log(`✓ Alle Conservation-Invarianten halten.`);
  } else {
    console.log(`⚠ ${total} Verletzung(en) gefunden (${potViolations} Überziehung, ${crossViolations} Kreuzcheck).`);
  }
  return total;
}

main()
  .then((violations) => process.exit(violations === 0 ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
