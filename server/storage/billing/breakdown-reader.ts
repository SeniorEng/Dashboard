/**
 * Task #1453 — Abrechnungs-Breakdown-Reader (Phase 1, READ-ONLY).
 *
 * Liefert die Leistungsart-Aufschlüsselung eines Abrechnungs-Monats. Er
 * SPIEGELT EXAKT die Hybrid-Bruchkante des Pipeline-Readers
 * (`pipeline-reader.ts`): solange ein Termin NICHT abgerechnet ist, lebt sein €
 * (und seine Stunden) auf der Termin-Karte (frühe Stufen); sobald er über eine
 * nicht-stornierte Rechnung abgerechnet ist, verlässt er die Termin-Stufen
 * (`excluded: invoiced`) und seine Stunden kommen aus
 * `invoice_line_items.duration_minutes` (späte Stufen). So wird jede Stunde und
 * jeder € genau einmal gezählt (FIX des 0,0h-Bugs ohne Doppelzählung).
 *
 * Die fachliche Klassifikation/Aggregation lebt vollständig in
 * `shared/domain/billing-breakdown.ts`; dieser Reader ist nur der Lesepfad.
 */
import { sql, inArray } from "drizzle-orm";
import { db } from "../../lib/db";
import { num } from "../statistics/common";
import { documentedAndSignedSqlRaw } from "../../lib/appointment-signed";
import { getInvoices } from "../billing-storage";
import { invoiceLineItems } from "@shared/schema";
import {
  aggregateBreakdownUnits,
  assignAppointmentStage,
  assignInvoiceStage,
  computeMinutesByInvoiceStage,
  emptyCategoryBreakdown,
  type BreakdownSourceUnit,
  type CategoryBreakdown,
  type InvoiceLineMinutesInput,
} from "@shared/domain/billing-breakdown";
import type { AppointmentStatus } from "@shared/domain/appointments";
import type { BillingBreakdownResponse } from "@shared/api/billing-breakdown";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Liest die Breakdown-Tabelle (vor-aggregiert pro Kunde × Abrechnungstyp) für
 * einen Abrechnungs-Monat.
 */
export async function readBillingBreakdown(
  billingYear: number,
  billingMonth: number,
): Promise<BillingBreakdownResponse> {
  const periodStart = `${billingYear}-${pad2(billingMonth)}-01`;
  const lastDay = new Date(billingYear, billingMonth, 0).getDate();
  const periodEnd = `${billingYear}-${pad2(billingMonth)}-${pad2(lastDay)}`;

  const sources: BreakdownSourceUnit[] = [];

  // --- 1) Termine (frühe Stufen, VOR Topf-Split) ------------------------------
  // Pro-Termin-Umsatz mit IDENTISCHER Formel wie der Pipeline-Reader; zusätzlich
  // die Stunden je Leistungsart (Hauswirtschaft/Alltagsbegleitung) aus
  // `services.lohnart_kategorie`. km bleibt für Termin-Stufen 0 — Kilometer
  // erscheinen erst auf der Rechnung als eigene Line-Items.
  const apptRows = await db.execute(sql`
    WITH appt_agg AS (
      SELECT a.id, a.customer_id,
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
        ))::bigint AS revenue_cents,
        COALESCE(SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes))
          FILTER (WHERE s.lohnart_kategorie = 'hauswirtschaft'), 0) AS hw_minutes,
        COALESCE(SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes))
          FILTER (WHERE s.lohnart_kategorie = 'alltagsbegleitung'), 0) AS ab_minutes
      FROM appointments a
      JOIN appointment_services asvc ON asvc.appointment_id = a.id
      JOIN services s ON s.id = asvc.service_id
      WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
        AND a.date::date >= ${periodStart} AND a.date::date <= ${periodEnd}
      GROUP BY a.id, a.customer_id
    )
    SELECT ag.id, ag.customer_id AS customer_id, ag.revenue_cents,
      ag.hw_minutes, ag.ab_minutes,
      a.status AS status,
      c.name AS customer_name,
      c.billing_type AS billing_type,
      ${documentedAndSignedSqlRaw("a")} AS documented_and_signed,
      EXISTS (
        SELECT 1 FROM invoice_line_items li
        JOIN invoices i ON i.id = li.invoice_id
        WHERE li.appointment_id = a.id
          AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
      ) AS is_invoiced
    FROM appt_agg ag
    JOIN appointments a ON a.id = ag.id
    JOIN customers c ON c.id = ag.customer_id
  `);

  for (const raw of apptRows.rows as Record<string, unknown>[]) {
    const status = String(raw.status) as AppointmentStatus;
    const assignment = assignAppointmentStage({
      status,
      documentedAndSigned: raw.documented_and_signed === true,
      isInvoiced: raw.is_invoiced === true,
    });
    const category: CategoryBreakdown = emptyCategoryBreakdown();
    category.hauswirtschaftMinutes = num(raw.hw_minutes);
    category.alltagsbegleitungMinutes = num(raw.ab_minutes);
    sources.push({
      assignment,
      customerId: num(raw.customer_id),
      customerName: String(raw.customer_name ?? ""),
      billingType: String(raw.billing_type ?? ""),
      cents: num(raw.revenue_cents),
      category,
    });
  }

  // --- 2) Rechnungen (späte Stufen, NACH Topf-Split) --------------------------
  // Stunden/km der späten Stufen kommen aus den persistierten Line-Items —
  // genau das behebt den 0,0h-Bug (abgerechnete Termine fallen oben unter
  // `excluded: invoiced` und tragen dort keine Stunden mehr bei).
  const invoices = await getInvoices({ year: billingYear, month: billingMonth });
  const invoiceIds = invoices.map((inv) => inv.id);

  const lineRows = invoiceIds.length
    ? await db
        .select({
          invoiceId: invoiceLineItems.invoiceId,
          serviceCode: invoiceLineItems.serviceCode,
          durationMinutes: invoiceLineItems.durationMinutes,
          quantityRaw: invoiceLineItems.quantityRaw,
        })
        .from(invoiceLineItems)
        .where(inArray(invoiceLineItems.invoiceId, invoiceIds))
    : [];

  const linesByInvoice = new Map<number, InvoiceLineMinutesInput[]>();
  for (const li of lineRows) {
    const list = linesByInvoice.get(li.invoiceId) ?? [];
    list.push({
      serviceCode: li.serviceCode,
      durationMinutes: li.durationMinutes,
      quantityRaw: li.quantityRaw,
    });
    linesByInvoice.set(li.invoiceId, list);
  }

  for (const inv of invoices) {
    const assignment = assignInvoiceStage({ status: inv.status, invoiceType: inv.invoiceType });
    const category = computeMinutesByInvoiceStage(linesByInvoice.get(inv.id) ?? []);
    sources.push({
      assignment,
      customerId: inv.customerId,
      customerName: inv.customerName ?? "",
      billingType: inv.billingType,
      cents: inv.netAmountCents ?? 0,
      category,
    });
  }

  // --- 3) Aggregation (nur Stufen-Einheiten) ----------------------------------
  return {
    billingYear,
    billingMonth,
    units: aggregateBreakdownUnits(sources),
  };
}
