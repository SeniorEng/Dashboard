/**
 * Task #974 — Pure Klassifizierungs-Kern des Budget-Exposure-Reports.
 *
 * Dieser Modul enthält ausschließlich die REINE, deterministische Logik des
 * Reports (`report-budget-exposure.ts`): die Topf-/Gesamt-Erschöpfungs-
 * Klassifizierung, die Selbstzahler-Routing-Regel und das CSV-/Konsolen-Zellen-
 * Mapping. KEINE Seiteneffekte (kein DB-Zugriff, kein `process.argv`, kein
 * Top-Level-`main`), damit die Aussagekraft des Reports gezielt getestet werden
 * kann.
 *
 * Klassifizierungs-Regeln (SSoT, identisch zur Doku im Skript-Header):
 *   - Topf erschöpft  = aktiv (enabled && inRange) && availableCents <= 0
 *   - gesamt erschöpft = activePots > 0 && totalCents <= 0
 *   - Selbstzahler/privat = uncapped → nie erschöpft, aus der Zählung ausgenommen
 *
 * Die `…RemainingCents`/Zell-Werte aus `buildMonthEval` speisen SOWOHL die
 * Konsolenausgabe (`potCell`) ALS AUCH die CSV-Zeile (`toCsv`) — dieselbe Quelle
 * für beide Ausgaben, damit Report und Export nicht driften können.
 */
import type {
  PotAvailability,
  UnifiedBudgetAvailability,
} from "../storage/budget/unified-reader";
import { formatEuroDE } from "@shared/utils/money";

export const euro = (c: number): string => formatEuroDE(c);
export const eurCsv = (c: number): string => (c / 100).toFixed(2);

export interface MonthSlot {
  label: string; // YYYY-MM
  asOfDate: string; // YYYY-MM-DD
}

export interface PotEval {
  active: boolean; // enabled && inRange
  remainingCents: number;
  exhausted: boolean; // active && remaining <= 0
}

export interface MonthEval {
  slot: MonthSlot;
  activePots: number;
  overallRemainingCents: number;
  overallExhausted: boolean;
  p45b: PotEval;
  p45a: PotEval;
  p39: PotEval;
}

export type CustomerKind = "statutory" | "selbstzahler";

export interface CustomerReportBase {
  id: number;
  name: string;
  billingType: string;
  acceptsPrivatePayment: boolean;
  kind: CustomerKind;
}

export interface CustomerReport extends CustomerReportBase {
  months: MonthEval[];
  firstOverallIdx: number | null;
  first45bIdx: number | null;
  first45aIdx: number | null;
  first39Idx: number | null;
  anyExhausted: boolean;
}

/**
 * Selbstzahler routen 100 % in den ungedeckelten Privattopf und laufen nie leer.
 * Alle übrigen Abrechnungsarten sind statutarisch (gedeckelte Töpfe).
 */
export function classifyKind(billingType: string): CustomerKind {
  return billingType === "selbstzahler" ? "selbstzahler" : "statutory";
}

/**
 * Ein Topf gilt nur als „erschöpft", wenn er AKTIV ist (enabled-Flag UND
 * asOfDate im `[validFrom, validTo]`-Fenster) UND ≤ 0 € verfügbar hat. Ein
 * inaktiver / außerhalb des Fensters liegender Topf trägt 0 € „remaining" bei
 * und wird NIE als erschöpft markiert (verhindert Fehlklassifizierung).
 */
export function evalPot(p: PotAvailability): PotEval {
  const active = p.enabled && p.inRange;
  return {
    active,
    remainingCents: active ? p.availableCents : 0,
    exhausted: active && p.availableCents <= 0,
  };
}

/**
 * Klassifiziert einen Monats-Stichtag aus der unified Verfügbarkeit. Gesamt-
 * Erschöpfung erfordert mindestens EINEN aktiven Topf — ein Kunde ohne aktive
 * Töpfe (totalCents == 0, activePots == 0) ist NICHT erschöpft.
 */
export function buildMonthEval(
  slot: MonthSlot,
  u: UnifiedBudgetAvailability,
): MonthEval {
  const p45b = evalPot(u.pots.entlastungsbetrag_45b);
  const p45a = evalPot(u.pots.umwandlung_45a);
  const p39 = evalPot(u.pots.ersatzpflege_39_42a);
  const activePots = [p45b, p45a, p39].filter((p) => p.active).length;
  return {
    slot,
    activePots,
    overallRemainingCents: u.totalCents,
    overallExhausted: activePots > 0 && u.totalCents <= 0,
    p45b,
    p45a,
    p39,
  };
}

const firstIdx = (
  monthEvals: MonthEval[],
  pick: (m: MonthEval) => boolean,
): number | null => {
  const idx = monthEvals.findIndex(pick);
  return idx === -1 ? null : idx;
};

/**
 * Baut den vollständigen Kunden-Report aus den Monats-Bewertungen. Selbstzahler
 * werden hier (mit leerer Monatsliste, `anyExhausted = false`) als uncapped
 * geführt und aus jeder Erschöpfungs-Zählung herausgehalten.
 */
export function buildCustomerReport(
  base: CustomerReportBase,
  monthEvals: MonthEval[],
): CustomerReport {
  if (base.kind === "selbstzahler") {
    return {
      ...base,
      months: [],
      firstOverallIdx: null,
      first45bIdx: null,
      first45aIdx: null,
      first39Idx: null,
      anyExhausted: false,
    };
  }

  const firstOverallIdx = firstIdx(monthEvals, (m) => m.overallExhausted);
  const first45bIdx = firstIdx(monthEvals, (m) => m.p45b.exhausted);
  const first45aIdx = firstIdx(monthEvals, (m) => m.p45a.exhausted);
  const first39Idx = firstIdx(monthEvals, (m) => m.p39.exhausted);

  return {
    ...base,
    months: monthEvals,
    firstOverallIdx,
    first45bIdx,
    first45aIdx,
    first39Idx,
    anyExhausted:
      firstOverallIdx !== null ||
      first45bIdx !== null ||
      first45aIdx !== null ||
      first39Idx !== null,
  };
}

export function potCell(label: string, p: PotEval): string {
  if (!p.active) return `${label} inaktiv`;
  return `${label} ${euro(p.remainingCents)}${p.exhausted ? " ⚠" : ""}`;
}

export const CSV_HEADER = [
  "customerId",
  "customerName",
  "billingType",
  "acceptsPrivatePayment",
  "kind",
  "month",
  "asOfDate",
  "activePots",
  "overallRemainingEur",
  "overallExhausted",
  "p45bActive",
  "p45bRemainingEur",
  "p45bExhausted",
  "p45aActive",
  "p45aRemainingEur",
  "p45aExhausted",
  "p39Active",
  "p39RemainingEur",
  "p39Exhausted",
] as const;

const csvEsc = (s: string): string =>
  /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

/**
 * Eine CSV-Zeile (Kunde × Monat). Die Werte (active/remaining/exhausted) stammen
 * aus demselben `MonthEval`, das auch die Konsolenausgabe speist → Report und
 * Export bleiben deckungsgleich.
 */
export function csvRowForMonth(r: CustomerReport, m: MonthEval): string {
  return [
    r.id,
    csvEsc(r.name),
    r.billingType,
    r.acceptsPrivatePayment,
    r.kind,
    m.slot.label,
    m.slot.asOfDate,
    m.activePots,
    eurCsv(m.overallRemainingCents),
    m.overallExhausted,
    m.p45b.active,
    m.p45b.active ? eurCsv(m.p45b.remainingCents) : "n/a",
    m.p45b.exhausted,
    m.p45a.active,
    m.p45a.active ? eurCsv(m.p45a.remainingCents) : "n/a",
    m.p45a.exhausted,
    m.p39.active,
    m.p39.active ? eurCsv(m.p39.remainingCents) : "n/a",
    m.p39.exhausted,
  ].join(",");
}

/**
 * Selbstzahler-CSV-Zeile (Kunde × Monat): durchgängig „uncapped"/false, da der
 * Privattopf nie erschöpft.
 */
export function csvRowForSelbstzahler(
  r: CustomerReport,
  slot: MonthSlot,
): string {
  return [
    r.id,
    csvEsc(r.name),
    r.billingType,
    r.acceptsPrivatePayment,
    r.kind,
    slot.label,
    slot.asOfDate,
    "0",
    "uncapped",
    "false",
    "false",
    "uncapped",
    "false",
    "false",
    "uncapped",
    "false",
    "false",
    "uncapped",
    "false",
  ].join(",");
}

export function toCsv(reports: CustomerReport[], months: MonthSlot[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of reports) {
    if (r.kind === "selbstzahler") {
      for (const slot of months) {
        lines.push(csvRowForSelbstzahler(r, slot));
      }
      continue;
    }
    for (const m of r.months) {
      lines.push(csvRowForMonth(r, m));
    }
  }
  return lines.join("\n");
}
