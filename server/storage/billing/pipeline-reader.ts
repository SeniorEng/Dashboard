/**
 * Task #1405 — Abrechnungs-Pipeline-Reader (Q4 SSoT).
 *
 * EIN Lesepfad, der den vollständigen Monats-Lebenszyklus als Pipeline-Board
 * liefert. Er KOMPONIERT bestehende SSoTs statt sie zu duplizieren:
 *  - Termin-Umsatz: dieselbe `prices`-/`unit_type='hours'`-Formel wie die
 *    Umsatz-Statistik (`server/storage/statistics/revenue.ts`), damit die
 *    Pipeline-Stufen-Summe auf einem sauberen Monat exakt dem
 *    `planned`-Umsatz entspricht (€-Konservierung, Q1).
 *  - „dokumentiert & unterschrieben": `documentedAndSignedSqlRaw`
 *    (= SQL-Spiegel von `isAppointmentDocumentedAndSigned`).
 *  - „Termin liegt auf einer aktiven Rechnung":
 *    `activeInvoiceForAppointmentExistsSqlRaw`
 *    (`server/lib/appointment-invoiced.ts`, Task #1892).
 *  - Stufen-/Side-/Aging-Zuordnung: die reinen Funktionen aus
 *    `shared/domain/billing-pipeline.ts`.
 *
 * Hybrid-Bruchkante (Q1/D1): solange ein Termin NICHT abgerechnet ist, lebt
 * sein € auf der Termin-Karte (frühe Stufen). Sobald er über eine
 * nicht-stornierte Rechnung abgerechnet ist, verlässt er die Termin-Stufen
 * (`excluded: invoiced`) und sein € lebt auf der Rechnungs-Karte (späte
 * Stufen). So wird jeder € genau einmal gezählt.
 *
 * Geldbasis: NETTO (Integer-Cents) — Termin-Umsatz ist netto, Rechnungs-Karten
 * verwenden `netAmountCents`, damit die Basis über die Hybrid-Kante konsistent
 * bleibt (Pflegekassen-Töpfe sind USt-befreit ⇒ netto == brutto).
 */
import { sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { num } from "../statistics/common";
import { hasDirectSignatureSqlRaw, serviceRecordWithStatusExistsSqlRaw } from "../../lib/appointment-signed";
import { activeInvoiceForAppointmentExistsSqlRaw } from "../../lib/appointment-invoiced";
import { getInvoices } from "../billing-storage";
import { qontoStorage } from "../qonto";
import {
  agingModelForBillingType,
  assignAppointmentStage,
  assignInvoiceStage,
  assignInvoiceActionCluster,
  isAgingCluster,
  resolveAgingBucket,
  summarizePipelineCents,
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  PIPELINE_SIDE_STATES,
  PIPELINE_SIDE_STATE_LABELS,
  type PipelineStage,
  type PipelineSideState,
  type PipelineAtomicUnit,
  type AgingBucket,
} from "@shared/domain/billing-pipeline";
import type { AppointmentStatus } from "@shared/domain/appointments";
import type {
  BillingPipelineResponse,
  BillingPipelineCard,
  BillingPipelineStageGroup,
  BillingPipelineSideGroup,
} from "@shared/api/billing-pipeline";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface MutableStageGroup {
  caseKeys: Set<string>;
  itemCount: number;
  totalCents: number;
  overdueCount: number;
  cards: BillingPipelineCard[];
}

interface MutableSideGroup {
  itemCount: number;
  totalCents: number;
}

/**
 * Liest das Pipeline-Board für einen Abrechnungs-Monat.
 *
 * @param billingYear  Abrechnungs-Jahr (z. B. 2026)
 * @param billingMonth Abrechnungs-Monat 1–12
 * @param asOfDate     Stichtag für das Aging (ISO yyyy-mm-dd, Default = heute)
 */
export async function readBillingPipeline(
  billingYear: number,
  billingMonth: number,
  asOfDate: string,
): Promise<BillingPipelineResponse> {
  const periodStart = `${billingYear}-${pad2(billingMonth)}-01`;
  const lastDay = new Date(billingYear, billingMonth, 0).getDate();
  const periodEnd = `${billingYear}-${pad2(billingMonth)}-${pad2(lastDay)}`;

  // --- Stufen-/Side-Akkumulatoren initialisieren ------------------------------
  const stageGroups: Record<PipelineStage, MutableStageGroup> = PIPELINE_STAGES.reduce(
    (acc, s) => {
      acc[s] = { caseKeys: new Set(), itemCount: 0, totalCents: 0, overdueCount: 0, cards: [] };
      return acc;
    },
    {} as Record<PipelineStage, MutableStageGroup>,
  );
  const sideGroups: Record<PipelineSideState, MutableSideGroup> = PIPELINE_SIDE_STATES.reduce(
    (acc, s) => {
      acc[s] = { itemCount: 0, totalCents: 0 };
      return acc;
    },
    {} as Record<PipelineSideState, MutableSideGroup>,
  );

  const units: PipelineAtomicUnit[] = [];

  // --- 1) Termine (frühe Stufen, VOR Topf-Split) ------------------------------
  // Pro-Termin-Umsatz mit IDENTISCHER Formel wie die Umsatz-Statistik.
  const apptRows = await db.execute(sql`
    WITH appt_rev AS (
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
        ))::bigint AS revenue_cents
      FROM appointments a
      JOIN appointment_services asvc ON asvc.appointment_id = a.id
      JOIN services s ON s.id = asvc.service_id
      WHERE a.deleted_at IS NULL AND s.unit_type = 'hours'
        AND a.date::date >= ${periodStart} AND a.date::date <= ${periodEnd}
      GROUP BY a.id, a.customer_id
    )
    SELECT ar.id, ar.customer_id AS customer_id, ar.revenue_cents,
      a.status AS status,
      c.name AS customer_name,
      c.billing_type AS billing_type,
      ${hasDirectSignatureSqlRaw("a")} AS has_direct_signature,
      ${serviceRecordWithStatusExistsSqlRaw("a", "completed")} AS has_completed_ln,
      ${serviceRecordWithStatusExistsSqlRaw("a", "employee_signed")} AS has_employee_signed_ln,
      ${activeInvoiceForAppointmentExistsSqlRaw("a.id")} AS is_invoiced
    FROM appt_rev ar
    JOIN appointments a ON a.id = ar.id
    -- #1886: Erstberatungen (kundenlos, customer_id = NULL) fallen hier über den
    -- INNER JOIN auf customers implizit raus und erscheinen nie in der
    -- Kunden-Abrechnungs-Pipeline. Kein expliziter appointment_type-Filter nötig
    -- (wäre redundant); der Ausschluss ist an den NULL-customer_id-Invariant der
    -- Erstberatung gekoppelt (siehe CLAUDE.md → Arbeitsregeln).
    JOIN customers c ON c.id = ar.customer_id
  `);

  for (const raw of apptRows.rows as Record<string, unknown>[]) {
    const status = String(raw.status) as AppointmentStatus;
    const cents = num(raw.revenue_cents);
    const customerId = num(raw.customer_id);
    const customerName = String(raw.customer_name ?? "");
    const assignment = assignAppointmentStage({
      status,
      billingType: raw.billing_type == null ? null : String(raw.billing_type),
      hasDirectSignature: raw.has_direct_signature === true,
      hasCompletedServiceRecord: raw.has_completed_ln === true,
      hasEmployeeSignedServiceRecord: raw.has_employee_signed_ln === true,
      isInvoiced: raw.is_invoiced === true,
    });
    units.push({ assignment, cents });

    if (assignment.kind === "stage") {
      const grp = stageGroups[assignment.stage];
      const caseKey = `cust-${customerId}`;
      grp.caseKeys.add(caseKey);
      grp.itemCount += 1;
      grp.totalCents += cents;
      // Karte pro (Stufe × Kunde) aggregieren.
      const cardId = `appt-${assignment.stage}-cust-${customerId}`;
      const existing = grp.cards.find((c) => c.id === cardId);
      if (existing) {
        existing.itemCount += 1;
        existing.totalCents += cents;
      } else {
        grp.cards.push({
          id: cardId,
          kind: "customer",
          customerId,
          customerName,
          stage: assignment.stage,
          itemCount: 1,
          totalCents: cents,
          aging: "none",
        });
      }
    } else if (assignment.kind === "side") {
      const sg = sideGroups[assignment.state];
      sg.itemCount += 1;
      sg.totalCents += cents;
    }
    // excluded (invoiced/cancelled): kein €-Beitrag in den Termin-Stufen.
  }

  // --- 2) Rechnungen (späte Stufen, NACH Topf-Split) --------------------------
  const invoices = await getInvoices({ year: billingYear, month: billingMonth });
  // #1897 — Welche dieser Rechnungen tragen bereits eine gebundene Zahlung?
  // Gelesen aus der SSoT (`getClaimedInvoiceIds`: 1:1-Match ODER Mitglied eines
  // an eine Transaktion gebundenen Avis), NICHT hier nachgerechnet. Ein Aufruf
  // für alle Rechnungen des Monats statt einer Abfrage je Rechnung.
  const claimedInvoiceIds = invoices.length > 0
    ? await qontoStorage.getClaimedInvoiceIds(db, invoices.map((i) => i.id))
    : new Set<number>();

  for (const inv of invoices) {
    const cents = inv.netAmountCents ?? 0;
    const assignment = assignInvoiceStage({ status: inv.status, invoiceType: inv.invoiceType });
    units.push({ assignment, cents });

    if (assignment.kind === "stage") {
      const grp = stageGroups[assignment.stage];
      grp.caseKeys.add(`inv-${inv.id}`);
      grp.itemCount += 1;
      grp.totalCents += cents;

      // #1897 — Aging über den CLUSTER statt über die Stufe. ERSETZT die
      // frühere Bedingung `stage === "versendet" || stage === "avis_erhalten"`,
      // die die Zahlungsbindung nicht kannte: eine Rechnung mit längst
      // eingegangener Zahlung alterte weiter und wurde unten als `overdueCount`
      // mitgezählt — die Abrechnung mahnte Geld an, das auf dem Konto lag.
      //
      // Die Liste (`client/src/features/billing/utils.ts` → `invoiceAgingBucket`)
      // gatet schon immer über den Cluster. Mit `isAgingCluster` lesen beide
      // Seiten jetzt dieselbe Funktion und können nicht mehr auseinanderdriften.
      const cluster = assignInvoiceActionCluster({
        status: inv.status,
        invoiceType: inv.invoiceType,
        billingType: inv.billingType,
        hasBoundPayment: claimedInvoiceIds.has(inv.id),
      });
      let aging: AgingBucket = "none";
      if (isAgingCluster(cluster)) {
        const model = agingModelForBillingType(inv.billingType);
        const anchorIso =
          model === "selbstzahler"
            ? inv.dueDate ?? null
            : inv.sentAt
              ? new Date(inv.sentAt).toISOString().slice(0, 10)
              : null;
        aging = resolveAgingBucket(model, anchorIso, asOfDate);
      }
      if (aging === "red") grp.overdueCount += 1;

      grp.cards.push({
        id: `inv-${inv.id}`,
        kind: "invoice",
        customerId: inv.customerId,
        customerName: inv.customerName ?? "",
        stage: assignment.stage,
        itemCount: 1,
        totalCents: cents,
        aging,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceStatus: inv.status,
        billingType: inv.billingType,
        budgetType: inv.budgetType ?? null,
      });
    } else if (assignment.kind === "side") {
      const sg = sideGroups[assignment.state];
      sg.itemCount += 1;
      sg.totalCents += cents;
    }
  }

  // --- 3) Aggregation + €-Konservierung ---------------------------------------
  const summary = summarizePipelineCents(units);

  const stages: BillingPipelineStageGroup[] = PIPELINE_STAGES.map((stage) => {
    const g = stageGroups[stage];
    return {
      stage,
      label: PIPELINE_STAGE_LABELS[stage],
      caseCount: g.caseKeys.size,
      itemCount: g.itemCount,
      totalCents: g.totalCents,
      overdueCount: g.overdueCount,
      cards: g.cards,
    };
  });

  const sides: BillingPipelineSideGroup[] = PIPELINE_SIDE_STATES.map((state) => ({
    state,
    label: PIPELINE_SIDE_STATE_LABELS[state],
    itemCount: sideGroups[state].itemCount,
    totalCents: sideGroups[state].totalCents,
  }));

  return {
    asOfDate,
    billingYear,
    billingMonth,
    stages,
    sides,
    totals: {
      stageTotalCents: summary.stageTotalCents,
      sideTotalCents: summary.sideTotalCents,
      grandTotalCents: summary.grandTotalCents,
      expectedRevenueTotalCents: summary.expectedRevenueTotalCents,
    },
  };
}
