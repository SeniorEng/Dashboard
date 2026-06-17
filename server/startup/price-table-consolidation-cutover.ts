import { sql } from "drizzle-orm";
import type { Tx } from "../lib/db";
import { log } from "../lib/log";
import { populatePricesInto } from "../scripts/populate-prices";
import { runGate2Diff } from "../scripts/shadow-diff-price-for-consolidated";
import type { BudgetMigrationSummary } from "./budget-migration-runner";

/**
 * Task #1324 (B) — Gated Startup-Cutover der Preis-Konsolidierung.
 *
 * Führt die drei Alt-Preis-Tabellen in EINER Transaktion in die konsolidierte
 * `prices`-Tabelle über und entfernt die Altlasten:
 *   1. `customer_service_prices` — Kunden-Override pro Service (HEUTE live).
 *   2. `customer_contract_rates` — Kunden-Override pro Vertrags-Kategorie.
 *   3. `service_rates`           — firmenweiter Standard pro Kategorie.
 *
 * Ablauf (alles in EINER Transaktion, damit Befüllung + Parität + Drop atomar
 * zusammen committen oder zusammen zurückrollen):
 *   1. `populatePricesInto(tx)` — additive, idempotente Befüllung von `prices`
 *      (scope="standard" aus service_rates; scope="customer" aus csp+ccr).
 *   2. Gate-2-Paritäts-Wächter (`runGate2Diff(tx)`): vergleicht die konsolidierte
 *      Auflösung gegen das heutige Live-Verhalten über reale Termin-Tupel + alle
 *      ccr-/service_rates-Zeilen. JEDE Abweichung ≠ 0 Cent ⇒ Throw ⇒ Rollback,
 *      KEIN Drop (die dormante Quelle muss erst von Alrik je Zeile entschieden
 *      werden).
 *   3. Standard-/Kunden-Scope-Lesen aktivieren: `PRICES_STANDARD_SCOPE=1` für den
 *      laufenden Prozess setzen (Muster wie `BUDGET_HARD_HOLDS`). Der Operator
 *      MUSS das Env-Flag persistent setzen, sonst lesen frische Prozesse nach dem
 *      Drop ins Leere — dies wird ausdrücklich geloggt.
 *   4. DROP der drei Alt-Tabellen (idempotent, `IF EXISTS`).
 *
 * Lauf-Garantien (über `runGuardedBudgetMigration`): EINE Transaktion, Exactly-
 * once via Migrations-Ledger. Kein GoBD-Bypass und kein Budget-Conservation-Check
 * nötig (betrifft NUR die Preis-Tabellen, nicht die GoBD-geschützten Budget-/
 * Rechnungstabellen) ⇒ `gobdBypass:false`, `conservationCheck:false`.
 *
 * Idempotenz: Nach erfolgreichem Lauf sind die Tabellen weg (DROP IF EXISTS =
 * No-Op) und der Ledger-Eintrag verhindert einen Re-Lauf. Schlägt Gate-2 fehl,
 * rollt die Transaktion zurück (inkl. Ledger) — der Cutover kann nach Klärung
 * erneut versucht werden.
 *
 * Freigabe: registriert NUR bei gesetztem Flag
 * `APPROVED_PRICE_TABLE_CONSOLIDATION` (=1/true). Default = nicht registriert.
 */

// Single-Source-of-Truth für das rohe Drop-DDL (analog `drop-budget-ledger.ts`),
// damit Drift-/Schema-Wächter die gedroppten Tabellen introspizieren können, ohne
// das DDL zu duplizieren. Die drei Tabellen sind Blatt-Tabellen (sie referenzieren
// andere per FK, werden selbst aber nicht referenziert) ⇒ plain DROP genügt.
export const DROP_CUSTOMER_SERVICE_PRICES_SQL = `
  DROP TABLE IF EXISTS customer_service_prices
`;
export const DROP_CUSTOMER_CONTRACT_RATES_SQL = `
  DROP TABLE IF EXISTS customer_contract_rates
`;
export const DROP_SERVICE_RATES_SQL = `
  DROP TABLE IF EXISTS service_rates
`;

/** DROP-Registry für Drift-Wächter: diese Tabellen MÜSSEN nach Cutover weg sein. */
export const DROPPED_PRICE_CONSOLIDATION_TABLES = [
  "customer_service_prices",
  "customer_contract_rates",
  "service_rates",
] as const;

/** Coverage-Fenster für den Gate-2-Termin-Abgleich (Monate). */
const GATE2_MONTHS = 12;

function toDateStr(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export async function priceTableConsolidationCutover(
  tx: Tx,
): Promise<BudgetMigrationSummary> {
  const asOf = toDateStr(new Date());

  // 1. Additive, idempotente Befüllung von `prices` (innerhalb der Transaktion).
  const populated = await populatePricesInto(tx, asOf);
  if (populated.plan.unmapped.length > 0) {
    // Nicht-abbildbare Quellzeilen (kein Katalog-Service) sind ein Stopp-Signal:
    // sie würden beim Drop verloren gehen. Throw ⇒ Rollback, KEIN Drop.
    throw new Error(
      `Preis-Konsolidierung abgebrochen: ${populated.plan.unmapped.length} Quellzeile(n) ohne ` +
        "Katalog-Service (serviceId == null) — Verlust-Risiko, vor dem Drop zu klären.",
    );
  }

  // 2. Gate-2-Paritäts-Wächter: 0-Cent-Gate. Jede Abweichung blockiert den Drop.
  const gate2 = await runGate2Diff(GATE2_MONTHS, asOf, tx);
  if (gate2.deviations.length > 0) {
    const sample = gate2.deviations
      .slice(0, 5)
      .map(
        (d) =>
          `Kunde ${d.customerId ?? "—"}/Service ${d.serviceId}@${d.date}: ` +
          `baseline=${d.baselineCents ?? "—"}c vs konsolidiert=${d.consolidatedCents ?? "—"}c ` +
          `(${d.activatedSource})`,
      )
      .join("; ");
    throw new Error(
      `Preis-Konsolidierung abgebrochen (Gate-2 ROT): ${gate2.deviations.length} Abweichung(en) ≠ 0 Cent — ` +
        `jede ist eine aktivierte dormante Quelle und MUSS vor dem Drop je Zeile entschieden werden. Beispiele: ${sample}`,
    );
  }

  // 3. Standard-/Kunden-Scope-Lesen aktivieren (für den laufenden Prozess).
  //    Muster wie BUDGET_HARD_HOLDS: das Env-Flag muss vom Operator PERSISTENT
  //    gesetzt werden, sonst lesen frische Prozesse nach dem Drop ins Leere.
  process.env.PRICES_STANDARD_SCOPE = "1";
  log(
    "[budget-migration] price-table-consolidation: PRICES_STANDARD_SCOPE für diesen Prozess " +
      "auf '1' gesetzt. WICHTIG: Operator MUSS PRICES_STANDARD_SCOPE=1 persistent setzen " +
      "(Secret/Deployment-Env), sonst lesen neue Prozesse nach dem Drop keine Preise.",
    "startup",
  );

  // 4. DROP der drei Alt-Tabellen (idempotent).
  await tx.execute(sql.raw(DROP_CUSTOMER_SERVICE_PRICES_SQL));
  await tx.execute(sql.raw(DROP_CUSTOMER_CONTRACT_RATES_SQL));
  await tx.execute(sql.raw(DROP_SERVICE_RATES_SQL));

  const note =
    `prices befüllt: +${populated.inserted} Zeile(n) (Quellzeilen=${populated.plan.sourceRowCount}); ` +
    `Gate-2 grün (coverage=${gate2.coveragePoints}, shadowedContractRates=${gate2.shadowedContractRates.length}); ` +
    `PRICES_STANDARD_SCOPE aktiviert; gedroppt: ${DROPPED_PRICE_CONSOLIDATION_TABLES.join(", ")}`;
  log(`[budget-migration] price-table-consolidation: ${note}`, "startup");

  return { changed: populated.inserted + DROPPED_PRICE_CONSOLIDATION_TABLES.length, note };
}
