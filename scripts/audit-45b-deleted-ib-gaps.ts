/**
 * Task #642 — Audit: §45b-Allocations, bei denen soft-gelöschte
 * `initial_balance`-Monate vor dem Fix die monatliche Aufstockung blockiert
 * haben.
 *
 * Berechnungsmodell (exakter Pre/Post-Vergleich):
 *   Pro Kunde wird die Allokations-Schleife aus
 *   `calculateAllocated45b` lokal zweimal simuliert — mit demselben Code-
 *   Pfad (Start-Datum-Ableitung, validFrom/validTo-Fenster, latestIbMonth-
 *   Shift, historisierte Monats-Anteile), aber mit unterschiedlichem
 *   `initialBalanceMonths`:
 *     - postFix: nur AKTIVE initial_balance-Allokationen
 *     - preFix : AKTIVE + soft-gelöschte initial_balance-Allokationen
 *   `deltaCents = postFix − preFix`. Die betroffenen Monate sind genau jene,
 *   die im postFix-Lauf aufgestockt werden, aber im preFix-Lauf im
 *   `initialBalanceSet`/Shift gefangen waren.
 *
 *   Damit deckt die Berechnung auch den (subtilen) Fall ab, in dem ein
 *   gelöschter Startwert via `latestIbMonth+1`-Shift komplette FRÜHERE Monate
 *   mit aus der Aufstockung gedrängt hat (z.B. gelöschter März-IB blockt vor
 *   Fix nicht nur März, sondern auch Jan+Feb).
 *
 * Idempotenz:
 *   Pro Kunde wird ein deterministischer `gapSignature` aus der sortierten
 *   Monatsliste + delta-Cents gebildet. Bereits geloggte Einträge mit
 *   identischer Signatur werden übersprungen — ein zweiter `--apply`-Lauf
 *   schreibt KEINE Duplikate.
 *
 * Aufruf:
 *   npx tsx scripts/audit-45b-deleted-ib-gaps.ts                # Dry-Run
 *   npx tsx scripts/audit-45b-deleted-ib-gaps.ts --apply        # Schreibmodus
 *   npx tsx scripts/audit-45b-deleted-ib-gaps.ts --allow-prod   # Prod-Guard
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  auditLog,
  budgetAllocations,
  customerBudgetPreferences,
  customerBudgetTypeSettings,
  customers,
} from "@shared/schema";
import { auditService } from "../server/services/audit";
import { BUDGET_45B_MAX_MONTHLY_CENTS, clampToStatutoryMax } from "@shared/domain/budgets";
import { parseLocalDate } from "@shared/utils/datetime";

function isProdHost(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return /neon\.tech|prod|production/i.test(url) && !/test|dev|staging/i.test(url);
}

type AllocRow = {
  customerId: number;
  budgetType: string;
  source: string;
  year: number;
  month: number | null;
  validFrom: string;
  amountCents: number;
  deletedAt: Date | null;
};

type SettingsRow = {
  customerId: number;
  budgetType: string;
  enabled: boolean;
  monthlyLimitCents: number | null;
  validFrom: string | null;
  validTo: string | null;
};

interface SimulationInput {
  preferences: { budgetStartDate: string | null } | null;
  activeAllocations: AllocRow[]; // §45b only, deletedAt IS NULL
  allIbAllocations: AllocRow[];  // §45b initial_balance, active + deleted
  settings: SettingsRow[];       // §45b only, all historized rows
  asOfDate: string;              // YYYY-MM-DD — Stichtag für Horizont
}

interface SimulationResult {
  totalCents: number;
  iteratedMonths: Set<string>; // "YYYY-MM" iteriert (NICHT im IB-Set)
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthlyAmountFor(settings: SettingsRow[], year: number, month: number): number {
  if (settings.length === 0) return BUDGET_45B_MAX_MONTHLY_CENTS;
  const dateStr = `${year}-${String(month).padStart(2, "0")}-15`;
  const row = settings.find(
    (r) =>
      (r.validFrom == null || r.validFrom <= dateStr) &&
      (r.validTo == null || r.validTo >= dateStr),
  );
  if (!row) return BUDGET_45B_MAX_MONTHLY_CENTS;
  if (row.monthlyLimitCents == null) return BUDGET_45B_MAX_MONTHLY_CENTS;
  const clamped = clampToStatutoryMax({
    budgetType: "entlastungsbetrag_45b",
    monthlyLimitCents: row.monthlyLimitCents,
    yearlyLimitCents: null,
    pflegegrad: null,
  });
  return clamped.monthlyLimitCents ?? BUDGET_45B_MAX_MONTHLY_CENTS;
}

/**
 * Lokale Replik von `calculateAllocated45b`. Parametrisiert über
 * `initialBalanceMonths`, damit pre/post-Fix-Verhalten am selben Code
 * verglichen werden kann. Carryover/IB-Summen werden bewusst NICHT
 * eingerechnet — sie sind identisch in beiden Läufen und kürzen sich aus
 * der Differenz heraus; das hält den Vergleich frei von Drift gegenüber
 * unverwandten Effekten.
 */
function simulateAuto45b(
  input: SimulationInput,
  initialBalanceMonths: Array<{ year: number; month: number }>,
): SimulationResult {
  const asOf = parseLocalDate(input.asOfDate);
  const curYear = asOf.getFullYear();
  const curMonth = asOf.getMonth() + 1;

  let budgetStartDate = input.preferences?.budgetStartDate ?? null;
  if (!budgetStartDate) {
    const ibs = input.activeAllocations.filter((a) => a.source === "initial_balance" && a.validFrom);
    if (ibs.length > 0) {
      budgetStartDate = ibs.reduce((min, a) => (a.validFrom < min.validFrom ? a : min)).validFrom;
    }
  }
  if (!budgetStartDate) {
    const monthly = input.activeAllocations.filter(
      (a) =>
        (a.source === "monthly_auto" || a.source === "monthly" || a.source === "carryover") &&
        a.validFrom,
    );
    if (monthly.length > 0) {
      budgetStartDate = monthly.reduce((min, a) => (a.validFrom < min.validFrom ? a : min)).validFrom;
    }
  }
  if (!budgetStartDate) {
    const s45bEnabled = input.settings.find(
      (s) => s.budgetType === "entlastungsbetrag_45b" && s.enabled && s.validTo == null,
    );
    if (!s45bEnabled) return { totalCents: 0, iteratedMonths: new Set() };
    budgetStartDate = `${curYear}-01-01`;
  }

  const startDate = parseLocalDate(budgetStartDate);
  let allocStartYear = startDate.getFullYear();
  let allocStartMonth = startDate.getMonth() + 1;

  if (initialBalanceMonths.length > 0) {
    let latestIbYear = 0;
    let latestIbMonth = 0;
    for (const ib of initialBalanceMonths) {
      if (ib.year > latestIbYear || (ib.year === latestIbYear && ib.month > latestIbMonth)) {
        latestIbYear = ib.year;
        latestIbMonth = ib.month;
      }
    }
    let afterMonth = latestIbMonth + 1;
    let afterYear = latestIbYear;
    if (afterMonth > 12) {
      afterMonth = 1;
      afterYear++;
    }
    if (
      afterYear > allocStartYear ||
      (afterYear === allocStartYear && afterMonth > allocStartMonth)
    ) {
      allocStartYear = afterYear;
      allocStartMonth = afterMonth;
    }
  }

  const initialBalanceSet = new Set(initialBalanceMonths.map((ib) => `${ib.year}-${ib.month}`));

  const s45bCurrent = input.settings.find(
    (s) => s.budgetType === "entlastungsbetrag_45b" && s.enabled && s.validTo == null,
  );
  if (s45bCurrent?.validFrom) {
    const vfDate = parseLocalDate(s45bCurrent.validFrom);
    const vfYear = vfDate.getFullYear();
    const vfMonth = vfDate.getMonth() + 1;
    if (vfYear > allocStartYear || (vfYear === allocStartYear && vfMonth > allocStartMonth)) {
      allocStartYear = vfYear;
      allocStartMonth = vfMonth;
    }
  }

  let endYear = curYear;
  let endMonth = curMonth;
  if (s45bCurrent?.validTo) {
    const vtDate = parseLocalDate(s45bCurrent.validTo);
    const vtYear = vtDate.getFullYear();
    const vtMonth = vtDate.getMonth() + 1;
    if (vtYear < endYear || (vtYear === endYear && vtMonth < endMonth)) {
      endYear = vtYear;
      endMonth = vtMonth;
    }
  }

  let total = 0;
  const iterated = new Set<string>();
  let y = allocStartYear;
  let m = allocStartMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    const key = `${y}-${m}`;
    if (!initialBalanceSet.has(key)) {
      total += monthlyAmountFor(input.settings, y, m);
      iterated.add(key);
    }
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return { totalCents: total, iteratedMonths: iterated };
}

interface CustomerGap {
  customerId: number;
  customerName: string;
  deltaCents: number;
  affectedMonths: Array<{ year: number; month: number; amountCents: number }>;
  gapSignature: string;
}

function buildSignature(
  affected: Array<{ year: number; month: number }>,
  deltaCents: number,
): string {
  const months = affected
    .map((a) => `${a.year}-${String(a.month).padStart(2, "0")}`)
    .sort()
    .join(",");
  return `v2:months=${months}:delta=${deltaCents}`;
}

async function findGaps(asOfDate: string): Promise<CustomerGap[]> {
  const allCustomers = await db
    .select({ id: customers.id, vorname: customers.vorname, nachname: customers.nachname })
    .from(customers);

  const allAllocs = (await db
    .select({
      customerId: budgetAllocations.customerId,
      budgetType: budgetAllocations.budgetType,
      source: budgetAllocations.source,
      year: budgetAllocations.year,
      month: budgetAllocations.month,
      validFrom: budgetAllocations.validFrom,
      amountCents: budgetAllocations.amountCents,
      deletedAt: budgetAllocations.deletedAt,
    })
    .from(budgetAllocations)
    .where(eq(budgetAllocations.budgetType, "entlastungsbetrag_45b"))
    .orderBy(asc(budgetAllocations.customerId), asc(budgetAllocations.year), asc(budgetAllocations.month))) as AllocRow[];

  const allSettings = (await db
    .select({
      customerId: customerBudgetTypeSettings.customerId,
      budgetType: customerBudgetTypeSettings.budgetType,
      enabled: customerBudgetTypeSettings.enabled,
      monthlyLimitCents: customerBudgetTypeSettings.monthlyLimitCents,
      validFrom: customerBudgetTypeSettings.validFrom,
      validTo: customerBudgetTypeSettings.validTo,
    })
    .from(customerBudgetTypeSettings)
    .where(eq(customerBudgetTypeSettings.budgetType, "entlastungsbetrag_45b"))
    .orderBy(asc(customerBudgetTypeSettings.customerId), asc(customerBudgetTypeSettings.validFrom))) as SettingsRow[];

  const allPrefs = await db
    .select({
      customerId: customerBudgetPreferences.customerId,
      budgetStartDate: customerBudgetPreferences.budgetStartDate,
    })
    .from(customerBudgetPreferences);

  const allocsByCustomer = new Map<number, AllocRow[]>();
  for (const r of allAllocs) {
    const arr = allocsByCustomer.get(r.customerId) ?? [];
    arr.push(r);
    allocsByCustomer.set(r.customerId, arr);
  }
  const settingsByCustomer = new Map<number, SettingsRow[]>();
  for (const r of allSettings) {
    const arr = settingsByCustomer.get(r.customerId) ?? [];
    arr.push(r);
    settingsByCustomer.set(r.customerId, arr);
  }
  const prefsByCustomer = new Map<number, { budgetStartDate: string | null }>();
  for (const r of allPrefs) {
    prefsByCustomer.set(r.customerId, { budgetStartDate: r.budgetStartDate });
  }

  const out: CustomerGap[] = [];
  for (const c of allCustomers) {
    const allocs = allocsByCustomer.get(c.id);
    if (!allocs || allocs.length === 0) continue;

    const ibAll = allocs.filter((a) => a.source === "initial_balance" && a.month != null);
    const ibDeleted = ibAll.filter((a) => a.deletedAt != null);
    if (ibDeleted.length === 0) continue; // ohne gelöschte IBs kein Delta möglich

    const ibActiveMonths = ibAll
      .filter((a) => a.deletedAt == null)
      .map((a) => ({ year: a.year, month: a.month! }));
    const ibAllMonths = ibAll.map((a) => ({ year: a.year, month: a.month! }));

    const input: SimulationInput = {
      preferences: prefsByCustomer.get(c.id) ?? null,
      activeAllocations: allocs.filter((a) => a.deletedAt == null),
      allIbAllocations: ibAll,
      settings: settingsByCustomer.get(c.id) ?? [],
      asOfDate,
    };

    const post = simulateAuto45b(input, ibActiveMonths);
    const pre = simulateAuto45b(input, ibAllMonths);
    const deltaCents = post.totalCents - pre.totalCents;
    if (deltaCents <= 0) continue;

    // Affected months = post hat sie aufgestockt, pre nicht
    const affected: Array<{ year: number; month: number; amountCents: number }> = [];
    for (const key of post.iteratedMonths) {
      if (pre.iteratedMonths.has(key)) continue;
      const [yStr, mStr] = key.split("-");
      const y = parseInt(yStr, 10);
      const m = parseInt(mStr, 10);
      affected.push({ year: y, month: m, amountCents: monthlyAmountFor(input.settings, y, m) });
    }
    affected.sort((a, b) => a.year - b.year || a.month - b.month);

    out.push({
      customerId: c.id,
      customerName: `${c.vorname ?? ""} ${c.nachname ?? ""}`.trim() || `#${c.id}`,
      deltaCents,
      affectedMonths: affected,
      gapSignature: buildSignature(affected, deltaCents),
    });
  }
  return out;
}

async function getAlreadyLoggedSignatures(customerIds: number[]): Promise<Map<number, Set<string>>> {
  if (customerIds.length === 0) return new Map();
  const rows = await db
    .select({ entityId: auditLog.entityId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, "budget_45b_gap_corrected"),
      eq(auditLog.entityType, "budget"),
      sql`${auditLog.entityId} = ANY(${customerIds})`,
    ));
  const out = new Map<number, Set<string>>();
  for (const r of rows) {
    const sig = (r.metadata as { gapSignature?: unknown } | null)?.gapSignature;
    if (typeof sig !== "string") continue;
    const set = out.get(r.entityId) ?? new Set<string>();
    set.add(sig);
    out.set(r.entityId, set);
  }
  return out;
}

async function getAuditUserId(): Promise<number | null> {
  const rows = await db.execute(
    /* sql */ `SELECT id FROM users WHERE role IN ('superadmin','admin') ORDER BY id ASC LIMIT 1`,
  );
  const r = (rows as { rows: Array<{ id: number }> }).rows;
  return r[0]?.id ?? null;
}

function formatMonths(affected: Array<{ year: number; month: number; amountCents: number }>): string {
  if (affected.length === 0) return "—";
  if (affected.length <= 6) {
    return affected
      .map((a) => `${a.year}-${String(a.month).padStart(2, "0")}(${(a.amountCents / 100).toFixed(2)}€)`)
      .join(", ");
  }
  const head = affected.slice(0, 4).map((a) => `${a.year}-${String(a.month).padStart(2, "0")}`).join(", ");
  const tail = affected.slice(-2).map((a) => `${a.year}-${String(a.month).padStart(2, "0")}`).join(", ");
  return `${head} … ${tail}  (${affected.length} Monate)`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const allowProd = process.argv.includes("--allow-prod");
  if (isProdHost() && !allowProd) {
    console.error(
      "REFUSE: DATABASE_URL sieht nach Produktion aus. Mit --allow-prod erneut aufrufen.",
    );
    process.exit(2);
  }

  const asOfDate = todayISO();
  const mode = apply ? "APPLY (scharf, schreibt Audit-Log)" : "DRY-RUN (Default)";
  console.log(`\n=== §45b Deleted-IB-Gap Audit (${mode}, asOf=${asOfDate}) ===\n`);

  const gaps = await findGaps(asOfDate);
  if (gaps.length === 0) {
    console.log("Keine §45b-Kunden mit Auto-Renewal-Lücke gefunden (exakter pre/post-Vergleich).");
    return;
  }

  const alreadyLogged = await getAlreadyLoggedSignatures(gaps.map((g) => g.customerId));

  let totalCents = 0;
  let pending = 0;
  for (const g of gaps) {
    const isDup = alreadyLogged.get(g.customerId)?.has(g.gapSignature) ?? false;
    const status = isDup ? "bereits" : "offen";
    if (!isDup) {
      totalCents += g.deltaCents;
      pending++;
    }
    console.log(
      `[#${String(g.customerId).padStart(6)}] ${g.customerName.padEnd(28).slice(0, 28)}  ` +
      `Δ ${(g.deltaCents / 100).toFixed(2).padStart(8)} €  ${status.padEnd(8)}  ` +
      `Monate: ${formatMonths(g.affectedMonths)}`,
    );
  }
  console.log("─".repeat(110));
  console.log(
    `\nKunden gesamt: ${gaps.length}   neu zu loggen: ${pending}   ` +
    `Summe Δ (neu): ${(totalCents / 100).toFixed(2)} €\n`,
  );

  if (!apply) {
    console.log("Hinweis: --apply schreibt pro 'offenem' Kunden einen budget_45b_gap_corrected-Audit-Eintrag.");
    console.log("        KEIN Schreibzugriff auf budget_allocations — die Korrektur ist virtuell und greift");
    console.log("        beim nächsten Aufruf von calculateAllocatedCents automatisch.");
    console.log("        Bereits geloggte Kunden (identische gapSignature) werden übersprungen.");
    return;
  }
  if (pending === 0) {
    console.log("Alle Lücken bereits geloggt — keine neuen Audit-Einträge nötig (idempotent).");
    return;
  }
  const userId = await getAuditUserId();
  if (userId == null) {
    console.error("Kein admin/superadmin-User für Audit-Akteur gefunden — Abbruch.");
    process.exit(3);
  }
  let written = 0;
  for (const g of gaps) {
    if (alreadyLogged.get(g.customerId)?.has(g.gapSignature)) continue;
    await auditService.log(userId, "budget_45b_gap_corrected", "budget", g.customerId, {
      customerId: g.customerId,
      customerName: g.customerName,
      affectedMonths: g.affectedMonths,
      deltaCents: g.deltaCents,
      gapSignature: g.gapSignature,
      asOfDate,
      reason: "Task #642: soft-gelöschte initial_balance-Monate blockieren das Auto-Renewal nicht mehr",
      task: 642,
    });
    written++;
  }
  console.log(`✓ Audit-Einträge geschrieben für ${written} Kunde(n) (${gaps.length - written} bereits geloggt).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit fehlgeschlagen:", err);
    process.exit(3);
  });
