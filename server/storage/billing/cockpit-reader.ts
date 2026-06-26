/**
 * Task #1444 — Abrechnung-Cockpit (Phase 1): READ-ONLY-Reader.
 * Task #1450 — Performance: Trichter sofort, Drill-down lazy.
 *
 * Zwei Lesepfade, die das Cockpit-Read-Model für einen Abrechnungs-Monat
 * liefern. Beide KOMPONIEREN bestehende SSoTs, statt sie zu duplizieren:
 *  - Termin-Umsatz: dieselbe `prices`-/`unit_type='hours'`-Formel wie der
 *    Pipeline-Reader / die Umsatz-Statistik (€-Konservierung).
 *  - „dokumentiert & unterschrieben": `documentedAndSignedSqlRaw`.
 *  - Stufen-/Aging-Zuordnung: die reinen Funktionen aus
 *    `shared/domain/billing-pipeline.ts`, danach gröber auf 5 Trichter-Stufen
 *    abgebildet (`mapPipelineStageToFunnel`).
 *  - Lohn-Readiness + „Überfällige Doku": `getAdminMonthClosingReadiness`.
 *  - „LN-Prüfung": `documentStorage.getPendingReviewProofs`.
 *
 * `readBillingCockpit` liefert NUR die billigen Aggregate (Trichter + Buckets):
 * die Termin-Stufen werden per SQL-`GROUP BY` (COUNT/SUM) verdichtet, statt erst
 * tausende Drill-Zeilen in den App-Prozess zu laden. Die einzelnen Drill-Zeilen
 * einer Stufe holt `readBillingCockpitDrill` erst auf Anfrage, paginiert.
 *
 * Geldbasis: NETTO (Integer-Cents), identisch zum Pipeline-Reader, damit der
 * Trichter exakt der gemappten Pipeline entspricht. Keine Mutationen.
 */
import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { num } from "../statistics/common";
import { documentedAndSignedSqlRaw } from "../../lib/appointment-signed";
import { getInvoices } from "../billing-storage";
import { getAdminMonthClosingReadiness } from "../time-tracking/month-closing";
import { documentStorage } from "../documents";
import {
  agingModelForBillingType,
  assignAppointmentStage,
  assignInvoiceStage,
  resolveAgingBucket,
  type AgingBucket,
} from "@shared/domain/billing-pipeline";
import {
  mapPipelineStageToFunnel,
  summarizeCockpitFunnelContributions,
  summarizeLohnReadiness,
  resolveCockpitAmpel,
  isDocumentationOverdue48h,
  type CockpitStageContribution,
  type CockpitDrillRow,
  type CockpitFunnelStage,
} from "@shared/domain/billing-cockpit";
import { daysOverdue } from "@shared/domain/appointments";
import type { AppointmentStatus } from "@shared/domain/appointments";
import type {
  BillingCockpitResponse,
  CockpitDrillResponse,
  CockpitOverdueDocItem,
  CockpitProofReviewItem,
  CockpitBillingReviewItem,
  CockpitOverdueInvoiceItem,
} from "@shared/api/billing-cockpit";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface MonthPeriod {
  periodStart: string;
  periodEnd: string;
}

function monthPeriod(billingYear: number, billingMonth: number): MonthPeriod {
  const periodStart = `${billingYear}-${pad2(billingMonth)}-01`;
  const lastDay = new Date(billingYear, billingMonth, 0).getDate();
  const periodEnd = `${billingYear}-${pad2(billingMonth)}-${pad2(lastDay)}`;
  return { periodStart, periodEnd };
}

// Aus welcher Quelle eine Trichter-Stufe gespeist wird — ABGELEITET aus der
// SSoT-Abbildung `mapPipelineStageToFunnel`, nicht hartcodiert: Termin-Stufen
// (offen/dokumentiert/unterschrieben) → frühe Trichter-Stufen, Rechnungs-Stufen
// → späte Trichter-Stufen. So bleibt die Drill-Quelle automatisch korrekt,
// falls sich das Mapping je ändert.
const APPOINTMENT_FUNNEL_STAGES = new Set<CockpitFunnelStage>(
  (["offen", "dokumentiert", "unterschrieben"] as const).map(mapPipelineStageToFunnel),
);

/**
 * Liest die Cockpit-ÜBERSICHT für einen Abrechnungs-Monat (READ-ONLY): Trichter
 * (5 Zahlen), Lohn-Readiness, Ampel und die vier „Zu prüfen"-Buckets. Liefert
 * KEINE Drill-Zeilen mehr (→ `readBillingCockpitDrill`).
 *
 * @param billingYear  Abrechnungs-Jahr (z. B. 2026)
 * @param billingMonth Abrechnungs-Monat 1–12
 * @param asOfDate     Stichtag für Aging/Überfälligkeit (ISO yyyy-mm-dd)
 */
export async function readBillingCockpit(
  billingYear: number,
  billingMonth: number,
  asOfDate: string,
): Promise<BillingCockpitResponse> {
  const { periodStart, periodEnd } = monthPeriod(billingYear, billingMonth);
  const asOfLocal = new Date(`${asOfDate}T00:00:00`);

  const contributions: CockpitStageContribution[] = [];

  // --- 1) Termine (frühe Trichter-Stufen) — per SQL-GROUP BY verdichtet -------
  // Pro-Termin-Umsatz + Minuten mit IDENTISCHER Formel wie der Pipeline-Reader,
  // danach serverseitig nach (Kunde × Roh-Signal) gruppiert. Die eigentliche
  // Stufen-Zuordnung bleibt die SSoT `assignAppointmentStage` in JS — die SQL-
  // Gruppierung verdichtet nur die €/Minuten/Counts, sie klassifiziert NICHT.
  const apptAgg = await db.execute(sql`
    WITH appt AS (
      SELECT a.id AS appt_id, a.customer_id, c.name AS customer_name, a.status,
        SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes))::bigint AS minutes_total,
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
        ${documentedAndSignedSqlRaw("a")} AS documented_and_signed,
        EXISTS (
          SELECT 1 FROM invoice_line_items li
          JOIN invoices i ON i.id = li.invoice_id
          WHERE li.appointment_id = a.id
            AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
        ) AS is_invoiced
      FROM appointments a
      JOIN appointment_services asvc ON asvc.appointment_id = a.id
      JOIN services s ON s.id = asvc.service_id
      JOIN customers c ON c.id = a.customer_id
      WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
        AND a.date::date >= ${periodStart} AND a.date::date <= ${periodEnd}
      GROUP BY a.id, a.customer_id, c.name, a.status
    )
    SELECT customer_id, customer_name, status, documented_and_signed, is_invoiced,
      COUNT(*)::int AS item_count,
      SUM(revenue_cents)::bigint AS cents,
      SUM(minutes_total)::bigint AS minutes
    FROM appt
    GROUP BY customer_id, customer_name, status, documented_and_signed, is_invoiced
  `);

  // „Abrechnungs-Prüfung"-Bucket = die Leistungsnachweis-Trichter-Stufe
  // (unterschrieben, noch nicht abgerechnet), pro Kunde gebündelt.
  const abrechnungsByCustomer = new Map<number, CockpitBillingReviewItem>();

  for (const raw of apptAgg.rows as Record<string, unknown>[]) {
    const status = String(raw.status) as AppointmentStatus;
    const assignment = assignAppointmentStage({
      status,
      documentedAndSigned: raw.documented_and_signed === true,
      isInvoiced: raw.is_invoiced === true,
    });
    // Nur Stufen-Einheiten erscheinen im Trichter; Side/Excluded (Storno,
    // No-Show, abgelaufen, bereits abgerechnet) werden ausgelassen — identisch
    // zur Pipeline.
    if (assignment.kind !== "stage") continue;
    const stage = mapPipelineStageToFunnel(assignment.stage);
    const itemCount = num(raw.item_count);
    const cents = num(raw.cents);
    const minutes = num(raw.minutes);
    contributions.push({ stage, itemCount, totalMinutes: minutes, totalCents: cents });

    if (stage === "leistungsnachweis") {
      const customerId = num(raw.customer_id);
      let entry = abrechnungsByCustomer.get(customerId);
      if (!entry) {
        entry = {
          customerId,
          customerName: String(raw.customer_name ?? ""),
          itemCount: 0,
          totalCents: 0,
        };
        abrechnungsByCustomer.set(customerId, entry);
      }
      entry.itemCount += itemCount;
      entry.totalCents += cents;
    }
  }

  // --- 2) Rechnungen (späte Trichter-Stufen) ---------------------------------
  const zahlungsverzug: CockpitOverdueInvoiceItem[] = [];
  const invoices = await getInvoices({ year: billingYear, month: billingMonth });
  for (const inv of invoices) {
    const assignment = assignInvoiceStage({ status: inv.status, invoiceType: inv.invoiceType });
    if (assignment.kind !== "stage") continue;
    const stage = mapPipelineStageToFunnel(assignment.stage);
    const cents = inv.netAmountCents ?? 0;
    contributions.push({ stage, itemCount: 1, totalMinutes: 0, totalCents: cents });

    // Aging nur in den versendet-/avis-Stufen sinnvoll (Zahlungs-/Avis-Lauf).
    if (assignment.stage === "versendet" || assignment.stage === "avis_erhalten") {
      const model = agingModelForBillingType(inv.billingType);
      const anchorIso =
        model === "selbstzahler"
          ? inv.dueDate ?? null
          : inv.sentAt
            ? new Date(inv.sentAt).toISOString().slice(0, 10)
            : null;
      const aging = resolveAgingBucket(model, anchorIso, asOfDate);
      if (aging === "red") {
        zahlungsverzug.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          customerId: inv.customerId,
          customerName: inv.customerName ?? "",
          billingType: inv.billingType,
          totalCents: cents,
        });
      }
    }
  }

  // --- 3) Trichter ------------------------------------------------------------
  const funnel = summarizeCockpitFunnelContributions(contributions);

  // --- 4) Lohn-Readiness + „Überfällige Doku" (Monatsabschluss-SSoT) ---------
  const readiness = await getAdminMonthClosingReadiness(billingYear, billingMonth);
  const lohnReadiness = summarizeLohnReadiness(readiness);

  const ueberfaelligeDoku: CockpitOverdueDocItem[] = [];
  for (const emp of readiness) {
    const overdueAppts = [...emp.openAppointments, ...emp.unsignedAppointments].filter((a) =>
      isDocumentationOverdue48h({ date: a.date }, asOfLocal),
    );
    for (const a of overdueAppts) {
      ueberfaelligeDoku.push({
        appointmentId: a.id,
        customerName: a.customerName,
        employeeName: emp.displayName,
        date: a.date,
        status: a.status,
        daysOverdue: daysOverdue({ date: a.date }, asOfLocal),
      });
    }
  }
  ueberfaelligeDoku.sort((x, y) => y.daysOverdue - x.daysOverdue);

  // --- 5) „LN-Prüfung" (ausstehende Nachweis-Prüfungen) ----------------------
  const pendingProofs = await documentStorage.getPendingReviewProofs();
  const lnPruefung: CockpitProofReviewItem[] = pendingProofs.map((p) => ({
    proofId: p.id,
    employeeId: p.employee.id,
    employeeName: p.employee.displayName ?? "Unbekannt",
    documentTypeName: p.documentType?.name ?? null,
    uploadedAt: p.uploadedAt ? new Date(p.uploadedAt).toISOString() : null,
  }));

  // --- 6) „Abrechnungs-Prüfung" (berechtigt, noch nicht abgerechnet) ---------
  const abrechnungsPruefung = Array.from(abrechnungsByCustomer.values()).sort(
    (a, b) => b.totalCents - a.totalCents,
  );

  // --- 7) Ampel ---------------------------------------------------------------
  const ampel = resolveCockpitAmpel({
    ueberfaelligeDokuCount: ueberfaelligeDoku.length,
    zahlungsverzugCount: zahlungsverzug.length,
    lnPruefungCount: lnPruefung.length,
    abrechnungsPruefungCount: abrechnungsPruefung.length,
    lohnInPruefungCount: lohnReadiness.inPruefung,
  });

  return {
    asOfDate,
    billingYear,
    billingMonth,
    funnel,
    lohnReadiness,
    ampel,
    buckets: {
      ueberfaelligeDoku,
      lnPruefung,
      abrechnungsPruefung,
      zahlungsverzug,
    },
  };
}

/**
 * Baut die Termin-Drill-Zeilen EINER frühen Trichter-Stufe (READ-ONLY).
 *
 * Zwei-Phasen-Strategie für effiziente Pagination ohne SSoT-Duplikat:
 *  1. Billige Klassifikations-Abfrage (OHNE die teure `prices`-Berechnung) über
 *     alle Monats-Termine. Stufen-Zuordnung weiterhin per SSoT
 *     `assignAppointmentStage` in JS → IDs der gewünschten Stufe, stabil
 *     sortiert. Daraus ergibt sich `total` und die ID-Seite.
 *  2. Teure Umsatz-Abfrage NUR für die Seiten-IDs (z. B. 50 statt tausende).
 */
async function readAppointmentDrill(
  period: MonthPeriod,
  stage: CockpitFunnelStage,
  limit: number,
  offset: number,
): Promise<{ rows: CockpitDrillRow[]; total: number }> {
  const { periodStart, periodEnd } = period;

  // Phase 1 — Klassifikation (billig, keine Preis-Subquery).
  const candidates = await db.execute(sql`
    SELECT a.id, a.status, a.date,
      ${documentedAndSignedSqlRaw("a")} AS documented_and_signed,
      EXISTS (
        SELECT 1 FROM invoice_line_items li
        JOIN invoices i ON i.id = li.invoice_id
        WHERE li.appointment_id = a.id
          AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
      ) AS is_invoiced
    FROM appointments a
    WHERE a.deleted_at IS NULL
      AND a.date::date >= ${periodStart} AND a.date::date <= ${periodEnd}
      AND EXISTS (
        SELECT 1 FROM appointment_services asvc
        JOIN services s ON s.id = asvc.service_id
        WHERE asvc.appointment_id = a.id AND s.unit_type = 'hours'
      )
    ORDER BY a.date DESC, a.id DESC
  `);

  const matchedIds: number[] = [];
  for (const raw of candidates.rows as Record<string, unknown>[]) {
    const status = String(raw.status) as AppointmentStatus;
    const assignment = assignAppointmentStage({
      status,
      documentedAndSigned: raw.documented_and_signed === true,
      isInvoiced: raw.is_invoiced === true,
    });
    if (assignment.kind !== "stage") continue;
    if (mapPipelineStageToFunnel(assignment.stage) !== stage) continue;
    matchedIds.push(num(raw.id));
  }

  const total = matchedIds.length;
  const pageIds = matchedIds.slice(offset, offset + limit);
  if (pageIds.length === 0) return { rows: [], total };

  // Phase 2 — Umsatz/Minuten + Anzeigedaten NUR für die Seiten-IDs.
  const detail = await db.execute(sql`
    WITH appt_rev AS (
      SELECT a.id, a.customer_id,
        SUM(COALESCE(asvc.actual_duration_minutes, asvc.planned_duration_minutes))::bigint AS minutes_total,
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
      WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
        AND a.id IN (${sql.join(pageIds, sql`, `)})
      GROUP BY a.id, a.customer_id
    )
    SELECT ar.id, ar.customer_id, ar.revenue_cents, ar.minutes_total,
      a.status AS status, a.date AS date, c.name AS customer_name,
      COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
      u.display_name AS employee_name
    FROM appt_rev ar
    JOIN appointments a ON a.id = ar.id
    JOIN customers c ON c.id = ar.customer_id
    LEFT JOIN users u ON u.id = COALESCE(a.performed_by_employee_id, a.assigned_employee_id)
  `);

  const byId = new Map<number, CockpitDrillRow>();
  for (const raw of detail.rows as Record<string, unknown>[]) {
    const id = num(raw.id);
    const employeeId = raw.employee_id != null ? num(raw.employee_id) : null;
    byId.set(id, {
      id: `appt-${id}`,
      kind: "appointment",
      stage,
      minutes: num(raw.minutes_total),
      cents: num(raw.revenue_cents),
      employeeId,
      employeeName: raw.employee_name != null ? String(raw.employee_name) : null,
      customerId: num(raw.customer_id),
      customerName: String(raw.customer_name ?? ""),
      invoiceId: null,
      invoiceNumber: null,
      invoiceStatus: null,
      billingType: null,
      appointmentId: id,
      date: raw.date != null ? String(raw.date) : null,
    });
  }

  // Reihenfolge der Klassifikations-Phase (date DESC, id DESC) erhalten.
  const rows = pageIds.map((id) => byId.get(id)).filter((r): r is CockpitDrillRow => r != null);
  return { rows, total };
}

/**
 * Baut die Rechnungs-Drill-Zeilen EINER späten Trichter-Stufe (READ-ONLY).
 * Rechnungen sind pro Monat überschaubar viele → in-memory klassifizieren,
 * filtern, sortieren (Σ € absteigend) und paginieren.
 */
async function readInvoiceDrill(
  billingYear: number,
  billingMonth: number,
  stage: CockpitFunnelStage,
  limit: number,
  offset: number,
): Promise<{ rows: CockpitDrillRow[]; total: number }> {
  const invoices = await getInvoices({ year: billingYear, month: billingMonth });
  const all: CockpitDrillRow[] = [];
  for (const inv of invoices) {
    const assignment = assignInvoiceStage({ status: inv.status, invoiceType: inv.invoiceType });
    if (assignment.kind !== "stage") continue;
    if (mapPipelineStageToFunnel(assignment.stage) !== stage) continue;
    all.push({
      id: `inv-${inv.id}`,
      kind: "invoice",
      stage,
      minutes: 0,
      cents: inv.netAmountCents ?? 0,
      employeeId: null,
      employeeName: null,
      customerId: inv.customerId,
      customerName: inv.customerName ?? "",
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      invoiceStatus: inv.status,
      billingType: inv.billingType,
      appointmentId: null,
      date: null,
    });
  }
  all.sort((a, b) => b.cents - a.cents);
  const total = all.length;
  const rows = all.slice(offset, offset + limit);
  return { rows, total };
}

/**
 * Liest die Drill-Zeilen EINER Trichter-Stufe (READ-ONLY), lazy/paginiert.
 *
 * @param billingYear  Abrechnungs-Jahr
 * @param billingMonth Abrechnungs-Monat 1–12
 * @param asOfDate     Stichtag (ISO yyyy-mm-dd) — gespiegelt in der Antwort
 * @param stage        Die gewünschte Trichter-Stufe
 * @param limit        Max. Zeilen dieser Seite
 * @param offset       Start-Offset
 */
export async function readBillingCockpitDrill(
  billingYear: number,
  billingMonth: number,
  asOfDate: string,
  stage: CockpitFunnelStage,
  limit: number,
  offset: number,
): Promise<CockpitDrillResponse> {
  const period = monthPeriod(billingYear, billingMonth);

  const { rows, total } = APPOINTMENT_FUNNEL_STAGES.has(stage)
    ? await readAppointmentDrill(period, stage, limit, offset)
    : await readInvoiceDrill(billingYear, billingMonth, stage, limit, offset);

  return {
    billingYear,
    billingMonth,
    asOfDate,
    stage,
    rows,
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  };
}
