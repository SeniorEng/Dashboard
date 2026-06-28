/**
 * Task #1473 — billing-scoped Economics-Reader (Wirtschaftlicher Überblick).
 *
 * EIN Lesepfad, der die bestehende Economics-SSoT
 * (`shared/domain/statistics/economics.ts`, `buildEconomics`) billing-scoped
 * (Monat/Jahr + Mitarbeiter:in + Kasse) aggregiert. Die fachliche Kosten-/
 * Margen-Berechnung wird NICHT re-implementiert: dieser Reader sammelt nur die
 * Mengen je Mitarbeiter und füttert sie pro Mitarbeiter UND als Summe in
 * `buildEconomics`.
 *
 * Itemisierung (Vertrag `shared/api/billing-economics.ts`): produktive
 * Leistungen (Hauswirtschaft, Alltagsbegleitung) + EINE Kilometer-Zeile + EINE
 * Gemeinkosten-Restzeile (nicht-abrechenbarer Overhead zum HW-Satz). Damit gilt
 * Σ(Zeilen) === Headline-KPI exakt, weil Headline und Zeilen aus DEMSELBEN
 * `buildEconomics`-Aufruf stammen.
 *
 * Scope-Semantik:
 *  - `employeeId`   filtert die Termin-Zurechnung (COALESCE(performed, assigned))
 *    und die Zeiterfassung (user_id).
 *  - `insuranceProviderId` filtert die termin-basierten Mengen über die aktive
 *    Kasse des Kunden. Da Overhead (nicht-abrechenbare Zeit) + Zeiterfassungs-km
 *    NICHT einer Kasse zurechenbar sind, werden sie bei gesetztem Kassen-Filter
 *    ausgeschlossen (`includeOverhead = false`).
 *
 * Geldbeträge sind ausnahmslos Integer-Cents.
 */
import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { num } from "../statistics/common";
import {
  buildEconomics,
  marginPercent,
  nonBillableRateCents,
} from "@shared/domain/statistics/economics";
import type {
  EconomicsBreakdown,
  EconomicsInput,
  EconomicsRatesCents,
} from "@shared/statistics";
import type {
  BillingEconomicsResponse,
  BillingEconomicsRow,
  BillingEconomicsEmployeeRow,
  BillingEconomicsUnit,
} from "@shared/api/billing-economics";

/** Nicht-abrechenbare Zeiterfassungs-Typen (SSoT-Spiegel aus economics.ts). */
const NON_BILLABLE_TYPES = ["bueroarbeit", "vertrieb", "sonstiges", "krankheit", "urlaub"] as const;

type Rows = Record<string, unknown>[];

/** Sätze + zusätzlich die HW/AB-Katalog-Erlös-Sätze (für die Anzeige-Spalten). */
interface RatesPlus extends EconomicsRatesCents {
  hauswirtschaftPriceCents: number;
  alltagsbegleitungPriceCents: number;
}

async function resolveRatesPlus(): Promise<RatesPlus> {
  const r = await db.execute(sql`
    SELECT s.code,
      COALESCE(s.employee_rate_cents, 0)::int AS rate_cents,
      COALESCE(s.default_price_cents, 0)::int AS price_cents
    FROM services s
    WHERE s.code IN ('hauswirtschaft','alltagsbegleitung','erstberatung','travel_km','customer_km')
  `);
  const by = new Map<string, { rate: number; price: number }>();
  for (const row of r.rows as Rows) {
    by.set(String(row.code), { rate: num(row.rate_cents), price: num(row.price_cents) });
  }
  const rate = (code: string) => by.get(code)?.rate ?? 0;
  const price = (code: string) => by.get(code)?.price ?? 0;
  return {
    hauswirtschaftRateCents: rate("hauswirtschaft"),
    alltagsbegleitungRateCents: rate("alltagsbegleitung"),
    erstberatungRateCents: rate("erstberatung"),
    travelKmRateCents: rate("travel_km"),
    customerKmRateCents: rate("customer_km"),
    travelKmPriceCents: price("travel_km"),
    customerKmPriceCents: price("customer_km"),
    hauswirtschaftPriceCents: price("hauswirtschaft"),
    alltagsbegleitungPriceCents: price("alltagsbegleitung"),
  };
}

/** Pro-Mitarbeiter gesammelte Mengen, die in `buildEconomics` einfließen. */
interface EmpAgg {
  hwMinutes: number;
  abMinutes: number;
  hwRevenueCents: number;
  abRevenueCents: number;
  travelKm: number;
  customerKm: number;
  timeEntryKm: number;
  nonBillable: Map<string, number>;
}

function emptyAgg(): EmpAgg {
  return {
    hwMinutes: 0,
    abMinutes: 0,
    hwRevenueCents: 0,
    abRevenueCents: 0,
    travelKm: 0,
    customerKm: 0,
    timeEntryKm: 0,
    nonBillable: new Map(),
  };
}

/**
 * Liest den billing-scoped Wirtschaftlichen Überblick für einen Monat.
 *
 * @param billingYear  Abrechnungs-Jahr (z. B. 2026)
 * @param billingMonth Abrechnungs-Monat 1–12
 * @param opts         optionale Filter: Mitarbeiter:in und/oder Pflegekasse
 */
export async function readBillingEconomics(
  billingYear: number,
  billingMonth: number,
  opts: { employeeId?: number; insuranceProviderId?: number } = {},
): Promise<BillingEconomicsResponse> {
  const { employeeId, insuranceProviderId } = opts;
  // Overhead + Zeiterfassungs-km sind nicht kassenspezifisch zurechenbar.
  const includeOverhead = insuranceProviderId === undefined;

  const dApptFilter = sql`AND EXTRACT(YEAR FROM a.date::date) = ${billingYear} AND EXTRACT(MONTH FROM a.date::date) = ${billingMonth}`;
  const empApptFilter = employeeId !== undefined
    ? sql`AND COALESCE(a.performed_by_employee_id, a.assigned_employee_id) = ${employeeId}`
    : sql``;
  const insApptFilter = insuranceProviderId !== undefined
    ? sql`AND a.customer_id IN (
        SELECT cih.customer_id FROM customer_insurance_history cih
        WHERE cih.valid_to IS NULL AND cih.insurance_provider_id = ${insuranceProviderId}
      )`
    : sql``;
  const dTeFilter = sql`AND EXTRACT(YEAR FROM t.entry_date::date) = ${billingYear} AND EXTRACT(MONTH FROM t.entry_date::date) = ${billingMonth}`;
  const empTeFilter = employeeId !== undefined ? sql`AND t.user_id = ${employeeId}` : sql``;

  const rates = await resolveRatesPlus();

  // --- 1) HW/AB-Minuten je Mitarbeiter (appt-Ebene, DISTINCT ON, wie SSoT). ----
  const minutesRes = await db.execute(sql`
    WITH appt_category AS (
      SELECT DISTINCT ON (a.id)
        a.id,
        COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
        a.duration_promised,
        CASE
          WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN s.lohnart_kategorie
          ELSE 'sonstige'
        END AS category
      FROM appointments a
      LEFT JOIN appointment_services asvc ON asvc.appointment_id = a.id
      LEFT JOIN services s ON s.id = asvc.service_id
      WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
        ${dApptFilter} ${empApptFilter} ${insApptFilter}
      ORDER BY a.id,
        CASE WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN 0 ELSE 1 END,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) DESC NULLS LAST
    )
    SELECT employee_id,
      COALESCE(SUM(CASE WHEN category = 'hauswirtschaft' THEN duration_promised END), 0)::int AS hw,
      COALESCE(SUM(CASE WHEN category = 'alltagsbegleitung' THEN duration_promised END), 0)::int AS ab
    FROM appt_category
    WHERE employee_id IS NOT NULL
    GROUP BY employee_id
  `);

  // --- 2) HW/AB-Erlös je Mitarbeiter (Kunden-Preis ODER Katalog, wie SSoT). ----
  const revenueRes = await db.execute(sql`
    WITH appt_rev AS (
      SELECT
        COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
        s.lohnart_kategorie AS cat,
        SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
          COALESCE(
            (SELECT csp.cents FROM prices csp
             WHERE csp.scope = 'customer' AND csp.origin = 'customer_service_prices'
               AND csp.customer_id = a.customer_id AND csp.service_id = s.id
               AND csp.deleted_at IS NULL
               AND csp.valid_from::date <= a.date::date
               AND (csp.valid_to IS NULL OR csp.valid_to::date >= a.date::date)
             ORDER BY csp.valid_from DESC LIMIT 1),
            s.default_price_cents
          )
        ))::bigint AS revenue_cents
      FROM appointments a
      JOIN appointment_services asvc ON asvc.appointment_id = a.id
      JOIN services s ON s.id = asvc.service_id
      WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented') AND s.unit_type = 'hours'
        AND s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung')
        ${dApptFilter} ${empApptFilter} ${insApptFilter}
      GROUP BY COALESCE(a.performed_by_employee_id, a.assigned_employee_id), s.lohnart_kategorie
    )
    SELECT employee_id,
      COALESCE(SUM(CASE WHEN cat = 'hauswirtschaft' THEN revenue_cents END), 0)::bigint AS hw_rev,
      COALESCE(SUM(CASE WHEN cat = 'alltagsbegleitung' THEN revenue_cents END), 0)::bigint AS ab_rev
    FROM appt_rev
    WHERE employee_id IS NOT NULL
    GROUP BY employee_id
  `);

  // --- 3) Termin-km (Anfahrt + Kunden-km) je Mitarbeiter. ---------------------
  const kmRes = await db.execute(sql`
    SELECT COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
      COALESCE(SUM(COALESCE(a.travel_kilometers, 0)), 0)::float8 AS travel_km,
      COALESCE(SUM(COALESCE(a.customer_kilometers, 0)), 0)::float8 AS customer_km
    FROM appointments a
    WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
      AND COALESCE(a.performed_by_employee_id, a.assigned_employee_id) IS NOT NULL
      ${dApptFilter} ${empApptFilter} ${insApptFilter}
    GROUP BY COALESCE(a.performed_by_employee_id, a.assigned_employee_id)
  `);

  // --- 4) Overhead (nicht-abrechenbare Zeit + Zeiterfassungs-km) — nur ohne ----
  //        Kassen-Filter (sonst keiner Kasse zurechenbar).
  let nbRows: Rows = [];
  let teKmRows: Rows = [];
  if (includeOverhead) {
    const nbRes = await db.execute(sql`
      SELECT t.user_id AS employee_id, t.entry_type AS category,
        COALESCE(SUM(t.duration_minutes), 0)::int AS minutes
      FROM employee_time_entries t
      WHERE t.deleted_at IS NULL
        AND t.entry_type IN ('bueroarbeit','vertrieb','sonstiges','krankheit','urlaub')
        ${dTeFilter} ${empTeFilter}
      GROUP BY t.user_id, t.entry_type
    `);
    nbRows = nbRes.rows as Rows;
    const teKmRes = await db.execute(sql`
      SELECT t.user_id AS employee_id, COALESCE(SUM(COALESCE(t.kilometers, 0)), 0)::float8 AS te_km
      FROM employee_time_entries t
      WHERE t.deleted_at IS NULL ${dTeFilter} ${empTeFilter}
      GROUP BY t.user_id
    `);
    teKmRows = teKmRes.rows as Rows;
  }

  // --- Mengen je Mitarbeiter zusammenführen. ----------------------------------
  const byEmp = new Map<number, EmpAgg>();
  const ensure = (id: number): EmpAgg => {
    let e = byEmp.get(id);
    if (!e) {
      e = emptyAgg();
      byEmp.set(id, e);
    }
    return e;
  };

  for (const row of minutesRes.rows as Rows) {
    const id = num(row.employee_id);
    if (!id) continue;
    const e = ensure(id);
    e.hwMinutes += num(row.hw);
    e.abMinutes += num(row.ab);
  }
  for (const row of revenueRes.rows as Rows) {
    const id = num(row.employee_id);
    if (!id) continue;
    const e = ensure(id);
    e.hwRevenueCents += num(row.hw_rev);
    e.abRevenueCents += num(row.ab_rev);
  }
  for (const row of kmRes.rows as Rows) {
    const id = num(row.employee_id);
    if (!id) continue;
    const e = ensure(id);
    e.travelKm += num(row.travel_km);
    e.customerKm += num(row.customer_km);
  }
  for (const row of nbRows) {
    const id = num(row.employee_id);
    if (!id) continue;
    const e = ensure(id);
    const cat = String(row.category);
    e.nonBillable.set(cat, (e.nonBillable.get(cat) ?? 0) + num(row.minutes));
  }
  for (const row of teKmRows) {
    const id = num(row.employee_id);
    if (!id) continue;
    ensure(id).timeEntryKm += num(row.te_km);
  }

  const inputFor = (agg: EmpAgg): EconomicsInput => ({
    rates,
    hauswirtschaftMinutes: agg.hwMinutes,
    alltagsbegleitungMinutes: agg.abMinutes,
    // Erstberatung ist im billing-scoped Überblick keine Karten-/Zeilen-Größe;
    // Gemeinkosten = ausschließlich nicht-abrechenbarer Overhead.
    erstberatungMinutes: 0,
    nonBillable: NON_BILLABLE_TYPES.map((category) => ({
      category,
      minutes: agg.nonBillable.get(category) ?? 0,
    })),
    travelKm: agg.travelKm,
    customerKm: agg.customerKm,
    timeEntryKm: agg.timeEntryKm,
    documentedServiceRevenueCents: agg.hwRevenueCents + agg.abRevenueCents,
  });

  const buildRow = (
    key: string,
    label: string,
    unit: BillingEconomicsUnit,
    quantity: number,
    revenueCents: number,
    costCents: number,
    revenueRateCents: number,
    costRateCents: number,
  ): BillingEconomicsRow => {
    const marginCents = revenueCents - costCents;
    return {
      key,
      label,
      unit,
      quantity,
      revenueCents,
      costCents,
      marginCents,
      marginPercent: marginPercent(revenueCents, marginCents),
      revenueRateCents,
      costRateCents,
    };
  };

  const buildServiceRows = (
    econ: EconomicsBreakdown,
    hwRevenueCents: number,
    abRevenueCents: number,
  ): BillingEconomicsRow[] => {
    const kmQuantity = econ.km.travel.km + econ.km.customer.km + econ.km.timeEntry.km;
    return [
      buildRow(
        "hauswirtschaft",
        "Hauswirtschaft",
        "hours",
        econ.personnel.hauswirtschaft.minutes,
        hwRevenueCents,
        econ.personnel.hauswirtschaft.costCents,
        rates.hauswirtschaftPriceCents,
        rates.hauswirtschaftRateCents,
      ),
      buildRow(
        "alltagsbegleitung",
        "Alltagsbegleitung",
        "hours",
        econ.personnel.alltagsbegleitung.minutes,
        abRevenueCents,
        econ.personnel.alltagsbegleitung.costCents,
        rates.alltagsbegleitungPriceCents,
        rates.alltagsbegleitungRateCents,
      ),
      buildRow(
        "kilometer",
        "Kilometer",
        "km",
        kmQuantity,
        econ.km.totalChargedCents,
        econ.km.totalPaidCents,
        rates.travelKmPriceCents,
        rates.travelKmRateCents,
      ),
      buildRow(
        "gemeinkosten",
        "Gemeinkosten",
        "none",
        0,
        0,
        econ.result.nonBillableCostCents,
        0,
        nonBillableRateCents(rates),
      ),
    ];
  };

  // --- Headline + „Nach Leistung" aus DEM Summen-buildEconomics (Σ === KPI). ---
  const totalAgg = emptyAgg();
  for (const agg of byEmp.values()) {
    totalAgg.hwMinutes += agg.hwMinutes;
    totalAgg.abMinutes += agg.abMinutes;
    totalAgg.hwRevenueCents += agg.hwRevenueCents;
    totalAgg.abRevenueCents += agg.abRevenueCents;
    totalAgg.travelKm += agg.travelKm;
    totalAgg.customerKm += agg.customerKm;
    totalAgg.timeEntryKm += agg.timeEntryKm;
    for (const [cat, m] of agg.nonBillable) {
      totalAgg.nonBillable.set(cat, (totalAgg.nonBillable.get(cat) ?? 0) + m);
    }
  }
  const totalEcon = buildEconomics(inputFor(totalAgg));
  const byService = buildServiceRows(totalEcon, totalAgg.hwRevenueCents, totalAgg.abRevenueCents);

  // --- Mitarbeiter-Namen für die „Nach Mitarbeiter"-Zeilen. -------------------
  const empIds = Array.from(byEmp.keys());
  const names = new Map<number, string>();
  if (empIds.length > 0) {
    const nameRes = await db.execute(sql`
      SELECT id, display_name FROM users
      WHERE id IN (${sql.join(empIds.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const row of nameRes.rows as Rows) {
      names.set(num(row.id), String(row.display_name ?? ""));
    }
  }

  const byEmployee: BillingEconomicsEmployeeRow[] = empIds
    .map((id) => {
      const agg = byEmp.get(id)!;
      const econ = buildEconomics(inputFor(agg));
      return {
        employeeId: id,
        employeeName: names.get(id) ?? "",
        serviceMinutes: agg.hwMinutes + agg.abMinutes,
        km: agg.travelKm + agg.customerKm + agg.timeEntryKm,
        revenueCents: econ.result.revenueCents,
        costCents: econ.result.totalCostCents,
        marginCents: econ.result.marginCents,
        marginPercent: econ.result.marginPercent,
        services: buildServiceRows(econ, agg.hwRevenueCents, agg.abRevenueCents),
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents);

  return {
    billingYear,
    billingMonth,
    totals: {
      revenueCents: totalEcon.result.revenueCents,
      laborCostCents: totalEcon.result.totalCostCents,
      marginCents: totalEcon.result.marginCents,
      marginPercent: totalEcon.result.marginPercent,
    },
    byService,
    byEmployee,
  };
}
