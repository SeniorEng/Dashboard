import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { syncCarryoverAndExpiry } from "./allocation-storage";
import { readUnifiedBudgetAvailability } from "./unified-reader";

interface DateAwareAvailability {
  total45b: number;
  total45a: number;
  total39_42a: number;
  totalCents: number;
}

/**
 * Verfügbares Budget (Cents) zum Buchungsdatum.
 *
 * Task #874 (Budget GF Phase 4): Die eigentliche Mathematik lebt jetzt im
 * unified Reader (`unified-reader.ts#readUnifiedBudgetAvailability`) — DER eine
 * Verfügbarkeits-Reader. Diese Funktion ist nur noch ein dünner Wrapper, der
 * vor dem Lesen die zeitabhängige §45b-Carryover-/Expiry-Materialisierung
 * sichert (`syncCarryoverAndExpiry`, schreibend) und dann den reinen (nicht
 * schreibenden) Reader delegiert.
 *
 * Die Cap-Logik (limit + carryover − usedInWindow) lebt in
 * `cap-calculator.computeCapSlot` und ist mit dem Buchungs-Pfad geteilt:
 * - §45b: max(0, aufgelaufene Allocation − Netto-Konsum bis Datum)
 * - §45a: min(pot remaining, monthlyLimit + carryover − usedThisMonth)
 * - §39/§42a: min(pot remaining, yearlyLimit − usedThisYear)
 *
 * Deaktivierte/Out-of-range Töpfe tragen 0 bei.
 */
export async function getAvailableForDate(
  customerId: number,
  transactionDate: string,
  _tx?: DbClient,
): Promise<DateAwareAvailability> {
  // Carryover/Expiry materialisieren (schreibend) — bleibt im Wrapper, damit der
  // unified Reader rein lesend (prod-safe für Shadow-Soak) bleibt.
  await syncCarryoverAndExpiry(customerId, _tx);

  const unified = await readUnifiedBudgetAvailability(customerId, transactionDate, _tx ?? db);
  return {
    total45b: unified.total45b,
    total45a: unified.total45a,
    total39_42a: unified.total39_42a,
    totalCents: unified.totalCents,
  };
}
