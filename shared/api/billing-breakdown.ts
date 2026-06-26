/**
 * Task #1453 — API-Vertrag der Abrechnungs-Breakdown-Tabelle (Phase 1).
 *
 * Beschreibt die Antwort von `GET /api/billing/breakdown`. Die fachliche
 * Aggregation lebt ausschließlich in `shared/domain/billing-breakdown.ts`; der
 * Server liefert pro (Kunde × Abrechnungstyp) vor-aggregierte Einheiten, die der
 * Client über dieselbe Domänen-Funktion (`groupBillingBreakdown`) nach Kunde
 * ODER Kasse gruppiert — kein Refetch beim Umschalten, keine zweite Berechnung.
 */
import type { AggregatedBreakdownUnit } from "../domain/billing-breakdown";

/** Eine vor-aggregierte Breakdown-Einheit (Transport-Form, siehe Domäne). */
export type BillingBreakdownUnit = AggregatedBreakdownUnit;

export interface BillingBreakdownResponse {
  billingYear: number;
  billingMonth: number;
  units: BillingBreakdownUnit[];
}
