/**
 * Task #895 — Wiederverwendbarer Conservation-Verifier (Invariante I13) für die
 * Budget-Domäne.
 *
 * Dieser Modul kapselt die read-only Erhaltungs-Checks, die im Drei-Tabellen-
 * Modell IMMER gelten müssen. Er wird an zwei Stellen genutzt:
 *
 *  1. `server/scripts/verify-budget-conservation.ts` — CLI-Report (prod-runnable).
 *  2. `server/startup/budget-migration-runner.ts` — Pre-/Post-Check als Guard
 *     um jede budgetdaten-mutierende Migration (Rollback bei NEU eingeführter
 *     Verletzung).
 *
 * Die Checks ÄNDERN NICHTS (nur SELECT). Sie akzeptieren einen `DbOrTx`, sodass
 * der Post-Check innerhalb derselben (noch nicht committeten) Migrations-
 * Transaktion gegen den mutierten — aber noch nicht persistierten — Zustand
 * laufen kann.
 *
 * WICHTIG: I13 wird als NICHT-Überziehung geprüft, NICHT als strikte Gleichheit
 * `Allocated − Consumed == Available`. Wo statutarische Caps (§45a/§39+§42a)
 * binden, ist die nutzbare Verfügbarkeit kleiner als Allocated − Consumed; eine
 * strikte Gleichheit würde dort fälschlich anschlagen. Die Erhaltung, die immer
 * hält, ist „kein Topf wird über seine Allocation hinaus konsumiert".
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "./db";
import {
  budgetTransactions,
  budgetAllocations,
  budgetReservations,
  customerBudgetTypeSettings,
  customerCareLevelHistory,
  customers,
} from "@shared/schema";
import { todayISO } from "@shared/utils/datetime";
import {
  readUnifiedBudgetAvailability,
  type CappedBudgetPot,
} from "../storage/budget/unified-reader";
import type { DbClient } from "../storage/budget/types";

/** Der Selbstzahler-Overflow-Topf hat per Design KEINE Allocation — er
 *  absorbiert den Cascade-Rest (uncapped). Für die No-Overdraw-Invariante ist
 *  er irrelevant. */
export const UNCAPPED_POTS = new Set(["private", "selbstzahler"]);

/** Die statutarischen Töpfe, die der eine Verfügbarkeits-Reader modelliert. */
const CAPPED_POTS: readonly CappedBudgetPot[] = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
];

export interface PotConservationRow {
  customerId: number;
  budgetType: string;
  allocatedCents: number;
  netConsumedCents: number;
  availableCents: number;
  overdrawn: boolean;
}

export interface ConservationResult {
  /** Geprüfte (Kunde,Topf)-Paare (uncapped ausgenommen). */
  checkedPairs: number;
  /** Detailzeilen aller geprüften Paare (auch nicht-verletzte). */
  potRows: PotConservationRow[];
  /** `${customerId}|${budgetType}` aller überzogenen Töpfe. */
  potViolationKeys: string[];
  /** Ledger/Reservation-Kreuzcheck-Verletzungen (Phase 2+). */
  crossViolations: number;
  /** Menschenlesbare Detailmeldungen der Kreuzcheck-Verletzungen. */
  crossDetails: string[];
  /**
   * Task #1273 (Stufe B) — Link-Divergenzen: captured Reservierungen, deren
   * `captured_transaction_id` zwar gesetzt ist, aber auf keine existierende
   * `budget_transactions`-Zeile zeigt ODER auf eine Zeile mit abweichendem
   * Kunden/Topf. Der frühere `budget_ledger`-Spiegel ist seit Stufe C
   * (Task #1274) entfernt; der Dual-Link ist auf den einen
   * `captured_transaction_id`-Link reduziert.
   * Teilmenge von `crossViolations` (die Detailzeilen stecken in `crossDetails`).
   * Reservierungen mit leerem `captured_transaction_id` (Bestand vor Stage-A-
   * Backfill) sind KEINE Divergenz. Divergenz > 0 ⇒ STOPPEN + Report.
   */
  linkDivergences: number;
  /** Summe potViolationKeys.length + crossViolations. */
  total: number;
}

/**
 * Task #1298 — Projektions-bewusste Enumeration der zu prüfenden
 * (Kunde, Topf)-Population.
 *
 * Seit die monatliche/jährliche Aufstockung NICHT mehr in `budget_allocations`
 * materialisiert, sondern rein rechnerisch projiziert wird (Task #1289/#1295),
 * darf die Conservation-Population NICHT mehr aus den roh-materialisierten
 * Allocation-Zeilen abgeleitet werden — sonst fiele ein rein projizierter
 * §45b/§39-Topf (Anspruch ohne materialisierte Zeile) nach dem Aufräumen der
 * Altlast-Zeilen aus der Prüfung heraus und der Guard ginge „blind" (falsches
 * „0 überzogen").
 *
 * Die Population ist deshalb die Vereinigung aus
 *   - CONSUMPTION:   jede (Kunde, Topf)-Kombination mit `budget_transactions`,
 *   - ANSPRUCH:      §45b default-an für Nicht-Selbstzahler mit Pflegegrad-
 *                    Historie (Projektions-Anker, identisch zur Reader-SSoT);
 *                    §45a/§39 nur bei aktivierten Type-Settings,
 *   - sowie defensiv jede noch materialisierte Allocation-Zeile (manuelle Fakten
 *     bleiben; deckt zusätzlich Altlast vor dem #1295-Cleanup ab).
 *
 * Uncapped Töpfe (Selbstzahler-Overflow) werden ausgeschlossen.
 */
export async function enumerateConservationPopulation(
  exec: DbOrTx,
): Promise<Map<number, Set<string>>> {
  const population = new Map<number, Set<string>>();
  const add = (customerId: number, budgetType: string) => {
    if (UNCAPPED_POTS.has(budgetType)) return;
    const set = population.get(customerId) ?? new Set<string>();
    set.add(budgetType);
    population.set(customerId, set);
  };

  // (a) Consumption — alle tatsächlich gebuchten Töpfe.
  const consumptionPots = await exec
    .select({
      customerId: budgetTransactions.customerId,
      budgetType: budgetTransactions.budgetType,
    })
    .from(budgetTransactions)
    .groupBy(budgetTransactions.customerId, budgetTransactions.budgetType);
  for (const r of consumptionPots) add(r.customerId, r.budgetType);

  // (b) Noch materialisierte Allocation-Fakten (manual/initial_balance/carryover
  //     sowie verbliebene Altlast vor dem #1295-Cleanup).
  const allocationPots = await exec
    .select({
      customerId: budgetAllocations.customerId,
      budgetType: budgetAllocations.budgetType,
    })
    .from(budgetAllocations)
    .where(isNull(budgetAllocations.deletedAt))
    .groupBy(budgetAllocations.customerId, budgetAllocations.budgetType);
  for (const r of allocationPots) add(r.customerId, r.budgetType);

  // (c) Aktivierte Type-Settings (Anspruch für §45a/§39, die default-aus sind).
  const enabledSettings = await exec
    .select({
      customerId: customerBudgetTypeSettings.customerId,
      budgetType: customerBudgetTypeSettings.budgetType,
    })
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.enabled, true))
    .groupBy(
      customerBudgetTypeSettings.customerId,
      customerBudgetTypeSettings.budgetType,
    );
  for (const r of enabledSettings) add(r.customerId, r.budgetType);

  // (d) §45b-Anspruch aus der Pflegegrad-Historie (Projektions-Anker) für jeden
  //     Nicht-Selbstzahler — identisch zum Default-Gate der Reader-SSoT.
  const careLevelCustomers = await exec
    .select({
      customerId: customerCareLevelHistory.customerId,
      billingType: customers.billingType,
    })
    .from(customerCareLevelHistory)
    .innerJoin(customers, eq(customers.id, customerCareLevelHistory.customerId))
    .groupBy(customerCareLevelHistory.customerId, customers.billingType);
  for (const r of careLevelCustomers) {
    if (r.billingType !== "selbstzahler") {
      add(r.customerId, "entlastungsbetrag_45b");
    }
  }

  return population;
}

/**
 * (1) Kein Topf überzogen: NettoKonsum ≤ PROJIZIERTE Allocation je (Kunde, Topf).
 *
 * Task #1298 — Die Allocation wird NICHT mehr aus den roh-materialisierten
 * `budget_allocations`-Zeilen summiert, sondern über DENSELBEN
 * Verfügbarkeits-Reader (`readUnifiedBudgetAvailability`) projiziert, den auch
 * die App nutzt (SSoT). Ein Topf gilt genau dann als überzogen, wenn der
 * Netto-Konsum die projizierte Allocation übersteigt — bewertet zum heutigen
 * Stichtag (`todayISO()`), exakt wie die App-Anzeige. Damit ist die Prüfung
 * invariant gegen das Aufräumen der nicht mehr gelesenen Altlast-Quellen
 * (`monthly_auto` etc.), die ohnehin NICHT in die Projektion eingehen.
 */
async function computePotConservation(
  exec: DbOrTx,
  asOfDate: string = todayISO(),
): Promise<PotConservationRow[]> {
  const population = await enumerateConservationPopulation(exec);
  // Der Reader ist rein lesend und ruft kein `.transaction` auf; der zur
  // Laufzeit übergebene Executor (db oder offene Tx) erfüllt DbClient.
  const reader = exec as DbClient;

  const rows: PotConservationRow[] = [];
  for (const [customerId, pots] of population) {
    const availability = await readUnifiedBudgetAvailability(
      customerId,
      asOfDate,
      reader,
    );
    for (const pot of CAPPED_POTS) {
      if (!pots.has(pot)) continue;
      const p = availability.pots[pot];
      const allocated = p.allocatedCents;
      const netConsumed = p.consumedNetCents;
      rows.push({
        customerId,
        budgetType: pot,
        allocatedCents: allocated,
        netConsumedCents: netConsumed,
        availableCents: allocated - netConsumed,
        overdrawn: netConsumed > allocated,
      });
    }
  }
  return rows;
}

/**
 * (2) Reservation ↔ Transaction Kreuzcheck (Stufe B, Task #1273).
 *
 * Ab Stufe B ist `budget_transactions` die eine append-only Finanz-Schicht und
 * `captured_transaction_id` der EINE Capture-Link. Der frühere
 * `budget_ledger`-Spiegel ist seit Stufe C (Task #1274) entfernt. Geprüft
 * werden dieselben fachlichen Aussagen wie vorher auf der neuen Quelle:
 *  - Orphan-Capture: captured Reservierung, deren gesetzter
 *    `captured_transaction_id` auf keine `budget_transactions`-Zeile zeigt.
 *  - Link-Divergenz: captured Reservierung, deren referenzierte Transaktion
 *    einen anderen Kunden/Topf trägt (Betrag NICHT verglichen — die Reservierung
 *    hält den Hold-/Ist-Betrag, die Konsum-Zeile das negative Pendant).
 *  - Reversal-Ketten-Integrität: jede `reversal`-Zeile muss auf eine existierende
 *    `budget_transactions`-Zeile (`reversed_transaction_id`) verweisen.
 * Reservierungen mit leerem `captured_transaction_id` (Legacy) sind KEINE
 * Verletzung.
 */
async function checkLedgerReservationCrosslinks(
  exec: DbOrTx,
): Promise<{ violations: number; details: string[]; divergences: number }> {
  const details: string[] = [];
  let divergences = 0;

  const captured = await exec
    .select({
      reservationId: budgetReservations.id,
      customerId: budgetReservations.customerId,
      budgetType: budgetReservations.budgetType,
      capturedTransactionId: budgetReservations.capturedTransactionId,
      txCustomerId: budgetTransactions.customerId,
      txBudgetType: budgetTransactions.budgetType,
    })
    .from(budgetReservations)
    .leftJoin(
      budgetTransactions,
      eq(budgetTransactions.id, budgetReservations.capturedTransactionId),
    )
    .where(
      and(
        eq(budgetReservations.state, "captured"),
        sql`${budgetReservations.capturedTransactionId} IS NOT NULL`,
      ),
    );

  for (const r of captured) {
    if (r.txCustomerId === null && r.txBudgetType === null) {
      // Orphan-Capture: capturedTransactionId zeigt ins Leere.
      divergences++;
      details.push(
        `Reservation #${r.reservationId} ist 'captured', aber capturedTransactionId=${r.capturedTransactionId ?? "NULL"} zeigt auf keine budget_transactions-Zeile`,
      );
      continue;
    }
    const mismatches: string[] = [];
    if (r.txCustomerId !== r.customerId) {
      mismatches.push(`Kunde ${r.customerId}≠${r.txCustomerId ?? "NULL"}`);
    }
    if (r.txBudgetType !== r.budgetType) {
      mismatches.push(`Topf ${r.budgetType}≠${r.txBudgetType ?? "NULL"}`);
    }
    if (mismatches.length > 0) {
      divergences++;
      details.push(
        `Reservation #${r.reservationId}: Link-Divergenz (Transaktion #${r.capturedTransactionId}) — ${mismatches.join(", ")}`,
      );
    }
  }

  // Reversal-Ketten-Integrität auf budget_transactions (umgezogen vom seit
  // Stufe C entfernten budget_ledger-Spiegel): jede reversal-Zeile muss eine
  // existierende Originalzeile referenzieren.
  const reversalRows = await exec
    .select({
      id: budgetTransactions.id,
      reversedTransactionId: budgetTransactions.reversedTransactionId,
    })
    .from(budgetTransactions)
    .where(eq(budgetTransactions.transactionType, "reversal"));

  const refIds = Array.from(
    new Set(
      reversalRows
        .map((r) => r.reversedTransactionId)
        .filter((id): id is number => id !== null),
    ),
  );
  if (refIds.length > 0) {
    const existing = new Set(
      (
        await exec
          .select({ id: budgetTransactions.id })
          .from(budgetTransactions)
          .where(inArray(budgetTransactions.id, refIds))
      ).map((r) => r.id),
    );
    for (const r of reversalRows) {
      if (r.reversedTransactionId !== null && !existing.has(r.reversedTransactionId)) {
        details.push(
          `Storno #${r.id} verweist auf nicht existierende Transaktion ${r.reversedTransactionId}`,
        );
      }
    }
  }

  return { violations: details.length, details, divergences };
}

/**
 * Read-only Conservation-Check gegen den übergebenen Executor (DB oder offene
 * Transaktion). Wirft NICHT — gibt das strukturierte Ergebnis zurück, damit
 * Aufrufer (CLI vs. Migrations-Guard) selbst über die Reaktion entscheiden.
 *
 * `asOfDate` ist der Stichtag, zu dem die projizierte Allocation/Konsum-Sicht
 * jedes Topfes bewertet wird (Default: heute, wie die App-Anzeige). Period-
 * bewusste Aufrufer (z. B. das „Was hängt"-Panel) übergeben den Monatsstichtag,
 * damit die Überzogen-Aussage zum gewählten Zeitraum passt.
 */
export async function checkBudgetConservation(
  exec: DbOrTx,
  asOfDate: string = todayISO(),
): Promise<ConservationResult> {
  const potRows = await computePotConservation(exec, asOfDate);
  const cross = await checkLedgerReservationCrosslinks(exec);

  const potViolationKeys = potRows
    .filter((r) => r.overdrawn)
    .map((r) => `${r.customerId}|${r.budgetType}`);

  return {
    checkedPairs: potRows.length,
    potRows,
    potViolationKeys,
    crossViolations: cross.violations,
    crossDetails: cross.details,
    linkDivergences: cross.divergences,
    total: potViolationKeys.length + cross.violations,
  };
}
