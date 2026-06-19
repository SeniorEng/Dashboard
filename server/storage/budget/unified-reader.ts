/**
 * Task #874 — Budget GF Phase 4: Unified read SSoT.
 *
 * Dies ist DER eine Budget-Verfügbarkeits-Reader. Er berechnet die
 * Verfügbarkeit aller statutarischen Töpfe über die EINE Erhaltungs-Identität
 *
 *     Available = Allocated − HoldsActive − ConsumedNet
 *
 * und kappt §45a/§39+§42a über den Cap-SSoT `computeCapSlot`. Alle Lese-Pfade,
 * die "wieviel ist (noch) verfügbar" beantworten, MÜSSEN durch diesen Reader
 * gehen — `getAvailableForDate` ist nur noch ein dünner Wrapper (Sync + Delegat),
 * die Architektur-Tests (`tests/architecture/budget-single-reader.test.ts`)
 * verbieten neue Parallel-Reader.
 *
 * HoldsActive ist in Phase 4 strukturell 0 — Reservierungen (`budget_reservations`)
 * werden erst in Phase 5 geschrieben. Die Komponente ist hier explizit benannt,
 * damit der Hard-Hold-Layer (Phase 5) sie nur noch füllen muss, ohne die
 * Identität zu ändern.
 *
 * WICHTIG: Dieser Reader ist REIN LESEND (nur `db.select` / `computeCapSlot` /
 * `calculateAllocatedCents`). Er ruft KEIN `syncCarryoverAndExpiry` auf, damit
 * er prod-sicher im Conservation-Verifier-Stil laufen kann.
 */
import { budgetTransactions, budgetReservations, customers } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { customersRepo } from "../../repos";
import type { DbClient } from "./types";
import { readBudgetTypeSettings, getBudgetPreferences } from "./preferences-storage";
import { calculateAllocatedCents } from "./allocation-storage";
import { computeCapSlot } from "./cap-calculator";
import { netAvailable45bAt } from "./net-available-45b";
import { effectiveDefaultPots } from "@shared/domain/budgets";

/**
 * Task #875 (Phase 5): aktive Hard-Holds (`budget_reservations.state = 'hold'`)
 * gehen jetzt als `HoldsActive` in die Erhaltungs-Identität ein. Solange kein
 * Pfad Holds schreibt (Feature-Flag `BUDGET_HARD_HOLDS` aus), liefert die
 * Aggregation 0 → die Verfügbarkeit ist byte-identisch zu Phase 4.
 */
export const HOLDS_ACTIVE_CENTS_PHASE4 = 0 as const;

/**
 * Summe der AKTIVEN Holds (state='hold') eines Topfes im relevanten Fenster.
 *
 * Holds sind operative Reservierungen für GEPLANTE (oft zukünftige) Termine und
 * werden daher bewusst NICHT auf `≤ asOfDate` gefiltert — ein Hold für einen
 * Termin nächste Woche muss die heute verfügbare Summe schon reduzieren.
 * Fenster pro Topf identisch zur Consumed-Sicht:
 *   - §45b / §39+§42a: gesamtes Kalenderjahr von `asOfDate` (`period` = 'YYYY-MM').
 *   - §45a: exakt der Kalendermonat von `asOfDate`.
 */
export async function activeHoldsCents(
  customerId: number,
  budgetType: string,
  asOfDate: string,
  window: "year" | "month",
  d: DbClient,
): Promise<number> {
  const periodPrefix =
    window === "month" ? asOfDate.slice(0, 7) : asOfDate.slice(0, 4);
  const [row] = await d
    .select({
      total: sql<number>`COALESCE(SUM(${budgetReservations.amountCents}), 0)`,
    })
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.customerId, customerId),
        eq(budgetReservations.budgetType, budgetType),
        eq(budgetReservations.state, "hold"),
        sql`${budgetReservations.period} LIKE ${periodPrefix + "%"}`,
      ),
    );
  return Math.max(0, Number(row?.total ?? 0));
}

export type CappedBudgetPot =
  | "entlastungsbetrag_45b"
  | "umwandlung_45a"
  | "ersatzpflege_39_42a";

export interface PotAvailability {
  budgetType: CappedBudgetPot;
  /** Topf aktiv (enabled-Flag der Settings; Default je Topf). */
  enabled: boolean;
  /** asOfDate liegt in `[validFrom, validTo]` (oder Settings fehlen → true). */
  inRange: boolean;
  /** Bis zum asOfDate aufgelaufene Allocation (SSoT: `calculateAllocatedCents`). */
  allocatedCents: number;
  /** Netto-Konsum im relevanten Fenster (§45b: bis asOfDate; §45a/§39: Cap-Fenster). */
  consumedNetCents: number;
  /** Aktive Hard-Holds — Phase 4 stets 0. */
  holdsActiveCents: number;
  /** Verbleibender statutarischer Cap (`Infinity`, wo kein Cap bindet). */
  capRemainingCents: number;
  /** Verfügbar = max(0, Allocated − Holds − ConsumedNet), gekappt auf capRemaining. */
  availableCents: number;
}

export interface UnifiedBudgetAvailability {
  customerId: number;
  asOfDate: string;
  pots: Record<CappedBudgetPot, PotAvailability>;
  total45b: number;
  total45a: number;
  total39_42a: number;
  totalCents: number;
  /** Summe der aktiven Hard-Holds über alle Töpfe (Phase 5). */
  totalHoldsCents: number;
}

/**
 * Netto-Konsum bis (inkl.) `asOfDate` für einen Topf, in der Allocation-Sicht:
 *   Σ|consumption| + Σ|write_off| − Σ|reversal|   (kein manual_adjustment).
 *
 * Identisch zur bisherigen `getAvailableForDate`-Mathematik (Task #561/#727) —
 * die §45b-Verfügbarkeit ist „aufgelaufene Allocation minus bereits gebuchter
 * Beträge bis zum Buchungsdatum".
 */
export async function netConsumedUpToDate(
  customerId: number,
  budgetType: string,
  asOfDate: string,
  d: DbClient,
): Promise<number> {
  const [consumed, reversed] = await Promise.all([
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
      sql`${budgetTransactions.transactionDate} <= ${asOfDate}`,
    )),
    d.select({
      total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
    }).from(budgetTransactions).where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, budgetType),
      eq(budgetTransactions.transactionType, "reversal"),
      sql`${budgetTransactions.transactionDate} <= ${asOfDate}`,
    )),
  ]);
  return Math.max(0, Number(consumed[0]?.total ?? 0) - Number(reversed[0]?.total ?? 0));
}

export function isInRange(
  asOfDate: string,
  validFrom: string | null | undefined,
  validTo: string | null | undefined,
): boolean {
  return (!validFrom || asOfDate >= validFrom) && (!validTo || asOfDate <= validTo);
}

function emptyPot(budgetType: CappedBudgetPot, enabled: boolean, inRange: boolean): PotAvailability {
  return {
    budgetType,
    enabled,
    inRange,
    allocatedCents: 0,
    consumedNetCents: 0,
    holdsActiveCents: HOLDS_ACTIVE_CENTS_PHASE4,
    capRemainingCents: Infinity,
    availableCents: 0,
  };
}

/**
 * DER unified Budget-Verfügbarkeits-Reader. Reproduziert exakt die bisherige
 * `getAvailableForDate`-Mathematik, aber als eine benannte Erhaltungs-Identität
 * mit Per-Topf-Aufschlüsselung. Rein lesend.
 */
export async function readUnifiedBudgetAvailability(
  customerId: number,
  asOfDate: string,
  tx?: DbClient,
): Promise<UnifiedBudgetAvailability> {
  const d = tx ?? db;

  const [typeSettings, preferences, customerRows] = await Promise.all([
    readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate }, tx),
    getBudgetPreferences(customerId, tx),
    customersRepo.selectColumnsFrom({ billingType: customers.billingType }, d).where(eq(customers.id, customerId)),
  ]);
  const billingType = customerRows[0]?.billingType;

  const settingsMap = new Map(typeSettings.map((s) => [s.budgetType, s]));
  const txYear = parseInt(asOfDate.slice(0, 4), 10);

  // BUG-19 (Facette A): Default-Aktivierung (keine persistierte Zeile) kommt aus
  // der SSoT `effectiveDefaultPots(customer)`, die denselben Selbstzahler-/
  // Anspruchs-Gate durchläuft — Selbstzahler haben keinen §45b-Anspruch, §45a/§39
  // sind grundsätzlich default-deaktiviert. Persistierte Zeilen behalten ihren
  // `enabled`-Wert (Datenpflege via PUT type-settings). Kein Silent-Fallback auf
  // "kein Selbstzahler" bei Load-Fehler. `pflegegrad` ist für den Default
  // irrelevant (nur §45b/billingType-abhängig), daher hier nicht geladen.
  const defaultEnabled = new Map(
    effectiveDefaultPots({ billingType, pflegegrad: null }).map((p) => [p.budgetType, p.enabled]),
  );

  // ---- §45b (Jahrestopf ohne statutarischen Fenster-Cap) ----
  const s45b = settingsMap.get("entlastungsbetrag_45b");
  const enabled45b = s45b ? s45b.enabled : (defaultEnabled.get("entlastungsbetrag_45b") ?? false);
  const inRange45b = !s45b ? true : isInRange(asOfDate, s45b.validFrom, s45b.validTo);
  let pot45b = emptyPot("entlastungsbetrag_45b", enabled45b, inRange45b);
  if (enabled45b && inRange45b) {
    // Task #1348 — §45b-Verfügbarkeits-SSoT: die Erhaltungs-Identität
    // `max(0, allocated − holds − consumedNet)` (inkl. der #1306/#1340-Exklusion
    // von Verbrauch gegen herausgefallene Töpfe) lebt jetzt AUSSCHLIESSLICH in
    // `netAvailable45bAt`. Reader-Kontext zieht die aktiven Hard-Holds ab
    // (`holds: "subtract"`). Der per-Kunde-Monats-Cap (Task #1171/#425) bleibt
    // bewusst HIER im Reader (`Math.min(Topf-Rest, Cap-Rest)`) — er ist nicht
    // Teil der §45b-Verfügbarkeits-Funktion.
    const net = await netAvailable45bAt(
      customerId,
      asOfDate,
      { holds: "subtract", typeSettings },
      tx,
    );
    const potRemaining = net.availableCents;

    let capRemaining = Infinity;
    let available = potRemaining;
    if (s45b?.monthlyLimitCents != null) {
      const cap = await computeCapSlot({
        customerId,
        budgetType: "entlastungsbetrag_45b",
        transactionDate: asOfDate,
        monthlyLimitCents: s45b.monthlyLimitCents,
        yearlyLimitCents: null,
      }, tx);
      capRemaining = cap.capRemainingCents;
      available = Math.min(potRemaining, cap.capRemainingCents);
    }
    pot45b = {
      budgetType: "entlastungsbetrag_45b",
      enabled: enabled45b,
      inRange: inRange45b,
      allocatedCents: net.allocatedCents,
      consumedNetCents: net.consumedNetCents,
      holdsActiveCents: net.holdsCents,
      capRemainingCents: capRemaining,
      availableCents: available,
    };
  }

  // ---- §45a (Monats-Cap via computeCapSlot) ----
  const s45a = settingsMap.get("umwandlung_45a");
  const enabled45a = s45a ? s45a.enabled : (defaultEnabled.get("umwandlung_45a") ?? false);
  const inRange45a = !s45a ? true : isInRange(asOfDate, s45a.validFrom, s45a.validTo);
  let pot45a = emptyPot("umwandlung_45a", enabled45a, inRange45a);
  if (enabled45a && inRange45a) {
    const allocated = await calculateAllocatedCents(
      customerId,
      "umwandlung_45a",
      { asOfDate },
      tx,
      preferences,
      typeSettings,
    );
    const cap = await computeCapSlot({
      customerId,
      budgetType: "umwandlung_45a",
      transactionDate: asOfDate,
      monthlyLimitCents: s45a?.monthlyLimitCents ?? null,
      yearlyLimitCents: null,
    }, tx);
    const holds = await activeHoldsCents(customerId, "umwandlung_45a", asOfDate, "month", d);
    const potRemaining = Math.max(0, allocated - holds - cap.netUsedInWindowCents);
    pot45a = {
      budgetType: "umwandlung_45a",
      enabled: enabled45a,
      inRange: inRange45a,
      allocatedCents: allocated,
      consumedNetCents: cap.netUsedInWindowCents,
      holdsActiveCents: holds,
      capRemainingCents: cap.capRemainingCents,
      availableCents: Math.min(potRemaining, cap.capRemainingCents),
    };
  }

  // ---- §39/§42a (Jahres-Cap via computeCapSlot) ----
  const s39 = settingsMap.get("ersatzpflege_39_42a");
  const enabled39 = s39 ? s39.enabled : (defaultEnabled.get("ersatzpflege_39_42a") ?? false);
  const inRange39 = !s39 ? true : isInRange(asOfDate, s39.validFrom, s39.validTo);
  let pot39 = emptyPot("ersatzpflege_39_42a", enabled39, inRange39);
  if (enabled39 && inRange39) {
    const allocated = await calculateAllocatedCents(
      customerId,
      "ersatzpflege_39_42a",
      { year: txYear },
      tx,
      preferences,
      typeSettings,
    );
    const cap = await computeCapSlot({
      customerId,
      budgetType: "ersatzpflege_39_42a",
      transactionDate: asOfDate,
      monthlyLimitCents: null,
      yearlyLimitCents: s39?.yearlyLimitCents ?? null,
    }, tx);
    const holds = await activeHoldsCents(customerId, "ersatzpflege_39_42a", asOfDate, "year", d);
    const potRemaining = Math.max(0, allocated - holds - cap.netUsedInWindowCents);
    pot39 = {
      budgetType: "ersatzpflege_39_42a",
      enabled: enabled39,
      inRange: inRange39,
      allocatedCents: allocated,
      consumedNetCents: cap.netUsedInWindowCents,
      holdsActiveCents: holds,
      capRemainingCents: cap.capRemainingCents,
      availableCents: Math.min(potRemaining, cap.capRemainingCents),
    };
  }

  return {
    customerId,
    asOfDate,
    pots: {
      entlastungsbetrag_45b: pot45b,
      umwandlung_45a: pot45a,
      ersatzpflege_39_42a: pot39,
    },
    total45b: pot45b.availableCents,
    total45a: pot45a.availableCents,
    total39_42a: pot39.availableCents,
    totalCents: pot45b.availableCents + pot45a.availableCents + pot39.availableCents,
    totalHoldsCents:
      pot45b.holdsActiveCents + pot45a.holdsActiveCents + pot39.holdsActiveCents,
  };
}
