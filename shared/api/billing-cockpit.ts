/**
 * Task #1444 — Abrechnung-Cockpit (Phase 1): API-Transport-Typen.
 *
 * READ-ONLY-Antwort des Cockpit-Endpunkts. Re-exportiert die reinen
 * Trichter-/Gruppierungs-Typen aus `shared/domain/billing-cockpit.ts`, damit
 * Server und Client EINE Quelle teilen. Geldbeträge sind Integer-Cents.
 */
import type {
  CockpitFunnelStage,
  CockpitStageSummary,
  CockpitDrillRow,
  CockpitAmpel,
  LohnReadinessSummary,
} from "../domain/billing-cockpit";

export type {
  CockpitFunnelStage,
  CockpitStageSummary,
  CockpitDrillRow,
  CockpitAmpel,
  LohnReadinessSummary,
};

/** Bucket „Überfällige Doku" — Termin >48 h alt ohne/unvollständige Doku. */
export interface CockpitOverdueDocItem {
  appointmentId: number;
  customerName: string;
  employeeName: string | null;
  date: string;
  status: string;
  daysOverdue: number;
}

/** Bucket „LN-Prüfung" — ausstehende Leistungsnachweis-/Nachweis-Prüfung. */
export interface CockpitProofReviewItem {
  proofId: number;
  employeeId: number;
  employeeName: string;
  documentTypeName: string | null;
  uploadedAt: string | null;
}

/** Bucket „Abrechnungs-Prüfung" — berechtigte, noch nicht abgerechnete Kunden. */
export interface CockpitBillingReviewItem {
  customerId: number;
  customerName: string;
  itemCount: number;
  totalCents: number;
}

/** Bucket „Zahlungsverzug" — überfällige Rechnungen (Aging rot). */
export interface CockpitOverdueInvoiceItem {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  customerName: string;
  billingType: string | null;
  totalCents: number;
}

export interface CockpitReviewBuckets {
  ueberfaelligeDoku: CockpitOverdueDocItem[];
  lnPruefung: CockpitProofReviewItem[];
  abrechnungsPruefung: CockpitBillingReviewItem[];
  zahlungsverzug: CockpitOverdueInvoiceItem[];
}

export interface BillingCockpitResponse {
  asOfDate: string;
  billingYear: number;
  billingMonth: number;
  /** Trichter-Leiste: die 5 Stufen (immer alle 5, auch leer). */
  funnel: CockpitStageSummary[];
  /** Flache Drill-down-Zeilen; clientseitig gruppierbar (Mitarbeiter/Rechnung/Kunde). */
  rows: CockpitDrillRow[];
  /** Lohn-Readiness („X lohnreif, Y in Prüfung"). */
  lohnReadiness: LohnReadinessSummary;
  /** Cockpit-Ampel grün/gelb/rot. */
  ampel: CockpitAmpel;
  /** Die vier „Zu prüfen"-Buckets (Zone C). */
  buckets: CockpitReviewBuckets;
}
