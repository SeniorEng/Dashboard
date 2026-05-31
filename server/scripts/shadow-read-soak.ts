/**
 * Task #874 — Budget GF Phase 4: Shadow-Read-Soak (Invariante I18).
 *
 * Dieser Report ÄNDERT NICHTS (rein lesend, prod-runnable) und vergleicht den
 * unified Reader (`readUnifiedBudgetAvailability`) mit den Legacy-Summary-Readern
 * pro (Kunde, Topf). Er ist das Lösch-Gate für Phase 6: die Legacy-
 * `customer_budgets`-Fallbacks dürfen erst entfernt werden, wenn diese Drift
 * über ein Soak-Fenster auf live Daten 0 ist.
 *
 * BEKANNTE DRIFT (siehe `shadow-read.ts`): §45b-Legacy subtrahiert ALL-TIME inkl.
 * `manual_adjustment`, der unified Reader asOf-Datum OHNE `manual_adjustment`.
 * Kunden ohne `manual_adjustment` ⇒ Drift 0.
 *
 * Aufruf:
 *   tsx server/scripts/shadow-read-soak.ts             # nur Kunden mit Drift
 *   tsx server/scripts/shadow-read-soak.ts --all       # alle Kunden
 *
 * Exit-Code: 0 = keine Drift, 1 = mindestens ein Kunde mit Drift.
 */
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { customerBudgetTypeSettings, budgetAllocations } from "@shared/schema";
import { compareUnifiedVsLegacy, type ShadowReadResult } from "../storage/budget/shadow-read";

const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

async function distinctCustomerIds(): Promise<number[]> {
  // Kunden mit Budget-Konfiguration ODER Allocations — die einzigen, für die ein
  // Verfügbarkeits-Read überhaupt etwas liefert.
  const result = await db.execute<{ customer_id: number }>(sql`
    SELECT DISTINCT customer_id FROM ${customerBudgetTypeSettings}
    UNION
    SELECT DISTINCT customer_id FROM ${budgetAllocations}
    ORDER BY customer_id
  `);
  const list = (result as unknown as { rows: Array<{ customer_id: number }> }).rows;
  return list.map((r) => Number(r.customer_id)).filter((n) => Number.isFinite(n));
}

function printResult(r: ShadowReadResult): void {
  const flag = r.hasDrift ? "✗" : " ";
  const detail = r.pots
    .map((p) => `${p.budgetType.padEnd(22)} unified ${euro(p.unifiedAvailableCents)} / legacy ${euro(p.legacyAvailableCents)}${p.deltaCents !== 0 ? `  Δ ${euro(p.deltaCents)}` : ""}`)
    .join("\n      ");
  console.log(`${flag} #${r.customerId} (maxΔ ${euro(r.maxAbsDeltaCents)})\n      ${detail}`);
}

async function main(): Promise<number> {
  const showAll = process.argv.includes("--all");

  console.log(`\n=== Budget Shadow-Read-Soak · Read-only (Task #874, I18) ===`);
  console.log(`Modus: ${showAll ? "ALLE Kunden" : "nur Kunden mit Drift"}\n`);

  const customerIds = await distinctCustomerIds();
  let drifted = 0;
  let checked = 0;
  let maxDelta = 0;

  for (const customerId of customerIds) {
    let result: ShadowReadResult;
    try {
      result = await compareUnifiedVsLegacy(customerId);
    } catch (err) {
      console.error(`! #${customerId} Vergleich fehlgeschlagen:`, err);
      drifted++;
      continue;
    }
    checked++;
    maxDelta = Math.max(maxDelta, result.maxAbsDeltaCents);
    if (result.hasDrift) drifted++;
    if (result.hasDrift || showAll) printResult(result);
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte Kunden: ${checked} · Mit Drift: ${drifted} · max |Δ|: ${euro(maxDelta)}`);
  if (drifted === 0) {
    console.log(`✓ Keine Shadow-Read-Drift — Soak-Fenster sauber.`);
  } else {
    console.log(`⚠ ${drifted} Kunde(n) mit Drift (siehe oben; §45b manual_adjustment-Drift erwartet bis Phase 6).`);
  }
  return drifted;
}

main()
  .then((drifted) => process.exit(drifted === 0 ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
