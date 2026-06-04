/**
 * Task #969 — Read-only Budget-Exposure-Report (Pre-Publish-Sicherheitsnetz).
 *
 * Beantwortet vor einem Release die Fragen:
 *   - „Welche aktiven Kunden haben DIESEN Monat 0 € (oder negatives) Budget?"
 *   - „Welche Kunden laufen in den nächsten 6 Monaten leer?" (7 Monate gesamt)
 *
 * Für jeden aktiven Kunden × Monat zeigt der Report die GESAMT-Restverfügbarkeit
 * plus die Aufschlüsselung pro Topf (§45b, §45a, §39+§42a, Selbstzahler/privat)
 * mit „erschöpft"-Flags (≤ 0) auf Gesamt- und Topf-Ebene.
 *
 * SSoT: Die Zahlen kommen ausschließlich aus `readUnifiedBudgetAvailability`
 * — DEM unified Verfügbarkeits-Reader, der auch die Live-Budget-Übersicht
 * (`/api/budget/:id/overview`) speist. KEINE ad-hoc `allocated − used`-SQL-
 * Mathematik. Der Reader ist rein lesend (er ruft KEIN `syncCarryoverAndExpiry`),
 * daher ist dieses Skript — wie `verify-budget-conservation.ts` — prod-runnable
 * und ändert garantiert nichts (nur `db.select` + reiner Lesepfad).
 *
 * Auswertungs-Stichtage:
 *   - laufender Monat: HEUTE (deckungsgleich mit der Live-Übersicht),
 *   - Folgemonate:     jeweils der LETZTE Tag des Monats.
 * §45b wird ohne `projectFuture` gelesen, d. h. die Verfügbarkeit in Folge-
 * monaten ist bis heute aufgelaufene Allocation MINUS bereits gebuchter Beträge
 * bis zum jeweiligen Monatsende — eine bewusst konservative Exposure-Sicht, die
 * noch nicht aufgelaufene Monatsaufstockungen nicht vorzeitig gutschreibt.
 *
 * Selbstzahler (`billingType = 'selbstzahler'`) routen 100 % in den UNGEDECKELTEN
 * Privattopf — sie laufen nie leer und werden separat als „uncapped" geführt
 * (nicht als erschöpft gezählt). Bei Versicherten mit `acceptsPrivatePayment`
 * weist die Spalte „privat" aus, dass eine statutarische Erschöpfung nur ein
 * Soft-Block ist (Überlauf in den ungedeckelten Privattopf).
 *
 * Aufruf:
 *   tsx server/scripts/report-budget-exposure.ts                 # nur Kunden mit ≥1 erschöpftem Monat
 *   tsx server/scripts/report-budget-exposure.ts --all           # alle aktiven Kunden
 *   tsx server/scripts/report-budget-exposure.ts --months=12     # Horizont anpassen (Default 6 = 7 Monate)
 *   tsx server/scripts/report-budget-exposure.ts --customer=12,34 # nur bestimmte Kunden
 *   tsx server/scripts/report-budget-exposure.ts --csv=exposure.csv  # volle Kunde×Monat-Matrix
 *
 * Exit-Code: 0 = kein aktiver Kunde erschöpft, 1 = mindestens ein Kunde
 * erschöpft (CI-/Skript-freundliches Signal). `--all` ändert den Exit-Code nicht.
 */
import { writeFileSync } from "node:fs";
import { and, asc, eq, isNull, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { customers } from "@shared/schema";
import { readUnifiedBudgetAvailability, type PotAvailability } from "../storage/budget/unified-reader";
import { todayISO, currentYearAndMonth, lastDayOfMonth } from "@shared/utils/datetime";
import { formatEuroDE } from "@shared/utils/money";

const euro = (c: number) => formatEuroDE(c);
const eurCsv = (c: number) => (c / 100).toFixed(2);

interface CliArgs {
  showAll: boolean;
  horizonMonths: number;
  customerIds: number[];
  csvPath?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const monthsArg = args.find((a) => a.startsWith("--months="));
  const customerArg = args.find((a) => a.startsWith("--customer="));
  const csvArg = args.find((a) => a.startsWith("--csv="));

  let horizonMonths = 6;
  if (monthsArg) {
    const n = parseInt(monthsArg.split("=")[1], 10);
    if (!isNaN(n) && n >= 0) horizonMonths = n;
  }

  const customerIds = customerArg
    ? customerArg.split("=")[1].split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n))
    : [];

  const csvPath = csvArg ? csvArg.split("=").slice(1).join("=").trim() : undefined;

  return {
    showAll: args.includes("--all"),
    horizonMonths,
    customerIds,
    csvPath: csvPath && csvPath.length > 0 ? csvPath : undefined,
  };
}

interface MonthSlot {
  label: string; // YYYY-MM
  asOfDate: string; // YYYY-MM-DD
}

function buildMonths(horizonMonths: number): MonthSlot[] {
  const { year, month } = currentYearAndMonth();
  const today = todayISO();
  const slots: MonthSlot[] = [];
  for (let i = 0; i <= horizonMonths; i++) {
    let y = year;
    let m = month + i;
    while (m > 12) {
      m -= 12;
      y += 1;
    }
    const label = `${y}-${String(m).padStart(2, "0")}`;
    const asOfDate = i === 0 ? today : lastDayOfMonth(y, m);
    slots.push({ label, asOfDate });
  }
  return slots;
}

interface PotEval {
  active: boolean; // enabled && inRange
  remainingCents: number;
  exhausted: boolean; // active && remaining <= 0
}

function evalPot(p: PotAvailability): PotEval {
  const active = p.enabled && p.inRange;
  return {
    active,
    remainingCents: active ? p.availableCents : 0,
    exhausted: active && p.availableCents <= 0,
  };
}

interface MonthEval {
  slot: MonthSlot;
  activePots: number;
  overallRemainingCents: number;
  overallExhausted: boolean;
  p45b: PotEval;
  p45a: PotEval;
  p39: PotEval;
}

interface CustomerReport {
  id: number;
  name: string;
  billingType: string;
  acceptsPrivatePayment: boolean;
  kind: "statutory" | "selbstzahler";
  months: MonthEval[];
  firstOverallIdx: number | null;
  first45bIdx: number | null;
  first45aIdx: number | null;
  first39Idx: number | null;
  anyExhausted: boolean;
}

async function evaluateCustomer(
  cust: { id: number; name: string; billingType: string; acceptsPrivatePayment: boolean },
  months: MonthSlot[],
): Promise<CustomerReport> {
  const base: Omit<CustomerReport, "months" | "firstOverallIdx" | "first45bIdx" | "first45aIdx" | "first39Idx" | "anyExhausted"> = {
    id: cust.id,
    name: cust.name,
    billingType: cust.billingType,
    acceptsPrivatePayment: cust.acceptsPrivatePayment,
    kind: cust.billingType === "selbstzahler" ? "selbstzahler" : "statutory",
  };

  // Selbstzahler routen in den ungedeckelten Privattopf → laufen nie leer.
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

  const monthEvals: MonthEval[] = [];
  for (const slot of months) {
    const u = await readUnifiedBudgetAvailability(cust.id, slot.asOfDate);
    const p45b = evalPot(u.pots.entlastungsbetrag_45b);
    const p45a = evalPot(u.pots.umwandlung_45a);
    const p39 = evalPot(u.pots.ersatzpflege_39_42a);
    const activePots = [p45b, p45a, p39].filter((p) => p.active).length;
    monthEvals.push({
      slot,
      activePots,
      overallRemainingCents: u.totalCents,
      overallExhausted: activePots > 0 && u.totalCents <= 0,
      p45b,
      p45a,
      p39,
    });
  }

  const firstIdx = (pick: (m: MonthEval) => boolean): number | null => {
    const idx = monthEvals.findIndex(pick);
    return idx === -1 ? null : idx;
  };

  const firstOverallIdx = firstIdx((m) => m.overallExhausted);
  const first45bIdx = firstIdx((m) => m.p45b.exhausted);
  const first45aIdx = firstIdx((m) => m.p45a.exhausted);
  const first39Idx = firstIdx((m) => m.p39.exhausted);

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

async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toCsv(reports: CustomerReport[], months: MonthSlot[]): string {
  const header = [
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
  ];
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [header.join(",")];

  for (const r of reports) {
    if (r.kind === "selbstzahler") {
      for (const slot of months) {
        lines.push(
          [
            r.id,
            esc(r.name),
            r.billingType,
            r.acceptsPrivatePayment,
            r.kind,
            slot.label,
            slot.asOfDate,
            "0",
            "uncapped",
            "false",
            "false", "uncapped", "false",
            "false", "uncapped", "false",
            "false", "uncapped", "false",
          ].join(","),
        );
      }
      continue;
    }
    for (const m of r.months) {
      lines.push(
        [
          r.id,
          esc(r.name),
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
        ].join(","),
      );
    }
  }
  return lines.join("\n");
}

function potCell(label: string, p: PotEval): string {
  if (!p.active) return `${label} inaktiv`;
  return `${label} ${euro(p.remainingCents)}${p.exhausted ? " ⚠" : ""}`;
}

async function main(): Promise<number> {
  const args = parseArgs();
  const months = buildMonths(args.horizonMonths);
  const today = todayISO();

  console.log(`\n=== Budget-Exposure-Report · Read-only (Task #969) ===`);
  console.log(`Stichtag (lfd. Monat): ${today}`);
  console.log(`Horizont: ${months.length} Monate (${months[0].label} … ${months[months.length - 1].label})`);
  console.log(`Modus: ${args.showAll ? "ALLE aktiven Kunden" : "nur Kunden mit ≥1 erschöpftem Monat"}\n`);

  const whereParts = [isNull(customers.deletedAt), eq(customers.status, "aktiv")];
  if (args.customerIds.length > 0) {
    whereParts.push(inArray(customers.id, args.customerIds));
  }

  const custRows = await db
    .select({
      id: customers.id,
      name: customers.name,
      billingType: customers.billingType,
      acceptsPrivatePayment: customers.acceptsPrivatePayment,
    })
    .from(customers)
    .where(and(...whereParts))
    .orderBy(asc(customers.id));

  console.log(`Aktive Kunden (deletedAt IS NULL, status='aktiv'): ${custRows.length}\n`);

  const reports = await mapPool(custRows, 8, (c) => evaluateCustomer(c, months));

  // ---- (1) Monats-Zusammenfassung ----
  console.log(`--- (1) Erschöpfte Kunden pro Monat ---`);
  const statutory = reports.filter((r) => r.kind === "statutory");
  for (let i = 0; i < months.length; i++) {
    const slot = months[i];
    const overall = statutory.filter((r) => r.months[i]?.overallExhausted).length;
    const c45b = statutory.filter((r) => r.months[i]?.p45b.exhausted).length;
    const c45a = statutory.filter((r) => r.months[i]?.p45a.exhausted).length;
    const c39 = statutory.filter((r) => r.months[i]?.p39.exhausted).length;
    console.log(
      `  ${slot.label} (${slot.asOfDate}): gesamt erschöpft ${overall}` +
        ` · §45b ${c45b} · §45a ${c45a} · §39+§42a ${c39}`,
    );
  }

  // ---- (2) Detail-Liste ----
  const exhaustedReports = statutory.filter((r) => r.anyExhausted);
  const detailList = (args.showAll ? statutory : exhaustedReports).slice();
  // Sortierung: zuerst nach frühestem Gesamt-Leerlauf (nulls ans Ende), dann ID.
  const rank = (r: CustomerReport) => (r.firstOverallIdx ?? r.first45bIdx ?? r.first45aIdx ?? r.first39Idx ?? 999);
  detailList.sort((a, b) => rank(a) - rank(b) || a.id - b.id);

  const lbl = (idx: number | null) => (idx === null ? "—" : months[idx].label);

  console.log(`\n--- (2) Detail: ${args.showAll ? "alle statutarischen Kunden" : "Kunden mit Erschöpfung"} (${detailList.length}) ---`);
  for (const r of detailList) {
    const privat = r.acceptsPrivatePayment ? "ja (Soft-Block)" : "nein (Hard-Block)";
    console.log(
      `\n#${r.id} ${r.name.slice(0, 30).padEnd(30)} [${r.billingType}] · Privatzahlung: ${privat}`,
    );
    console.log(
      `  Erste Erschöpfung — gesamt: ${lbl(r.firstOverallIdx)}` +
        ` · §45b: ${lbl(r.first45bIdx)} · §45a: ${lbl(r.first45aIdx)} · §39+§42a: ${lbl(r.first39Idx)}`,
    );
    const m0 = r.months[0];
    if (m0) {
      console.log(
        `  Aktuell (${m0.slot.label}): gesamt ${euro(m0.overallRemainingCents)}${m0.overallExhausted ? " ⚠" : ""}` +
          ` · ${potCell("§45b", m0.p45b)} · ${potCell("§45a", m0.p45a)} · ${potCell("§39+§42a", m0.p39)}`,
      );
    }
  }

  // ---- Selbstzahler-Hinweis ----
  const selbstzahler = reports.filter((r) => r.kind === "selbstzahler");
  if (selbstzahler.length > 0) {
    console.log(
      `\nHinweis: ${selbstzahler.length} Selbstzahler-Kunde(n) routen in den ungedeckelten Privattopf` +
        ` (uncapped) und laufen nie leer — nicht als erschöpft gezählt.`,
    );
  }

  // ---- CSV-Export ----
  if (args.csvPath) {
    writeFileSync(args.csvPath, toCsv(reports, months), "utf8");
    console.log(`\nCSV (Kunde×Monat-Matrix) geschrieben: ${args.csvPath}`);
  }

  // ---- Zusammenfassung ----
  console.log(`\n--- Zusammenfassung ---`);
  console.log(`Geprüfte aktive Kunden:        ${reports.length}`);
  console.log(`  davon statutarisch:          ${statutory.length}`);
  console.log(`  davon Selbstzahler (uncapped): ${selbstzahler.length}`);
  console.log(`Kunden mit ≥1 erschöpftem Monat: ${exhaustedReports.length}`);
  const exhaustedNow = statutory.filter((r) => r.months[0]?.overallExhausted).length;
  console.log(`Kunden bereits diesen Monat leer: ${exhaustedNow}`);
  if (exhaustedReports.length === 0) {
    console.log(`\n✓ Kein aktiver Kunde läuft in den nächsten ${months.length - 1} Monaten leer.`);
  } else {
    console.log(`\n⚠ ${exhaustedReports.length} Kunde(n) erschöpfen Budget im ${months.length}-Monats-Fenster.`);
  }

  return exhaustedReports.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
