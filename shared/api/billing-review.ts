/**
 * Task #1456 — Wire-Shapes für den Pre-Commit-Review-Cluster auf
 * `/admin/billing` (Phase 2). Liefert die abzurechnende Arbeit GRUPPIERT nach
 * Cluster-Dimension (Kunde / Kasse) — pro Cluster die Phase-1-Spalten
 * (Std. Hauswirtschaft | Std. Alltagsbegleitung | Summe km | €) plus eine
 * Gesamtsumme — sowie die Abrechnungs-Eligibilität je Kunde (eligible/blocked +
 * Begründung). „Kasse" = `billingType`-Kategorie, identisch zur Phase-1-Breakdown
 * (`groupBillingBreakdown`). Beide Cluster-Sichten werden vor-aggregiert
 * mitgeliefert, damit der Dimension-Umschalter ohne Refetch arbeitet.
 */
import type {
  BillingBlockReason,
  BillingEligibilityStatus,
} from "../domain/billing-eligibility";
import type { BreakdownTotals } from "../domain/billing-breakdown";

export const BILLING_REVIEW_DIMENSIONS = ["kunde", "kasse"] as const;
export type BillingReviewDimension = (typeof BILLING_REVIEW_DIMENSIONS)[number];

export interface BillingReviewEligibility {
  status: BillingEligibilityStatus;
  reason: BillingBlockReason | null;
  message: string | null;
}

/** Eine Kunden-Zeile (Mitglied eines Clusters) mit Phase-1-Spalten + Status. */
export interface BillingReviewClusterItem {
  customerId: number;
  customerName: string;
  billingType: string;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  /** Quantisierte km-Summe (2 Nachkommastellen, identisch zur Breakdown-SSoT). */
  kmQuantized: number;
  /** Brutto-Summe in Integer-Cents. */
  totalCents: number;
  eligibility: BillingReviewEligibility;
}

/**
 * Ein nach der gewählten Dimension gruppierter Cluster mit vor-aggregierten
 * Phase-1-Summen (über `groupBillingBreakdown` berechnet) und der Liste seiner
 * Kunden. `eligibleCustomerIds` ist die Teilmenge, die der Generate-Pfad
 * akzeptiert — sie speist „Mark-all" und die Erstellung.
 */
export interface BillingReviewClusterGroup {
  /** Stabiler Render-Key (`cust-<id>` bzw. `kasse-<billingType>`). */
  key: string;
  label: string;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  kmQuantized: number;
  totalCents: number;
  /** Alle Kunden dieses Clusters (für die Mitglieder-Zeilen). */
  customerIds: number[];
  /** Nur die abrechenbaren Kunden (für Mark-all + Generierung). */
  eligibleCustomerIds: number[];
}

export interface BillingReviewClustersResponse {
  billingYear: number;
  billingMonth: number;
  /** Kunden-Zeilen (Eligibilität + Begründung + per-Kunde-Summen). */
  items: BillingReviewClusterItem[];
  /** Vor-aggregierte Cluster je Dimension (server-seitig über die SSoT). */
  clusters: Record<BillingReviewDimension, BillingReviewClusterGroup[]>;
  /** Gesamtsumme über alle Cluster (dimensionsunabhängig). */
  grandTotals: BreakdownTotals;
}
