/**
 * Task #1129 — §45b FIFO-Aufschlüsselung (rein lesend, read-only Visualisierung).
 *
 * Liefert die §45b-Verfügbarkeit in der FIFO-Reihenfolge auf ZWEI Töpfe
 * aufgeschlüsselt:
 *   1. `carryover`     — Vorjahres-Übertrag (verfällt zum `carryoverExpiresAt`).
 *   2. `current_year`  — laufendes Jahr (monatlicher Auto-Anspruch + Startwert).
 *
 * Jeder Topf wird in seine Zustände zerlegt:
 *   consumed (billed + documented + other) · planned (aktive Hard-Holds) · free.
 *
 * WICHTIG — keine parallele Verfügbarkeits-Mathematik (Task #874 I1): Die
 * Summen A (allocated), C (consumedNet), H (holds) und V (available) kommen
 * AUSSCHLIESSLICH aus `readUnifiedBudgetAvailability` (dem EINEN Reader). Diese
 * Funktion verteilt diese Summen nur FIFO-konform auf die beiden Töpfe und
 * klassifiziert den Konsum nach Termin-Zustand. Es gilt per Konstruktion:
 *   Σ pots.allocatedCents === A,  Σ pots.consumedCents === C,
 *   Σ pots.remainingCents === V.
 * (`C` == Karten-`totalUsedCents` exakt, solange kein `manual_adjustment`
 *  existiert — die bekannte manual_adjustment-Schatten-Drift ist Phase-6-Thema
 *  und wird hier bewusst NICHT übermalt.)
 */
import {
  allocationValidAtWhere,
  notDisplacedByResetWhere,
  countedConsumptionWhere,
  type VerbrauchsSchnitt,
  RESET_DISPLACES_ALL_SOURCES_DEFAULT,
} from "./allocation-window";
import { budgetAllocations, budgetTransactions, invoiceLineItems, invoices, appointments } from "@shared/schema";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { appointmentsRepo, budgetAllocationsRepo } from "../../repos";
import { todayISO } from "@shared/utils/datetime";
import { readUnifiedBudgetAvailability } from "./unified-reader";
import { read45bAllocationDiagnostics } from "./allocation-storage";
import { activeInvoiceCondition } from "../../lib/appointment-invoiced";

export type Budget45bFifoPotType = "carryover" | "current_year";

export interface Budget45bFifoPot {
  potType: Budget45bFifoPotType;
  allocatedCents: number;
  consumedCents: number;
  consumedBilledCents: number;
  consumedDocumentedCents: number;
  consumedOtherCents: number;
  plannedCents: number;
  remainingCents: number;
}

export interface Budget45bFifoBreakdown {
  /** FIFO-Reihenfolge: Übertrag zuerst, dann laufendes Jahr. */
  pots: Budget45bFifoPot[];
  /** Verfallsdatum des frühesten Übertrags (null wenn kein Übertrag). */
  carryoverExpiresAt: string | null;
  /** Reconciliation-Summen (== unified Reader bzw. Karten-Zahlen). */
  totalAllocatedCents: number;
  totalConsumedCents: number;
  totalPlannedCents: number;
  totalAvailableCents: number;
}

type ConsumedStates = { billed: number; documented: number };

export async function readBudget45bFifoBreakdown(
  customerId: number,
  asOfDate: string = todayISO(),
  /**
   * `resetDisplacesAllSources` MUSS hier ankommen und an BEIDE Quellen unten
   * weitergereicht werden.
   *
   * `allocatedCur = A − allocatedCarry` zieht zwei Zahlen voneinander ab, die
   * aus verschiedenen Ecken kommen: `A` aus `calculateAllocated45b` (kennt die
   * Verdraengung), `allocatedCarry` aus handgeschriebenem SQL (kannte sie
   * nicht). Gemessen fiel `allocatedCur` damit auf **−1.048,00 EUR** — und der
   * Client filtert einen negativen Topf ueber `p.allocatedCents > 0` still
   * weg. Der Fehler zeigt sich dann als FEHLENDE Zeile, was aussieht wie
   * „kein Uebertrag vorhanden".
   */
  opts?: { resetDisplacesAllSources?: boolean },
): Promise<Budget45bFifoBreakdown> {
  // ---- 1) Summen aus dem EINEN Verfügbarkeits-Reader (SSoT) ----
  const unified = await readUnifiedBudgetAvailability(customerId, asOfDate, undefined, {
    resetDisplacesAllSources: opts?.resetDisplacesAllSources,
  });
  const pot = unified.pots.entlastungsbetrag_45b;
  const A = pot.allocatedCents;
  const C = pot.consumedNetCents;
  const H = pot.holdsActiveCents;
  const V = pot.availableCents;

  // ---- 2) Übertrags-Allocations (identischer Filter wie FIFO-Engine) ----
  // `?? DEFAULT`, nicht blosse Truthiness: `A` unten kommt ueber
  // `readUnifiedBudgetAvailability` aus `calculateAllocated45b` und folgt der
  // Konstante. Haenge diese Zeile nur an `opts`, dann verdraengt der Anspruch
  // beim Default-Umschwung und die Uebertrags-Summe nicht — gemessen faellt
  // `allocatedCur` dann auf −1.048,00 EUR (Gate 2 zu #180, B1).
  /**
   * EIN Lesevorgang, drei Glieder, zwei Anker.
   *
   * ERSETZT `readResetAnchor` an dieser Stelle. Die Diagnose-Groesse kommt aus
   * DERSELBEN Rechnung, aus der `A` und `C` oben stammen
   * (`calculateAllocated45b`) — und liefert alle drei Ausschluss-Glieder statt
   * nur des Ankers.
   *
   * ── Warum nicht mehr `readResetAnchor` ──────────────────────────────────
   * Die beiden beantworten „welcher Startwert ist der Reset?" auf zwei Wegen:
   * `readResetAnchor` ueber eine eigene Rohabfrage plus `resetAnchorFrom`, der
   * Reader ueber `calculateAllocated45b`. Der zweite gibt `resetAnchor: null`
   * zurueck, wenn der §45b-Anker `ineligible` ist — der erste nicht. Damit
   * schnitt die Aufschluesselung dort, wo der Reader es nicht tat (Gate 2 zu
   * #190, N-1). Ein Zweitbegriff derselben Frage, und er ist mit dieser
   * Umstellung weg.
   *
   * ── Der VERBRAUCHS-Schnitt haengt NICHT am Flag ─────────────────────────
   * Zwei verschiedene Fragen:
   *  · `resetAnchor` unten entscheidet ueber die VERDRAENGUNG von
   *    Uebertragszeilen — die ist schaltbar, und das bleibt so.
   *  · der Schnitt entscheidet, welche BUCHUNGEN zum Stichtag zaehlen. Der
   *    Reader tut das flag-unabhaengig.
   *
   * Daran ist die erste Fassung des Schnitt-Fixes gescheitert: sie benutzte den
   * flag-gegateten Anker, und mit ausgeschaltetem Flag war er `null` — der
   * Schnitt blieb aus, der Verbrauch weiter negativ (`6hcVM394XgmP37GG`).
   *
   * Gemessen und der Grund, warum der Anker hier gefahrlos aus dem
   * flag-behafteten Aufruf kommt: `initialBalanceMonths` filtert nur auf
   * `source` und `month` (`allocation-storage.ts`), die Anker-Auswahl haengt
   * also an keinem Flag. Die Ausschlussliste (Glied a) haengt daran sehr wohl —
   * und MUSS es, weil `C` oben mit demselben Flag gerechnet wurde. Deshalb EIN
   * Aufruf mit denselben `opts` wie der Reader, nicht zwei mit verschiedenen.
   */
  const diagnose = await read45bAllocationDiagnostics(customerId, {
    asOfDate,
    resetDisplacesAllSources: opts?.resetDisplacesAllSources,
  });
  const schnitt: VerbrauchsSchnitt = {
    resetAnchor: diagnose.resetAnchor,
    excludedAllocationIds: diagnose.excludedSpecialAllocationIds,
    accrualFloorDate: diagnose.accrualFloorDate,
  };

  const resetAnchor = (opts?.resetDisplacesAllSources ?? RESET_DISPLACES_ALL_SOURCES_DEFAULT)
    ? diagnose.resetAnchor
    : null;
  const carryoverAllocations = await budgetAllocationsRepo
    .selectColumnsFrom({ id: budgetAllocations.id, amountCents: budgetAllocations.amountCents, expiresAt: budgetAllocations.expiresAt })
    .where(and(
      eq(budgetAllocations.customerId, customerId),
      eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"),
      eq(budgetAllocations.source, "carryover"),
      isNull(budgetAllocations.deletedAt),
      // SSoT statt Nachbau (P1 6hXp9qMrXH2WGVVG, Punkt 2). Der Kommentar
      // darueber sagte „identischer Filter wie FIFO-Engine" — das stimmte,
      // solange beide nur das Zeitfenster pruefen. Eine Zusage, die an
      // Gleichschritt haengt statt an einer gemeinsamen Funktion, gilt nur so
      // lange, bis jemand eine Seite anfasst.
      allocationValidAtWhere(asOfDate),
      // Und dieselbe Verdraengung wie `A` oben — sonst subtrahieren sich zwei
      // Zahlen, die verschiedene Regeln kennen.
      notDisplacedByResetWhere(resetAnchor),
    ));

  const carryoverIds = carryoverAllocations.map(a => a.id);
  const allocatedCarry = carryoverAllocations.reduce((s, a) => s + a.amountCents, 0);
  const carryoverExpiresAt = carryoverAllocations
    .map(a => a.expiresAt)
    .filter((d): d is string => d !== null)
    .sort()[0] ?? null;

  // ---- 3) Übertrags-Konsum (FIFO via allocation_id, per-Allocation gekappt) ----
  // Die EINZIGE Fassung dieser Pro-Allocation-Rest-Mathematik. Der Kommentar
  // verwies hier frueher auf `getAvailableCarryoverCents` in summary-queries.ts
  // („gleiche Mathematik") — die Funktion hatte seit ihrer Entstehung keinen
  // Aufrufer und ist entfernt. Eine zweite, tote Fassung derselben Rechnung
  // ist die naechste Stelle, an der eine Regel auseinanderlaeuft.
  let availableCarry = 0;
  if (carryoverIds.length > 0) {
    const [consumed, reversed] = await Promise.all([
      db.select({
        allocationId: budgetTransactions.allocationId,
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        inArray(budgetTransactions.allocationId, carryoverIds),
        sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off')`,
        // Derselbe Schnitt wie im Reader — sonst subtrahieren sich zwei Zahlen,
        // die verschiedene Mengen sehen (Ticket `6hcVM394XgmP37GG`).
        countedConsumptionWhere(schnitt, asOfDate),
      )).groupBy(budgetTransactions.allocationId),
      db.select({
        allocationId: budgetTransactions.allocationId,
        total: sql<number>`COALESCE(SUM(ABS(${budgetTransactions.amountCents})), 0)`,
      }).from(budgetTransactions).where(and(
        inArray(budgetTransactions.allocationId, carryoverIds),
        eq(budgetTransactions.transactionType, "reversal"),
        countedConsumptionWhere(schnitt, asOfDate),
      )).groupBy(budgetTransactions.allocationId),
    ]);
    const consumedMap = new Map(consumed.map(c => [c.allocationId, Number(c.total)]));
    const reversalMap = new Map(reversed.map(r => [r.allocationId, Number(r.total)]));
    for (const alloc of carryoverAllocations) {
      const used = consumedMap.get(alloc.id) ?? 0;
      const rev = reversalMap.get(alloc.id) ?? 0;
      availableCarry += Math.max(0, alloc.amountCents - Math.max(0, used - rev));
    }
  }

  // ---- 4) FIFO-Verteilung von Konsum / Holds / Frei auf beide Töpfe ----
  /**
   * `consumedCarry` und `C` muessen dieselbe Menge sehen.
   *
   * Die Pro-Allocation-Rechnung oben zaehlte bis zum 24.09.2026 JEDE Buchung
   * gegen eine Uebertrags-Zeile — ohne Stichtag, ohne Reset-Schnitt. `C` kommt
   * aus dem Reader und ist um beides bereinigt. Die Differenz konnte damit
   * negativ werden (gemessen: −100,00 EUR), und der ausgewiesene Rest des
   * laufenden Jahres stieg entsprechend.
   *
   * `countedConsumptionWhere` traegt den Schnitt jetzt an beiden Stellen aus
   * derselben Funktion. Das `Math.max(0, …)` bleibt als zweite Lage stehen —
   * es fing den Fehler nicht, weil er eine Ebene darunter sass.
   */
  const consumedCarry = Math.max(0, allocatedCarry - availableCarry);
  const consumedCur = C - consumedCarry;

  const holdsCarry = Math.min(H, availableCarry);
  const holdsCur = H - holdsCarry;

  const freeCarry = Math.min(Math.max(0, availableCarry - holdsCarry), V);
  const freeCur = V - freeCarry;

  const allocatedCur = A - allocatedCarry;

  // ---- 5) Konsum nach Termin-Zustand zerlegen (billed / documented) ----
  const [billedSet, documentedSet] = await Promise.all([
    loadBilledAppointmentIds(customerId),
    loadDocumentedAppointmentIds(customerId),
  ]);

  const stateByPot = await classifyConsumedByState(customerId, asOfDate, schnitt, new Set(carryoverIds), billedSet, documentedSet);

  const carryStates = splitConsumed(consumedCarry, stateByPot.carryover);
  const curStates = splitConsumed(consumedCur, stateByPot.current);

  const pots: Budget45bFifoPot[] = [
    {
      potType: "carryover",
      allocatedCents: allocatedCarry,
      consumedCents: consumedCarry,
      consumedBilledCents: carryStates.billed,
      consumedDocumentedCents: carryStates.documented,
      consumedOtherCents: carryStates.other,
      plannedCents: holdsCarry,
      remainingCents: freeCarry,
    },
    {
      potType: "current_year",
      allocatedCents: allocatedCur,
      consumedCents: consumedCur,
      consumedBilledCents: curStates.billed,
      consumedDocumentedCents: curStates.documented,
      consumedOtherCents: curStates.other,
      plannedCents: holdsCur,
      remainingCents: freeCur,
    },
  ];

  return {
    pots,
    carryoverExpiresAt,
    totalAllocatedCents: A,
    totalConsumedCents: C,
    totalPlannedCents: H,
    totalAvailableCents: V,
  };
}

function splitConsumed(consumedTotal: number, states: ConsumedStates): { billed: number; documented: number; other: number } {
  const billed = Math.max(0, states.billed);
  const documented = Math.max(0, states.documented);
  // `other` ist der ausgleichende Rest, damit billed + documented + other
  // IMMER exakt `consumedTotal` ergibt (write_off, Importe ohne Termin-Status …).
  const other = consumedTotal - billed - documented;
  return { billed, documented, other };
}

async function loadBilledAppointmentIds(customerId: number): Promise<Set<number>> {
  const rows = await db
    .select({ appointmentId: invoiceLineItems.appointmentId })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoiceLineItems.invoiceId, invoices.id))
    .where(and(
      // Kunden-Scope zusätzlich; „aktiv" kommt aus der SSoT
      // `activeInvoiceCondition` (server/lib/appointment-invoiced.ts).
      eq(invoices.customerId, customerId),
      activeInvoiceCondition(),
    ));
  return new Set(rows.map(r => r.appointmentId).filter((id): id is number => id !== null));
}

async function loadDocumentedAppointmentIds(customerId: number): Promise<Set<number>> {
  const rows = await appointmentsRepo
    .selectColumnsFrom({ id: appointments.id })
    .where(and(
      eq(appointments.customerId, customerId),
      isNull(appointments.deletedAt),
      eq(appointments.status, "completed"),
      sql`${appointments.signatureData} IS NOT NULL`,
    ));
  return new Set(rows.map(r => r.id));
}

async function classifyConsumedByState(
  customerId: number,
  asOfDate: string,
  schnitt: VerbrauchsSchnitt,
  carryoverIdSet: Set<number>,
  billedSet: Set<number>,
  documentedSet: Set<number>,
): Promise<{ carryover: ConsumedStates; current: ConsumedStates }> {
  const txns = await db
    .select({
      appointmentId: budgetTransactions.appointmentId,
      allocationId: budgetTransactions.allocationId,
      transactionType: budgetTransactions.transactionType,
      amountCents: budgetTransactions.amountCents,
    })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
      sql`${budgetTransactions.transactionType} IN ('consumption', 'write_off', 'reversal')`,
      /**
       * DERSELBE Schnitt wie oben (Gate 2 zu #190, B1).
       *
       * Hier stand nur `lte(transactionDate, asOfDate)` — die DRITTE Fassung
       * von „zaehlt diese Buchung?", 140 Zeilen unter der zweiten, ohne
       * Reset-Schnitt. Vor diesem PR waren beide Seiten UNgeschnitten und
       * stimmten ueberein; der Fix schnitt `consumedCarry` und liess die
       * Zustands-Aufteilung stehen.
       *
       * Gemessen (dokumentierter Termin 100,00 EUR am 20.01., Startwert Maerz,
       * Stichtag 15.05.):
       *
       *     vorher  verbr 100,00  dok 100,00  sonst    0,00  rest 400,00
       *     Fix     verbr   0,00  dok 100,00  sonst −100,00  rest 500,00
       *
       * `other = consumedTotal − billed − documented` wird negativ, und der
       * Client verschluckt Negative (`value <= 0 → null`), rendert aber die
       * positive `documented`-Zeile. Der Fehler wanderte damit aus dem
       * unsichtbaren in den sichtbaren Topf — schlimmer als vorher.
       *
       * Glied (b) des Readers ist NICHT allocation-spezifisch, gilt also fuer
       * beide Toepfe. Deshalb dieselbe Funktion, nicht eine vierte Fassung.
       *
       * Seit `6hcfP7xVj5R3Pg6p` traegt der Schnitt ALLE DREI Glieder des
       * Readers. Vorher fehlten hier (a) und (c) wirklich: die Abfrage laeuft
       * kundenweit, ohne `inArray`, mit `allocationId IS NULL` — und es
       * entstand ein negatives `consumedOtherCents`, gemessen je −100,00 EUR
       * (abgelaufener Uebertrag bzw. Vorjahres-Termin auf dem NULL-Leg).
       * Abnahme: `tests/budget/45b-fifo-zustand-ausschluss.test.ts`.
       */
      countedConsumptionWhere(schnitt, asOfDate),
    ));

  const result = {
    carryover: { billed: 0, documented: 0 },
    current: { billed: 0, documented: 0 },
  };

  for (const t of txns) {
    const apptId = t.appointmentId;
    let state: keyof ConsumedStates | null = null;
    if (apptId !== null && billedSet.has(apptId)) state = "billed";
    else if (apptId !== null && documentedSet.has(apptId)) state = "documented";
    if (state === null) continue; // alles andere fließt in `other` (Rest)

    const potKey = t.allocationId !== null && carryoverIdSet.has(t.allocationId) ? "carryover" : "current";
    const signed = t.transactionType === "reversal" ? -Math.abs(t.amountCents) : Math.abs(t.amountCents);
    result[potKey][state] += signed;
  }

  return result;
}
