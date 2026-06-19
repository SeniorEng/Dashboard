/**
 * Task #1348 — Schattenmodus-Diff (READ-ONLY) für die §45b-Verfügbarkeits-
 * Konsolidierung auf `netAvailable45bAt`.
 *
 * Vergleicht je §45b-relevantem Kunden zum Stichtag (Default: heute) die
 * KANDIDATEN-Funktion `netAvailable45bAt` gegen:
 *   (a) das HEUTIGE Forecast-Verhalten  — `getBudgetSummary().availableCents`
 *       (Forecast-Startpunkt; `manual_adjustment`-TRANSAKTIONEN stecken im
 *        Verbrauch, Holds werden NICHT gezählt, keine `excluded`-Korrektur am
 *        Startpunkt),
 *   (b) den HEUTIGEN `unified-reader`     — `readUnifiedBudgetAvailability()
 *       .pots.entlastungsbetrag_45b.availableCents` (`manual_adjustment` als
 *        Allocation-Posten, Holds aktiv, optionaler Monats-Cap).
 *
 * Es werden ALLE Cent-Abweichungen aufgelistet — pro Kunde, mit den
 * Eingangsgrößen der Identität und den Flags des verantwortlichen Sonderfalls
 * (`manual_adjustment`-Transaktion / `manual_adjustment`-Allocation / aktive
 * Holds / gesetzter §45b-Monats-Cap). Das Skript ist REIN LESEND (nur
 * `db.select` + reine Read-Funktionen) und schreibt NICHTS.
 *
 * Aufruf:
 *   tsx server/scripts/diff-net-available-45b.ts            # nur Kunden mit Abweichung
 *   tsx server/scripts/diff-net-available-45b.ts --all       # alle §45b-Kunden
 *   tsx server/scripts/diff-net-available-45b.ts 2026-06-30  # anderer Stichtag
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
import { readUnifiedBudgetAvailability } from "../storage/budget/unified-reader";
import { getBudgetSummary } from "../storage/budget/summary-queries";

const BUDGET_TYPE_45B = "entlastungsbetrag_45b" as const;
const euro = (c: number) => `${(c / 100).toFixed(2)} €`;
const signedEuro = (c: number) => `${c >= 0 ? "+" : ""}${euro(c)}`;

interface CustomerFlags {
  /** Netto-Summe der `manual_adjustment`-TRANSAKTIONEN (Forecast zählt sie als Verbrauch). */
  manualAdjTxnNetCents: number;
  /** Summe der aktiven `manual_adjustment`-ALLOCATIONEN (im `allocated` enthalten). */
  manualAdjAllocCents: number;
  /** Gesetzter §45b-Monats-Cap (greift nur im Reader, nicht im Kandidaten). */
  monthlyCapCents: number | null;
}

async function loadFlags(customerId: number, asOfDate: string): Promise<CustomerFlags> {
  const [manualTxn, manualAlloc, capRow] = await Promise.all([
    db
      .select({ total: sql<number>`COALESCE(SUM(${budgetTransactions.amountCents}), 0)` })
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, BUDGET_TYPE_45B),
        eq(budgetTransactions.transactionType, "manual_adjustment"),
        sql`${budgetTransactions.transactionDate} <= ${asOfDate}`,
      )),
    db
      .select({ total: sql<number>`COALESCE(SUM(${budgetAllocations.amountCents}), 0)` })
      .from(budgetAllocations)
      .where(and(
        eq(budgetAllocations.customerId, customerId),
        eq(budgetAllocations.budgetType, BUDGET_TYPE_45B),
        eq(budgetAllocations.source, "manual_adjustment"),
        isNull(budgetAllocations.deletedAt),
      )),
    db
      .select({ monthlyLimitCents: customerBudgetTypeSettings.monthlyLimitCents })
      .from(customerBudgetTypeSettings)
      .where(and(
        eq(customerBudgetTypeSettings.customerId, customerId),
        eq(customerBudgetTypeSettings.budgetType, BUDGET_TYPE_45B),
        eq(customerBudgetTypeSettings.enabled, true),
      ))
      .limit(1),
  ]);

  return {
    manualAdjTxnNetCents: Number(manualTxn[0]?.total ?? 0),
    manualAdjAllocCents: Number(manualAlloc[0]?.total ?? 0),
    monthlyCapCents: capRow[0]?.monthlyLimitCents ?? null,
  };
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

  console.log(`\n=== §45b-Verfügbarkeit · Schattenmodus-Diff (Task #1348) · READ-ONLY ===`);
  console.log(`Stichtag: ${asOfDate} · Modus: ${showAll ? "ALLE §45b-Kunden" : "nur Abweichungen"}`);
  console.log(
    `Kandidat = netAvailable45bAt  ·  (a) Forecast = getBudgetSummary.availableCents  ·  (b) Reader = unified-reader.availableCents\n`,
  );

  console.error(`[progress] sammle §45b-Kunden-IDs …`);
  const t0 = Date.now();
  const customerIds = await collect45bCustomerIds();
  console.error(`[progress] ${customerIds.length} §45b-Kunden in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Pro-Kunde lesend berechnen, mit begrenzter Nebenläufigkeit (sonst dominiert
  // bei einer entfernten Replica die Round-Trip-Latenz × ~tausende Queries).
  // REIN LESEND — ändert nichts am Vergleich, nur die Laufzeit.
  const CONCURRENCY = 3;
  let doneCount = 0;
  type Row = {
    customerId: number;
    name: string;
    candidate: Awaited<ReturnType<typeof netAvailable45bAt>>;
    pot: Awaited<ReturnType<typeof readUnifiedBudgetAvailability>>["pots"]["entlastungsbetrag_45b"];
    candidateVal: number;
    readerVal: number;
    forecastVal: number;
    flags: CustomerFlags;
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
      const [candidate, unified, summary, flags] = await Promise.all([
        netAvailable45bAt(customerId, asOfDate),
        readUnifiedBudgetAvailability(customerId, asOfDate),
        getBudgetSummary(customerId, undefined, undefined, asOfDate),
        loadFlags(customerId, asOfDate),
      ]);
      rows[i] = {
        customerId,
        name: cust?.name ?? "",
        candidate,
        pot: unified.pots.entlastungsbetrag_45b,
        candidateVal: candidate.availableCents,
        readerVal: unified.pots.entlastungsbetrag_45b.availableCents,
        forecastVal: summary.availableCents,
        flags,
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

  let diffVsForecast = 0;
  let diffVsReader = 0;
  let bothMatch = 0;
  let totalAbsDiffForecast = 0;
  let totalAbsDiffReader = 0;

  // Pro-Fall-Kategorien (für die fallweise Abnahme, Schritt 3). Eine Zeile kann
  // mehrere Kategorien treffen (z.B. manual_adjustment UND Holds).
  // Kontext-Treiber der Forecast-Abweichung (Kandidat zieht sie ab, Forecast nicht):
  let catManualTxn = 0; // Forecast zählt manual_adjustment als Verbrauch
  let catManualAlloc = 0; // manual_adjustment-Allocation (steckt im allocated)
  let catHolds = 0; // aktive Hard-Holds
  let catExcluded = 0; // §45b-Exklusions-Korrektur (Task #1306/#1340) — IN SCOPE
  // Entscheidungs-Signal ist Δ gegen den Reader (= das SSoT-Ziel):
  let catReaderMatch = 0; // dReader == 0 → Kandidat == Reader → unkritisch
  let catCapOnly = 0; // dReader != 0, allein §45b-Monats-Cap (NICHT in Scope, Cap bleibt)
  let catReaderDiverge = 0; // dReader != 0 OHNE Cap → Kandidat ≠ Reader → PRÜFEN (Alrik)

  for (const row of rows) {
    const { customerId, name, candidate, pot, candidateVal, readerVal, forecastVal, flags } = row;

    const dForecast = candidateVal - forecastVal;
    const dReader = candidateVal - readerVal;

    const hasDiff = dForecast !== 0 || dReader !== 0;
    if (dForecast !== 0) { diffVsForecast++; totalAbsDiffForecast += Math.abs(dForecast); }
    if (dReader !== 0) { diffVsReader++; totalAbsDiffReader += Math.abs(dReader); }
    if (!hasDiff) bothMatch++;

    let capOnly = false;
    let readerDiverge = false;
    if (hasDiff) {
      if (flags.manualAdjTxnNetCents !== 0) catManualTxn++;
      if (flags.manualAdjAllocCents !== 0) catManualAlloc++;
      if (candidate.holdsCents !== 0) catHolds++;
      if (candidate.excludedConsumedNetCents !== 0) catExcluded++;

      // „Cap-only" = die Reader-Abweichung erklärt sich allein über den §45b-
      // Monats-Cap (Reader = min(Topf-Rest, Cap-Rest), Kandidat = Topf-Rest VOR Cap).
      // Laut Aufgabe NICHT in Scope — der Cap bleibt beim Switch erhalten.
      // Authoritatives Cap-Signal ist der Reader selbst (`capRemainingCents` ist
      // `Infinity`, wenn kein Monatslimit gesetzt ist; sonst der Cap-Rest). Die
      // rohe type-settings-Abfrage in `loadFlags` taugt dafür NICHT, weil sie ohne
      // Datums-/`deletedAt`-Filter bei append-only-Phasen die falsche/abgelaufene
      // §45b-Zeile treffen und `monthlyLimitCents = null` zurückgeben kann (Prod #206).
      capOnly =
        dReader !== 0 && pot.enabled && pot.inRange &&
        pot.capRemainingCents !== Infinity &&
        readerVal === Math.min(candidateVal, pot.capRemainingCents);

      if (dReader === 0) catReaderMatch++;
      else if (capOnly) catCapOnly++;
      else { catReaderDiverge++; readerDiverge = true; }
    }

    if (!hasDiff && !showAll) continue;

    const reasons: string[] = [];
    if (flags.manualAdjTxnNetCents !== 0) reasons.push(`manual_adjustment-Txn ${signedEuro(flags.manualAdjTxnNetCents)}`);
    if (flags.manualAdjAllocCents !== 0) reasons.push(`manual_adjustment-Alloc ${signedEuro(flags.manualAdjAllocCents)}`);
    if (candidate.holdsCents !== 0) reasons.push(`aktive Holds ${euro(candidate.holdsCents)}`);
    if (candidate.excludedConsumedNetCents !== 0) reasons.push(`excluded ${euro(candidate.excludedConsumedNetCents)}`);

    // Entscheidungs-Signal: Bei Reader-Divergenz OHNE Cap (Kandidat ≠ SSoT-Ziel)
    // Kandidat- UND Reader-Innereien ausweisen, damit Alrik die Ursache fallweise
    // abnehmen kann; sonst nur die Forecast-Treiber bzw. „unkritisch".
    let detail = "";
    if (readerDiverge) {
      detail =
        `\n        ↳ ⚠ Kandidat ≠ Reader (kein Cap) — PRÜFEN` +
        `\n          Kandidat: alloc ${euro(candidate.allocatedCents)} − holds ${euro(candidate.holdsCents)} ` +
        `− consumedNet ${euro(candidate.consumedNetCents)} (roh ${euro(candidate.rawConsumedNetCents)} − excl ${euro(candidate.excludedConsumedNetCents)})` +
        `\n          Reader:   enabled=${pot.enabled} inRange=${pot.inRange} alloc ${euro(pot.allocatedCents)} ` +
        `− holds ${euro(pot.holdsActiveCents)} − consumedNet ${euro(pot.consumedNetCents)} ⇒ ${euro(pot.availableCents)}`;
    } else if (capOnly) {
      detail =
        `\n        ↳ nur §45b-Monats-Cap (NICHT in Scope — bleibt als Math.min im Reader): ` +
        `Topf-Rest ${euro(candidateVal)} → Cap-Rest ${euro(pot.capRemainingCents)} = Reader ${euro(readerVal)}`;
    } else if (reasons.length) {
      detail = `\n        ↳ ${reasons.join(" · ")}`;
    } else if (hasDiff) {
      detail = `\n        ↳ Δ nur ggü. Forecast (Kandidat == Reader) — Flooring/Projektion, unkritisch`;
    }

    const flag = hasDiff ? "Δ" : " ";
    console.log(
      `${flag} #${String(customerId).padStart(4)} ${name.slice(0, 24).padEnd(24)} ` +
      `Kandidat ${euro(candidateVal).padStart(11)} · ` +
      `Forecast ${euro(forecastVal).padStart(11)} (Δ ${signedEuro(dForecast).padStart(11)}) · ` +
      `Reader ${euro(readerVal).padStart(11)} (Δ ${signedEuro(dReader).padStart(11)})` +
      detail,
    );
  }

  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte §45b-Kunden:                 ${customerIds.length}`);
  console.log(`Kandidat == Forecast UND == Reader:   ${bothMatch}`);
  console.log(`Abweichung Kandidat vs. Forecast (a): ${diffVsForecast}  (Σ|Δ| ${euro(totalAbsDiffForecast)})`);
  console.log(`Abweichung Kandidat vs. Reader   (b): ${diffVsReader}  (Σ|Δ| ${euro(totalAbsDiffReader)})`);
  console.log(`\n--- Entscheidungs-Kategorien (Schritt-3-Abnahme) ---`);
  console.log(`  Kandidat == Reader (SSoT-Ziel, unkritisch): ${catReaderMatch}`);
  console.log(`  nur §45b-Monats-Cap (NICHT in Scope):       ${catCapOnly}`);
  console.log(`  Kandidat ≠ Reader OHNE Cap (PRÜFEN):         ${catReaderDiverge}`);
  console.log(`  Forecast-Treiber (Kontext, Kandidat zieht ab): Holds ${catHolds} · excluded ${catExcluded} · manual_adj-Txn ${catManualTxn} · -Alloc ${catManualAlloc}`);
  if (diffVsForecast === 0 && diffVsReader === 0) {
    console.log(`\n✓ Keine Cent-Abweichung — Kandidat ist deckungsgleich mit beiden Pfaden.`);
  } else {
    console.log(`\n⚠ Abweichungen liegen zur fallweisen Abnahme bei Alrik (Schritt 3). KEINE Umstellung vor Freigabe.`);
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
