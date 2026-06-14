/**
 * Task #871 / Task #895 — Read-only Conservation-Verifier (Invariante I13) für die
 * Budget-Domäne.
 *
 * Die eigentliche Check-Logik lebt seit Task #895 als wiederverwendbarer Modul
 * `server/lib/budget-conservation.ts` (SSoT). Dieses Skript ist nur noch die
 * CLI-/Formatierungs-Schicht darüber. Derselbe Check wird vom Guarded-
 * Migrations-Runner als Pre-/Post-Gate genutzt.
 *
 * Dieser Report ÄNDERT NICHTS (nur SELECT) und ist prod-runnable.
 *
 * Aufruf:
 *   tsx server/scripts/verify-budget-conservation.ts             # nur Verletzungen
 *   tsx server/scripts/verify-budget-conservation.ts --all       # alle (Kunde,Topf)-Paare
 *
 * Exit-Code: 0 = alle Invarianten halten, 1 = mindestens eine Verletzung.
 */
import { db } from "../lib/db";
import { checkBudgetConservation } from "../lib/budget-conservation";

const euro = (c: number) => `${(c / 100).toFixed(2)} €`;

async function main(): Promise<number> {
  const showAll = process.argv.includes("--all");

  console.log(`\n=== Budget Conservation-Verifier · Read-only (Task #871, I13) ===`);
  console.log(`Modus: ${showAll ? "ALLE Paare" : "nur Verletzungen"}\n`);

  const result = await checkBudgetConservation(db);

  console.log(`--- (1) Kein Topf überzogen (NettoKonsum ≤ Allocated) ---`);
  for (const r of result.potRows) {
    if (!r.overdrawn && !showAll) continue;
    const flag = r.overdrawn ? "✗" : " ";
    console.log(
      `${flag} #${r.customerId} ${r.budgetType.padEnd(22)} ` +
        `Allocated ${euro(r.allocatedCents)} − Konsum ${euro(r.netConsumedCents)} = ${euro(r.availableCents)}` +
        (r.overdrawn ? `  ⚠ ÜBERZOGEN um ${euro(-r.availableCents)}` : ""),
    );
  }
  console.log(
    `\n  Geprüfte (Kunde,Topf)-Paare: ${result.checkedPairs} · Überzogen: ${result.potViolationKeys.length}`,
  );

  console.log(`\n--- (2) Reservation ↔ Ledger Kreuzcheck ---`);
  for (const d of result.crossDetails) console.log(`✗ ${d}`);
  console.log(`\n  Ledger/Reservation-Kreuzcheck-Verletzungen: ${result.crossViolations}`);
  console.log(`  davon Dual-Link-Divergenzen (Task #1272): ${result.linkDivergences}`);

  console.log(`\n--- Zusammenfassung ---`);
  if (result.total === 0) {
    console.log(`✓ Alle Conservation-Invarianten halten.`);
  } else {
    console.log(
      `⚠ ${result.total} Verletzung(en) gefunden (${result.potViolationKeys.length} Überziehung, ${result.crossViolations} Kreuzcheck).`,
    );
  }
  return result.total;
}

main()
  .then((violations) => process.exit(violations === 0 ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
