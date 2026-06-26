/**
 * Task #1456 — Pre-Commit-Review-Cluster (Phase 2): READ-Modell für
 * `GET /billing/review-clusters`.
 *
 * Komponiert ausschließlich bestehende SSoTs — keine neue Engine, keine zweite
 * Eligibilitäts-Kopie, keine eigene Geld-/Stunden-/km-Mathematik:
 *  - Phase-1-Spalten (HW/AB/km/€) UND die Cluster-Gruppierung nach Dimension
 *    (Kunde / Kasse=`billingType`) laufen über `readBillingBreakdown` +
 *    `groupBillingBreakdown(units, dim)` + `summarizeBreakdownRows` — exakt wie
 *    die Phase-1-Breakdown. Dadurch ist Σ Review === Σ Breakdown per Konstruktion.
 *  - Eligibilität: `classifyBillingEligibility` (shared) gefüllt aus EXAKT den
 *    Readern, die auch `buildInvoiceDraft` nutzt (`getServiceRecordsForPeriod`,
 *    `getAppointmentIdsFromServiceRecords`, `getAlreadyInvoicedAppointmentIds`) —
 *    deshalb deckt sich die Review-Klassifikation mit der echten Annahme/Ablehnung
 *    des Generate-Pfads.
 *
 * Beide Cluster-Sichten (Kunde + Kasse) werden vor-aggregiert mitgeliefert, damit
 * der Dimension-Umschalter im Client ohne Refetch arbeitet. Whole-month-Sicht
 * (wie die Breakdown-SSoT). Geldbeträge sind Integer-Cents.
 */
import { readBillingBreakdown } from "../storage/billing/breakdown-reader";
import {
  groupBillingBreakdown,
  summarizeBreakdownRows,
  type BreakdownDimension,
} from "@shared/domain/billing-breakdown";
import {
  classifyBillingEligibility,
  isServiceRecordSignedForBilling,
} from "@shared/domain/billing-eligibility";
import {
  getServiceRecordsForPeriod,
  getAppointmentIdsFromServiceRecords,
  getAlreadyInvoicedAppointmentIds,
} from "./invoice-data";
import type {
  BillingReviewClusterItem,
  BillingReviewClusterGroup,
  BillingReviewClustersResponse,
} from "@shared/api";

const CUST_KEY_PREFIX = "cust-";

export async function readBillingReviewClusters(
  billingYear: number,
  billingMonth: number,
): Promise<BillingReviewClustersResponse> {
  const breakdown = await readBillingBreakdown(billingYear, billingMonth);

  // Per-Kunde aggregierte Phase-1-Zeile über die Breakdown-Domänen-SSoT.
  const kundeRows = groupBillingBreakdown(breakdown.units, "kunde");
  const rowByCustomerId = new Map<number, (typeof kundeRows)[number]>();
  for (const r of kundeRows) {
    rowByCustomerId.set(Number(r.key.slice(CUST_KEY_PREFIX.length)), r);
  }

  // billingType/Name je Kunde aus den Roh-Einheiten (eine Quelle, kein Re-Query).
  const metaByCustomer = new Map<number, { billingType: string; customerName: string }>();
  for (const u of breakdown.units) {
    if (!metaByCustomer.has(u.customerId)) {
      metaByCustomer.set(u.customerId, { billingType: u.billingType, customerName: u.customerName });
    }
  }

  const customerIds = Array.from(metaByCustomer.keys());
  if (customerIds.length === 0) {
    return {
      billingYear,
      billingMonth,
      items: [],
      clusters: { kunde: [], kasse: [] },
      grandTotals: summarizeBreakdownRows([]),
    };
  }

  // Eligibilität je Kunde EXAKT wie `buildInvoiceDraft`: dieselben Reader, dieselbe SSoT.
  const items: BillingReviewClusterItem[] = [];
  for (const customerId of customerIds) {
    const meta = metaByCustomer.get(customerId)!;
    const row = rowByCustomerId.get(customerId);

    const serviceRecords = await getServiceRecordsForPeriod(customerId, billingYear, billingMonth);
    const serviceRecordStatuses = serviceRecords.map((sr) => sr.status);
    const signedRecordIds = serviceRecords
      .filter((sr) => isServiceRecordSignedForBilling(meta.billingType, sr.status))
      .map((sr) => sr.id);
    const allApptIds = signedRecordIds.length > 0
      ? await getAppointmentIdsFromServiceRecords(signedRecordIds)
      : [];
    const alreadyInvoiced = new Set(
      await getAlreadyInvoicedAppointmentIds(customerId, billingYear, billingMonth),
    );
    const unbilledAppointmentCount = allApptIds.filter((id) => !alreadyInvoiced.has(id)).length;

    const eligibility = classifyBillingEligibility({
      billingType: meta.billingType,
      serviceRecordStatuses,
      signedAppointmentCount: allApptIds.length,
      unbilledAppointmentCount,
    });

    items.push({
      customerId,
      customerName: meta.customerName,
      billingType: meta.billingType,
      hauswirtschaftMinutes: row?.hauswirtschaftMinutes ?? 0,
      alltagsbegleitungMinutes: row?.alltagsbegleitungMinutes ?? 0,
      kmQuantized: row?.kmQuantized ?? 0,
      totalCents: row?.totalCents ?? 0,
      eligibility,
    });
  }

  items.sort(
    (a, b) => b.totalCents - a.totalCents || a.customerName.localeCompare(b.customerName, "de"),
  );

  // Cluster-Membership je Dimension aus den Item-Eligibilitäten ableiten und an
  // die Breakdown-SSoT-Summen heften (Schlüssel identisch zu groupBillingBreakdown).
  const eligibleByCustomer = new Map(
    items.map((i) => [i.customerId, i.eligibility.status === "eligible"]),
  );
  const buildClusters = (dimension: BreakdownDimension): BillingReviewClusterGroup[] => {
    const rows = groupBillingBreakdown(breakdown.units, dimension);
    // customerId → Cluster-Key derselben Dimension.
    const memberKeyByCustomer = new Map<number, string>();
    for (const u of breakdown.units) {
      memberKeyByCustomer.set(
        u.customerId,
        dimension === "kasse" ? `kasse-${u.billingType}` : `${CUST_KEY_PREFIX}${u.customerId}`,
      );
    }
    const membersByKey = new Map<string, { all: number[]; eligible: number[] }>();
    for (const i of items) {
      const key = memberKeyByCustomer.get(i.customerId);
      if (!key) continue;
      const bucket = membersByKey.get(key) ?? { all: [], eligible: [] };
      bucket.all.push(i.customerId);
      if (eligibleByCustomer.get(i.customerId)) bucket.eligible.push(i.customerId);
      membersByKey.set(key, bucket);
    }
    return rows.map((r) => {
      const members = membersByKey.get(r.key) ?? { all: [], eligible: [] };
      return {
        key: r.key,
        label: r.label,
        hauswirtschaftMinutes: r.hauswirtschaftMinutes,
        alltagsbegleitungMinutes: r.alltagsbegleitungMinutes,
        kmQuantized: r.kmQuantized,
        totalCents: r.totalCents,
        customerIds: members.all,
        eligibleCustomerIds: members.eligible,
      };
    });
  };

  return {
    billingYear,
    billingMonth,
    items,
    clusters: { kunde: buildClusters("kunde"), kasse: buildClusters("kasse") },
    grandTotals: summarizeBreakdownRows(kundeRows),
  };
}
