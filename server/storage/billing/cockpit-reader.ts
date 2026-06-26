/**
 * Task #1444 — Abrechnung-Cockpit (Phase 1): READ-ONLY-Reader.
 *
 * EIN Lesepfad, der das Cockpit-Read-Model für einen Abrechnungs-Monat liefert.
 * Er KOMPONIERT bestehende SSoTs, statt sie zu duplizieren:
 *  - Termin-Umsatz: dieselbe `prices`-/`unit_type='hours'`-Formel wie der
 *    Pipeline-Reader / die Umsatz-Statistik (€-Konservierung).
 *  - „dokumentiert & unterschrieben": `documentedAndSignedSqlRaw`.
 *  - Stufen-/Aging-Zuordnung: die reinen Funktionen aus
 *    `shared/domain/billing-pipeline.ts`, danach gröber auf 5 Trichter-Stufen
 *    abgebildet (`mapPipelineStageToFunnel`).
 *  - Lohn-Readiness + „Überfällige Doku": `getAdminMonthClosingReadiness`.
 *  - „LN-Prüfung": `documentStorage.getPendingReviewProofs`.
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
  summarizeCockpitFunnel,
  summarizeLohnReadiness,
  resolveCockpitAmpel,
  isDocumentationOverdue48h,
  type CockpitDrillRow,
} from "@shared/domain/billing-cockpit";
import { daysOverdue } from "@shared/domain/appointments";
import type { AppointmentStatus } from "@shared/domain/appointments";
import type {
  BillingCockpitResponse,
  CockpitOverdueDocItem,
  CockpitProofReviewItem,
  CockpitBillingReviewItem,
  CockpitOverdueInvoiceItem,
} from "@shared/api/billing-cockpit";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Liest das Cockpit-Read-Model für einen Abrechnungs-Monat (READ-ONLY).
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
  const periodStart = `${billingYear}-${pad2(billingMonth)}-01`;
  const lastDay = new Date(billingYear, billingMonth, 0).getDate();
  const periodEnd = `${billingYear}-${pad2(billingMonth)}-${pad2(lastDay)}`;
  const asOfLocal = new Date(`${asOfDate}T00:00:00`);

  const rows: CockpitDrillRow[] = [];

  // --- 1) Termine (frühe Trichter-Stufen) ------------------------------------
  // Pro-Termin-Umsatz + Minuten mit IDENTISCHER Formel wie der Pipeline-Reader,
  // zusätzlich Mitarbeiter-Zuordnung (für die Mitarbeiter-Gruppierung).
  const apptRows = await db.execute(sql`
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
        AND a.date::date >= ${periodStart} AND a.date::date <= ${periodEnd}
      GROUP BY a.id, a.customer_id
    )
    SELECT ar.id, ar.customer_id AS customer_id, ar.revenue_cents, ar.minutes_total,
      a.status AS status,
      a.date AS date,
      c.name AS customer_name,
      COALESCE(a.performed_by_employee_id, a.assigned_employee_id) AS employee_id,
      u.display_name AS employee_name,
      ${documentedAndSignedSqlRaw("a")} AS documented_and_signed,
      EXISTS (
        SELECT 1 FROM invoice_line_items li
        JOIN invoices i ON i.id = li.invoice_id
        WHERE li.appointment_id = a.id
          AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
      ) AS is_invoiced
    FROM appt_rev ar
    JOIN appointments a ON a.id = ar.id
    JOIN customers c ON c.id = ar.customer_id
    LEFT JOIN users u ON u.id = COALESCE(a.performed_by_employee_id, a.assigned_employee_id)
  `);

  for (const raw of apptRows.rows as Record<string, unknown>[]) {
    const status = String(raw.status) as AppointmentStatus;
    const assignment = assignAppointmentStage({
      status,
      documentedAndSigned: raw.documented_and_signed === true,
      isInvoiced: raw.is_invoiced === true,
    });
    // Nur Stufen-Einheiten erscheinen im Trichter; Side/Excluded (Storno,
    // No-Show, abgelaufen, bereits abgerechnet) werden hier ausgelassen —
    // identisch zur Pipeline.
    if (assignment.kind !== "stage") continue;
    const stage = mapPipelineStageToFunnel(assignment.stage);
    const id = num(raw.id);
    const employeeId = raw.employee_id != null ? num(raw.employee_id) : null;
    rows.push({
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

  // --- 2) Rechnungen (späte Trichter-Stufen) ---------------------------------
  const zahlungsverzug: CockpitOverdueInvoiceItem[] = [];
  const invoices = await getInvoices({ year: billingYear, month: billingMonth });
  for (const inv of invoices) {
    const assignment = assignInvoiceStage({ status: inv.status, invoiceType: inv.invoiceType });
    if (assignment.kind !== "stage") continue;
    const stage = mapPipelineStageToFunnel(assignment.stage);
    const cents = inv.netAmountCents ?? 0;

    // Aging nur in den versendet-/avis-Stufen sinnvoll (Zahlungs-/Avis-Lauf).
    let aging: AgingBucket = "none";
    if (assignment.stage === "versendet" || assignment.stage === "avis_erhalten") {
      const model = agingModelForBillingType(inv.billingType);
      const anchorIso =
        model === "selbstzahler"
          ? inv.dueDate ?? null
          : inv.sentAt
            ? new Date(inv.sentAt).toISOString().slice(0, 10)
            : null;
      aging = resolveAgingBucket(model, anchorIso, asOfDate);
    }

    rows.push({
      id: `inv-${inv.id}`,
      kind: "invoice",
      stage,
      minutes: 0,
      cents,
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

  // --- 3) Trichter + Ableitungen ---------------------------------------------
  const funnel = summarizeCockpitFunnel(rows);

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
  // = die Leistungsnachweis-Trichter-Stufe (unterschrieben, noch nicht
  //   abgerechnet), pro Kunde gebündelt.
  const abrechnungsByCustomer = new Map<number, CockpitBillingReviewItem>();
  for (const row of rows) {
    if (row.stage !== "leistungsnachweis") continue;
    let entry = abrechnungsByCustomer.get(row.customerId);
    if (!entry) {
      entry = {
        customerId: row.customerId,
        customerName: row.customerName,
        itemCount: 0,
        totalCents: 0,
      };
      abrechnungsByCustomer.set(row.customerId, entry);
    }
    entry.itemCount += 1;
    entry.totalCents += row.cents;
  }
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
    rows,
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
