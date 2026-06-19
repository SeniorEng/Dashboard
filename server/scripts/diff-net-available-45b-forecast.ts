/**
 * Task #1348 — FORECAST-Re-Diff (READ-ONLY) für die §45b-Verfügbarkeits-
 * Konsolidierung auf `netAvailable45bAt`.
 *
 * Der erste Schattenmodus-Diff (`diff-net-available-45b.ts`) hat Δ Kandidat
 * vs. READER auf 0 abgenommen (einzige Restabweichung: §45b-Monats-Cap #206,
 * von Alrik als Cap-Fall freigegeben). Der KANDIDAT zieht aber Hard-Holds ab,
 * der heutige FORECAST (`getBudgetSummary().availableCents`) NICHT — er zählt
 * stattdessen die geplanten Termin-Kosten selbst. Pointet man den Forecast-Caller
 * unverändert auf den Holds-abziehenden Kandidaten, zählt er Holds UND geplante
 * Kosten doppelt → Unterschätzung → falsche Über-Budget-Warnungen (#1340-Klasse).
 *
 * Deshalb wird `netAvailable45bAt` jetzt KONTEXTABHÄNGIG aufgerufen
 * (`{ holds: "ignore" }` = Forecast-Sicht). Dieses Skript vergleicht GENAU diese
 * FORECAST-VARIANTE gegen das HEUTIGE Forecast-Verhalten und kategorisiert jede
 * verbleibende Cent-Abweichung nach ihrer alleinigen Ursache:
 *
 *     unfloored Variante − Forecast = manual_adjustment + excluded   (#1340)
 *     + Flooring (Variante floored 0, Forecast wird negativ)
 *
 * Erwartung: reine Holds-Fälle fallen auf Δ = 0 (Holds-Fix verifiziert); übrig
 * bleiben nur `excluded`-Korrektur (#1340) / Flooring / manual_adjustment — die
 * gehen fallweise an Alrik, BEVOR der Forecast-Caller umgestellt wird.
 *
 * REIN LESEND (nur `db.select` + reine Read-Funktionen), schreibt NICHTS.
 *
 * Aufruf:
 *   tsx server/scripts/diff-net-available-45b-forecast.ts            # nur Abweichungen
 *   tsx server/scripts/diff-net-available-45b-forecast.ts --all       # alle §45b-Kunden
 *   tsx server/scripts/diff-net-available-45b-forecast.ts 2026-06-30  # anderer Stichtag
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  budgetAllocations,
  budgetTransactions,
  customerBudgetTypeSettings,
} from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import { netAvailable45bAt } from "../storage/budget/net-available-45b";
import { getBudgetSummary } from "../storage/budget/summary-queries";

const BUDGET_TYPE_45B = "entlastungsbetrag_45b" as const;
const euro = (c: number) => `${(c / 100).toFixed(2)} €`;
const signedEuro = (c: number) => `${c >= 0 ? "+" : ""}${euro(c)}`;

async function manualAdjTxnNetCents(customerId: number, asOfDate: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${budgetTransactions.amountCents}), 0)` })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, BUDGET_TYPE_45B),
      eq(budgetTransactions.transactionType, "manual_adjustment"),
      sql`${budgetTransactions.transactionDate} <= ${asOfDate}`,
    ));
  return Number(row?.total ?? 0);
}

async function collect45bCustomerIds(): Promise<number[]> {
  const [fromSettings, fromAllocs, fromTxns] = await Promise.all([
    db.selectDistinct({ id: customerBudgetTypeSettings.customerId })
      .from(customerBudgetTypeSettings)
      .where(eq(customerBudgetTypeSettings.budgetType, BUDGET_TYPE_45B)),
    db.selectDistinct({ id: budgetAllocations.customerId })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.budgetType, BUDGET_TYPE_45B),
        isNull(budgetAllocations.deletedAt),
      )),
    db.selectDistinct({ id: budgetTransactions.customerId })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.budgetType, BUDGET_TYPE_45B)),
  ]);
  const ids = new Set<number>();
  for (const r of [...fromSettings, ...fromAllocs, ...fromTxns]) ids.add(r.id);
  return [...ids].sort((a, b) => a - b);
}

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes("--all");
  const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const asOfDate = dateArg ?? todayISO();

  console.log(`\n=== §45b-Verfügbarkeit · FORECAST-Re-Diff (Task #1348) · READ-ONLY ===`);
  console.log(`Stichtag: ${asOfDate} · Modus: ${showAll ? "ALLE §45b-Kunden" : "nur Abweichungen"}`);
  console.log(
    `Forecast-Variante = netAvailable45bAt({ holds: "ignore" })  vs.  Heutiger Forecast = getBudgetSummary.availableCents\n`,
  );

  console.error(`[progress] sammle §45b-Kunden-IDs …`);
  const t0 = Date.now();
  const customerIds = await collect45bCustomerIds();
  console.error(`[progress] ${customerIds.length} §45b-Kunden in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const CONCURRENCY = 3;
  let doneCount = 0;
  type Row = {
    customerId: number;
    name: string;
    variant: Awaited<ReturnType<typeof netAvailable45bAt>>;
    variantVal: number;
    forecastVal: number;
    manualAdjTxn: number;
  };
  const rows: Row[] = new Array(customerIds.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= customerIds.length) return;
      const customerId = customerIds[i];
      const [cust] = await db
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);
      const [variant, summary, manualAdjTxn] = await Promise.all([
        // Forecast-SICHT: Holds NICHT abziehen, projectFuture = false (der heutige
        // Forecast-Startpunkt `availableCents` rechnet ebenfalls ohne Projektion,
        // nur bis zum Stichtag).
        netAvailable45bAt(customerId, asOfDate, { holds: "ignore", projectFuture: false }),
        getBudgetSummary(customerId, undefined, undefined, asOfDate),
        manualAdjTxnNetCents(customerId, asOfDate),
      ]);
      rows[i] = {
        customerId,
        name: cust?.name ?? "",
        variant,
        variantVal: variant.availableCents,
        forecastVal: summary.availableCents,
        manualAdjTxn,
      };
      doneCount++;
      if (doneCount % 25 === 0) {
        console.error(`[progress] ${doneCount}/${customerIds.length} berechnet (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, customerIds.length) }, () => worker()),
  );

  let diffCount = 0;
  let matchCount = 0;
  let totalAbsDiff = 0;

  let catHoldsResolved = 0; // hatte Holds, Δ jetzt 0 → Holds-Fix verifiziert
  let catExcluded = 0;      // Δ erklärt sich (auch) über die #1340-excluded-Korrektur
  let catFlooring = 0;      // Δ erklärt sich (auch) über Flooring (Forecast negativ)
  let catManualTxn = 0;     // Δ erklärt sich (auch) über manual_adjustment-Txn
  let catUnexplained = 0;   // Δ != 0 ohne bekannte Ursache → muss 0 sein

  for (const row of rows) {
    const { customerId, name, variant, variantVal, forecastVal, manualAdjTxn } = row;
    const dForecast = variantVal - forecastVal;
    // Unflooored Variante (vor max(0,…)) — Treiber-Zerlegung der Abweichung:
    //   unfloored − Forecast = manual_adjustment + excluded   (wenn raw ≥ excluded)
    const unfloored = variant.allocatedCents - variant.consumedNetCents;
    const flooringEffect = variantVal - unfloored; // > 0 ⇔ Variante wurde auf 0 gehoben

    const hasDiff = dForecast !== 0;
    if (hasDiff) { diffCount++; totalAbsDiff += Math.abs(dForecast); }
    else { matchCount++; if (variant.holdsCents !== 0) catHoldsResolved++; }

    let explained = false;
    if (hasDiff) {
      if (variant.excludedConsumedNetCents !== 0) { catExcluded++; explained = true; }
      if (flooringEffect > 0) { catFlooring++; explained = true; }
      if (manualAdjTxn !== 0) { catManualTxn++; explained = true; }
      if (!explained) catUnexplained++;
    }

    if (!hasDiff && !showAll) continue;

    const reasons: string[] = [];
    if (variant.excludedConsumedNetCents !== 0) reasons.push(`excluded ${euro(variant.excludedConsumedNetCents)} (#1340)`);
    if (flooringEffect > 0) reasons.push(`Flooring (unfloored ${euro(unfloored)})`);
    if (manualAdjTxn !== 0) reasons.push(`manual_adjustment-Txn ${signedEuro(manualAdjTxn)}`);
    if (hasDiff && reasons.length === 0) reasons.push(`⚠ UNERKLÄRT (sollte 0 sein)`);
    // Kontext: Holds wurden in dieser Variante bewusst NICHT abgezogen.
    const holdsNote = variant.holdsCents !== 0 ? ` · Holds ignoriert ${euro(variant.holdsCents)}` : "";

    const flag = hasDiff ? "Δ" : " ";
    console.log(
      `${flag} #${String(customerId).padStart(4)} ${name.slice(0, 24).padEnd(24)} ` +
      `Variante ${euro(variantVal).padStart(11)} · ` +
      `Forecast ${euro(forecastVal).padStart(11)} (Δ ${signedEuro(dForecast).padStart(11)})` +
      (hasDiff ? `\n        ↳ ${reasons.join(" · ")}${holdsNote}` : holdsNote ? `\n        ↳${holdsNote}` : ""),
    );
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte §45b-Kunden:                       ${customerIds.length}`);
  console.log(`Variante == Forecast (Δ = 0):               ${matchCount}`);
  console.log(`  davon vormals Holds-Fälle (Fix verifiziert): ${catHoldsResolved}`);
  console.log(`Abweichung Variante vs. Forecast:           ${diffCount}  (Σ|Δ| ${euro(totalAbsDiff)})`);
  console.log(`\n--- Ursachen der Restabweichung (fallweise Abnahme Alrik) ---`);
  console.log(`  excluded-Korrektur #1340 (Kandidat korrekter): ${catExcluded}`);
  console.log(`  Flooring (Forecast wird negativ):              ${catFlooring}`);
  console.log(`  manual_adjustment-Txn:                         ${catManualTxn}`);
  console.log(`  UNERKLÄRT (muss 0 sein):                       ${catUnexplained}`);
  if (diffCount === 0) {
    console.log(`\n✓ Forecast-Variante deckungsgleich mit dem heutigen Forecast.`);
  } else {
    console.log(`\n⚠ Restabweichungen liegen zur fallweisen Abnahme bei Alrik. KEINE Forecast-Caller-Umstellung vor Freigabe.`);
  }
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
