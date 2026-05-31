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
 * er prod-sicher im Shadow-Read-Soak (`server/scripts/shadow-read-soak.ts`) und
 * im Conservation-Verifier-Stil laufen kann.
 */
import { budgetTransactions } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type { DbClient } from "./types";
import { readBudgetTypeSettings, getBudgetPreferences } from "./preferences-storage";
import { calculateAllocatedCents } from "./allocation-storage";
import { computeCapSlot } from "./cap-calculator";

/**
 * Phase 4: keine aktiven Hard-Holds. Reservierungen kommen in Phase 5; bis dahin
 * ist die Hold-Komponente der Erhaltungs-Identität konstant 0.
 */
export const HOLDS_ACTIVE_CENTS_PHASE4 = 0 as const;

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
}

/**
 * Netto-Konsum bis (inkl.) `asOfDate` für einen Topf, in der Allocation-Sicht:
 *   Σ|consumption| + Σ|write_off| − Σ|reversal|   (kein manual_adjustment).
 *
 * Identisch zur bisherigen `getAvailableForDate`-Mathematik (Task #561/#727) —
 * die §45b-Verfügbarkeit ist „aufgelaufene Allocation minus bereits gebuchter
 * Beträge bis zum Buchungsdatum".
 */
async function netConsumedUpToDate(
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

function isInRange(
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

  const [typeSettings, preferences] = await Promise.all([
    readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate }, tx),
    getBudgetPreferences(customerId, tx),
  ]);

  const settingsMap = new Map(typeSettings.map((s) => [s.budgetType, s]));
  const txYear = parseInt(asOfDate.slice(0, 4), 10);

  // ---- §45b (Jahrestopf ohne statutarischen Fenster-Cap) ----
  const s45b = settingsMap.get("entlastungsbetrag_45b");
  const enabled45b = s45b ? s45b.enabled : true;
  const inRange45b = !s45b ? true : isInRange(asOfDate, s45b.validFrom, s45b.validTo);
  let pot45b = emptyPot("entlastungsbetrag_45b", enabled45b, inRange45b);
  if (enabled45b && inRange45b) {
    const allocated = await calculateAllocatedCents(
      customerId,
      "entlastungsbetrag_45b",
      { asOfDate },
      tx,
      preferences,
      typeSettings,
    );
    const consumedNet = await netConsumedUpToDate(customerId, "entlastungsbetrag_45b", asOfDate, d);
    const available = Math.max(0, allocated - HOLDS_ACTIVE_CENTS_PHASE4 - consumedNet);
    pot45b = {
      budgetType: "entlastungsbetrag_45b",
      enabled: enabled45b,
      inRange: inRange45b,
      allocatedCents: allocated,
      consumedNetCents: consumedNet,
      holdsActiveCents: HOLDS_ACTIVE_CENTS_PHASE4,
      capRemainingCents: Infinity,
      availableCents: available,
    };
  }

  // ---- §45a (Monats-Cap via computeCapSlot) ----
  const s45a = settingsMap.get("umwandlung_45a");
  const enabled45a = s45a ? s45a.enabled : false;
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
    const potRemaining = Math.max(0, allocated - HOLDS_ACTIVE_CENTS_PHASE4 - cap.netUsedInWindowCents);
    pot45a = {
      budgetType: "umwandlung_45a",
      enabled: enabled45a,
      inRange: inRange45a,
      allocatedCents: allocated,
      consumedNetCents: cap.netUsedInWindowCents,
      holdsActiveCents: HOLDS_ACTIVE_CENTS_PHASE4,
      capRemainingCents: cap.capRemainingCents,
      availableCents: Math.min(potRemaining, cap.capRemainingCents),
    };
  }

  // ---- §39/§42a (Jahres-Cap via computeCapSlot) ----
  const s39 = settingsMap.get("ersatzpflege_39_42a");
  const enabled39 = s39 ? s39.enabled : false;
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
    const potRemaining = Math.max(0, allocated - HOLDS_ACTIVE_CENTS_PHASE4 - cap.netUsedInWindowCents);
    pot39 = {
      budgetType: "ersatzpflege_39_42a",
      enabled: enabled39,
      inRange: inRange39,
      allocatedCents: allocated,
      consumedNetCents: cap.netUsedInWindowCents,
      holdsActiveCents: HOLDS_ACTIVE_CENTS_PHASE4,
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
  };
}
