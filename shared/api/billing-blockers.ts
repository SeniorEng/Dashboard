/**
 * Task #1462 — API-Vertrag des „Was hängt"-Panels (Phase 4, Teil A).
 *
 * Beschreibt die Antwort von `GET /api/billing/blockers`. Reine Sicht — keine
 * Mutation. Die fachliche Auswahl/Zählung lebt ausschließlich in
 * `shared/domain/billing-blockers.ts`; der Server liefert die beiden Gruppen
 * (Doku-Blocker, Budget-Blocker) bereits vor-aggregiert mit Anzahl + Posten.
 */
import type {
  DocumentationBlockerItem,
  BudgetBlockerItem,
} from "../domain/billing-blockers";

export type {
  DocumentationBlockerItem,
  BudgetBlockerItem,
} from "../domain/billing-blockers";

/** Eine Blocker-Gruppe: Anzahl betroffener Posten + die Posten selbst. */
export interface BillingBlockerGroup<TItem> {
  count: number;
  items: TItem[];
}

export interface BillingBlockersResponse {
  billingYear: number;
  billingMonth: number;
  /** Stichtag für die Überfälligkeits-/Verfügbarkeits-Sicht (ISO yyyy-mm-dd). */
  asOfDate: string;
  /** Gruppe 1: Termine ohne/überfällige Doku. */
  documentation: BillingBlockerGroup<DocumentationBlockerItem>;
  /** Gruppe 2: Budget/§45b-Probleme. */
  budget: BillingBlockerGroup<BudgetBlockerItem>;
}
