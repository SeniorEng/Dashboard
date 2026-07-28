/**
 * Task #1405 — API-Vertrag des Abrechnungs-Pipeline-Boards (Q4 SSoT-Reader).
 *
 * Diese Typen beschreiben die Antwort von `GET /api/billing/pipeline`. Die
 * fachliche Zuordnung (Stufe/Side/Aging) lebt ausschließlich in
 * `shared/domain/billing-pipeline.ts` und wird hier nur für den Transport
 * wiederverwendet.
 */
import type {
  PipelineStage,
  PipelineSideState,
  AgingBucket,
} from "../domain/billing-pipeline";

/** Eine Pipeline-Karte = Umsatz-tragende Einheit in EINER Stufe. */
export interface BillingPipelineCard {
  /** Stabiler Render-Key (kollidiert nicht über Stufen hinweg). */
  id: string;
  /** Frühe Stufen aggregieren pro Kunde, späte Stufen pro Rechnung. */
  kind: "customer" | "invoice";
  customerId: number;
  customerName: string;
  stage: PipelineStage;
  /** Anzahl Atomic-Units (Termine bzw. 1 für eine Rechnung) in dieser Stufe. */
  itemCount: number;
  totalCents: number;
  aging: AgingBucket;
  /** Nur für Rechnungs-Karten gesetzt. */
  invoiceId?: number;
  invoiceNumber?: string;
  invoiceStatus?: string;
  billingType?: string;
  budgetType?: string | null;
}

/** Aggregat einer Pipeline-Stufe (Spalte des Boards). */
export interface BillingPipelineStageGroup {
  stage: PipelineStage;
  label: string;
  /** Distinkte Fälle: Kunden (frühe Stufen) bzw. Rechnungen (späte Stufen). */
  caseCount: number;
  /** Anzahl Atomic-Units in der Stufe. */
  itemCount: number;
  totalCents: number;
  /** Anzahl Karten im roten Aging-Bucket (überfällig). */
  overdueCount: number;
  cards: BillingPipelineCard[];
}

/** Aggregat eines Side-Badges (nicht Teil der Stufen-Summe). */
export interface BillingPipelineSideGroup {
  state: PipelineSideState;
  label: string;
  itemCount: number;
  totalCents: number;
}

export interface BillingPipelineResponse {
  /** Stichtag der Aging-Berechnung (ISO yyyy-mm-dd, i. d. R. heute). */
  asOfDate: string;
  billingYear: number;
  billingMonth: number;
  stages: BillingPipelineStageGroup[];
  sides: BillingPipelineSideGroup[];
  totals: {
    /** Σ über alle Stufen (Umsatz in der Pipeline). */
    stageTotalCents: number;
    /** Σ über alle Side-Badges. */
    sideTotalCents: number;
    /** Σ Stufen + Side-Badges (Gesamt-Umsatz-Sicht, Q1). */
    grandTotalCents: number;
    /**
     * Task #1879 — Erwarteter Umsatz: Σ Stufen + „Wartet auf
     * Kundenunterschrift". Dies ist die auf der Karte angezeigte
     * „Gesamt-Umsatz"-Zahl (Storniert / Kunde nicht angetroffen ausgeschlossen).
     */
    expectedRevenueTotalCents: number;
  };
}
