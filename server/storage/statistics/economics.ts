import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import type {
  EconomicsBreakdown,
  EconomicsNonBillableDrillRow,
  EconomicsRatesCents,
  RevenueStageHours,
} from "@shared/statistics";
import { buildEconomics, costForMinutes, nonBillableRateCents } from "@shared/domain/statistics/economics";
import { getEntryTypeLabel } from "@shared/domain/time-entries";
import { billingPeriodFilter, dateFilter, num, type ResolvedPeriod } from "./common";

/** Nicht-abrechenbare Zeiterfassungs-Typen (Task #1355). */
const NON_BILLABLE_TYPES = ["bueroarbeit", "vertrieb", "sonstiges", "krankheit", "urlaub"] as const;

async function resolveRates(): Promise<EconomicsRatesCents> {
  const r = await db.execute(sql`
    SELECT s.code,
      COALESCE(s.employee_rate_cents, 0)::int AS rate_cents,
      COALESCE(s.default_price_cents, 0)::int AS price_cents
    FROM services s
    WHERE s.code IN ('hauswirtschaft','alltagsbegleitung','erstberatung','travel_km','customer_km')
  `);
  const by = new Map<string, { rate: number; price: number }>();
  for (const row of r.rows as Record<string, unknown>[]) {
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
  };
}

/** Minuten je Leistungskategorie (HW/AB/Erstberatung) aus dokumentierten Terminen. */
async function categoryMinutes(p: ResolvedPeriod) {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const r = await db.execute(sql`
    WITH appt_category AS (
      SELECT DISTINCT ON (a.id)
        a.id,
        a.duration_promised,
        CASE
          WHEN a.appointment_type = 'Erstberatung' THEN 'erstberatung'
          WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN s.lohnart_kategorie
          ELSE 'sonstige'
        END AS category
      FROM appointments a
      LEFT JOIN appointment_services asvc ON asvc.appointment_id = a.id
      LEFT JOIN services s ON s.id = asvc.service_id
      WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
        ${dFilter}
      ORDER BY a.id,
        CASE WHEN s.lohnart_kategorie IN ('hauswirtschaft','alltagsbegleitung') THEN 0 ELSE 1 END,
        COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes, 0) DESC NULLS LAST
    )
    SELECT
      COALESCE(SUM(CASE WHEN category = 'hauswirtschaft' THEN duration_promised END), 0)::int AS hw,
      COALESCE(SUM(CASE WHEN category = 'alltagsbegleitung' THEN duration_promised END), 0)::int AS ab,
      COALESCE(SUM(CASE WHEN category = 'erstberatung' THEN duration_promised END), 0)::int AS eb
    FROM appt_category
  `);
  const row = r.rows[0] as Record<string, unknown>;
  return { hw: num(row.hw), ab: num(row.ab), eb: num(row.eb) };
}

/** Nicht-abrechenbare Minuten je Zeiterfassungs-Kategorie. */
async function nonBillableMinutes(p: ResolvedPeriod) {
  const tFilter = dateFilter(p, sql`t.entry_date::date`);
  const r = await db.execute(sql`
    SELECT t.entry_type AS category, COALESCE(SUM(t.duration_minutes), 0)::int AS minutes
    FROM employee_time_entries t
    WHERE t.deleted_at IS NULL
      AND t.entry_type IN ('bueroarbeit','vertrieb','sonstiges','krankheit','urlaub')
      ${tFilter}
    GROUP BY t.entry_type
  `);
  const found = new Map<string, number>();
  for (const row of r.rows as Record<string, unknown>[]) {
    found.set(String(row.category), num(row.minutes));
  }
  // Stabile Reihenfolge + alle Kategorien (auch 0) für eine vollständige Anzeige.
  return NON_BILLABLE_TYPES.map((category) => ({ category, minutes: found.get(category) ?? 0 }));
}

/** km-Summen: Termin-Anfahrt/Kunden-km + Mitarbeiter-km aus Zeiterfassung. */
async function kmSums(p: ResolvedPeriod) {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const tFilter = dateFilter(p, sql`t.entry_date::date`);
  const appt = await db.execute(sql`
    SELECT
      COALESCE(SUM(COALESCE(a.travel_kilometers, 0)), 0)::float8 AS travel_km,
      COALESCE(SUM(COALESCE(a.customer_kilometers, 0)), 0)::float8 AS customer_km
    FROM appointments a
    WHERE a.deleted_at IS NULL AND a.status IN ('completed','documented')
      ${dFilter}
  `);
  const te = await db.execute(sql`
    SELECT COALESCE(SUM(COALESCE(t.kilometers, 0)), 0)::float8 AS te_km
    FROM employee_time_entries t
    WHERE t.deleted_at IS NULL ${tFilter}
  `);
  const ar = appt.rows[0] as Record<string, unknown>;
  const tr = te.rows[0] as Record<string, unknown>;
  return { travelKm: num(ar.travel_km), customerKm: num(ar.customer_km), timeEntryKm: num(tr.te_km) };
}

/** Dokumentierter Service-Erlös (Stunden-Leistungen, ohne km). */
async function documentedServiceRevenue(p: ResolvedPeriod): Promise<number> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const r = await db.execute(sql`
    WITH per_appt AS (
      SELECT SUM(ROUND(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes) / 60.0 *
        COALESCE(
          (SELECT csp.cents FROM prices csp
           WHERE csp.scope = 'customer' AND csp.origin = 'customer_service_prices' AND csp.customer_id = a.customer_id AND csp.service_id = s.id
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
        ${dFilter}
      GROUP BY a.id
    )
    SELECT COALESCE(SUM(revenue_cents), 0)::bigint AS revenue FROM per_appt
  `);
  return num((r.rows[0] as Record<string, unknown>).revenue);
}

/** Erlös-Trichter in Minuten (Geplant/Dokumentiert/Nachgewiesen/Berechnet). */
async function stageHours(p: ResolvedPeriod): Promise<RevenueStageHours> {
  const dFilter = dateFilter(p, sql`a.date::date`);
  const invFilter = billingPeriodFilter(p, sql`i.billing_year`, sql`i.billing_month`);
  const r = await db.execute(sql`
    WITH appt AS (
      SELECT a.id, a.status, a.duration_promised AS minutes
      FROM appointments a
      WHERE a.deleted_at IS NULL ${dFilter}
        AND EXISTS (
          SELECT 1 FROM appointment_services asvc JOIN services s ON s.id = asvc.service_id
          WHERE asvc.appointment_id = a.id AND s.unit_type = 'hours'
        )
    )
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('scheduled','completed','documented') THEN minutes END), 0)::int AS planned,
      COALESCE(SUM(CASE WHEN status IN ('completed','documented') THEN minutes END), 0)::int AS documented,
      COALESCE(SUM(CASE WHEN status IN ('completed','documented') AND id IN (
        SELECT sra.appointment_id FROM service_record_appointments sra
        JOIN monthly_service_records msr ON msr.id = sra.service_record_id
        WHERE msr.deleted_at IS NULL AND msr.status = 'completed'
      ) THEN minutes END), 0)::int AS proven
    FROM appt
  `);
  const inv = await db.execute(sql`
    SELECT COALESCE(SUM(a.duration_promised), 0)::int AS invoiced
    FROM appointments a
    WHERE a.deleted_at IS NULL AND a.id IN (
      SELECT DISTINCT li.appointment_id
      FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
      WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
        AND li.appointment_id IS NOT NULL ${invFilter}
    )
  `);
  const row = r.rows[0] as Record<string, unknown>;
  const irow = inv.rows[0] as Record<string, unknown>;
  return {
    plannedMinutes: num(row.planned),
    documentedMinutes: num(row.documented),
    provenMinutes: num(row.proven),
    invoicedMinutes: num(irow.invoiced),
  };
}

export async function getEconomics(
  period: ResolvedPeriod,
): Promise<{ economics: EconomicsBreakdown; stageHours: RevenueStageHours }> {
  const [rates, cats, nonBillable, km, docRevenue, hours] = await Promise.all([
    resolveRates(),
    categoryMinutes(period),
    nonBillableMinutes(period),
    kmSums(period),
    documentedServiceRevenue(period),
    stageHours(period),
  ]);

  const economics = buildEconomics({
    rates,
    hauswirtschaftMinutes: cats.hw,
    alltagsbegleitungMinutes: cats.ab,
    erstberatungMinutes: cats.eb,
    nonBillable,
    travelKm: km.travelKm,
    customerKm: km.customerKm,
    timeEntryKm: km.timeEntryKm,
    documentedServiceRevenueCents: docRevenue,
  });

  return { economics, stageHours: hours };
}

/** Drill-down: nicht-abrechenbare Stunden je Mitarbeiter + Kategorie (CSV-Export). */
export async function listNonBillableHours(
  period: ResolvedPeriod,
): Promise<EconomicsNonBillableDrillRow[]> {
  const tFilter = dateFilter(period, sql`t.entry_date::date`);
  const rates = await resolveRates();
  const nbRate = nonBillableRateCents(rates);
  const r = await db.execute(sql`
    SELECT t.user_id AS employee_id, u.display_name AS employee_name,
      t.entry_type AS category, COALESCE(SUM(t.duration_minutes), 0)::int AS minutes
    FROM employee_time_entries t
    JOIN users u ON u.id = t.user_id
    WHERE t.deleted_at IS NULL
      AND t.entry_type IN ('bueroarbeit','vertrieb','sonstiges','krankheit','urlaub')
      ${tFilter}
    GROUP BY t.user_id, u.display_name, t.entry_type
    HAVING COALESCE(SUM(t.duration_minutes), 0) > 0
    ORDER BY minutes DESC
  `);
  return (r.rows as Record<string, unknown>[]).map((row) => {
    const category = String(row.category);
    const minutes = num(row.minutes);
    return {
      employeeId: num(row.employee_id),
      employeeName: String(row.employee_name ?? ""),
      category,
      categoryLabel: getEntryTypeLabel(category),
      minutes,
      costCents: costForMinutes(minutes, nbRate),
    };
  });
}
