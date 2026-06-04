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
import { readUnifiedBudgetAvailability } from "../storage/budget/unified-reader";
import { todayISO, currentYearAndMonth, lastDayOfMonth } from "@shared/utils/datetime";
import {
  euro,
  buildMonthEval,
  buildCustomerReport,
  classifyKind,
  potCell,
  toCsv,
  type MonthSlot,
  type CustomerReport,
  type CustomerReportBase,
} from "./report-budget-exposure-core";

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

async function evaluateCustomer(
  cust: { id: number; name: string; billingType: string; acceptsPrivatePayment: boolean },
  months: MonthSlot[],
): Promise<CustomerReport> {
  const base: CustomerReportBase = {
    id: cust.id,
    name: cust.name,
    billingType: cust.billingType,
    acceptsPrivatePayment: cust.acceptsPrivatePayment,
    kind: classifyKind(cust.billingType),
  };

  // Selbstzahler routen in den ungedeckelten Privattopf → laufen nie leer.
  if (base.kind === "selbstzahler") {
    return buildCustomerReport(base, []);
  }

  const monthEvals = [];
  for (const slot of months) {
    const u = await readUnifiedBudgetAvailability(cust.id, slot.asOfDate);
    monthEvals.push(buildMonthEval(slot, u));
  }

  return buildCustomerReport(base, monthEvals);
}

// Klassifizierungs-/CSV-Logik lebt in `report-budget-exposure-core.ts`.

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
