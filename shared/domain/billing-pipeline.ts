/**
 * Task #1405 — Abrechnung als Single Source of Truth (Pipeline-Board).
 *
 * Diese Datei ist die PURE Domänen-Schicht des gemeinsamen
 * `billing-pipeline-reader` (Q4): Stage- und Aging-Zuordnung als reine,
 * deterministische Funktionen ohne DB-/Netzwerk-Zugriff. Sie KOMPONIERT die
 * bestehenden SSoT-Prädikate (`isAppointmentDocumentedAndSigned`,
 * `INVOICE_STATUSES`), statt sie zu re-implementieren.
 *
 * Leitprinzip (Q1): „Eine Karte kann in N Stufen erscheinen, aber jeder € lebt
 * in genau EINER Stufe." Die Stage-Zuordnung einer Atomic-Unit (Termin VOR
 * Topf-Split, Rechnung NACH Topf-Split) ist daher TOTAL und DISJUNKT — exakt
 * genau eine Zuordnung pro Eingabe (verankert in
 * `tests/architecture/billing-pipeline-stage-identity.test.ts`).
 *
 * Geldbeträge sind ausnahmslos Integer-Cents.
 */
import type { AppointmentStatus } from "./appointments";
import { parseLocalDate } from "../utils/datetime";

// ============================================
// PIPELINE-STUFEN (SSoT) — nur bestehende Status
// ============================================

/**
 * Die EINE Status-Pipeline (geordnet). Spiegelt den fachlichen
 * Monats-Lebenszyklus wider — keine neuen Status, nur Sichten auf bestehende
 * Termin-/Service-Record-/Rechnungs-Status.
 */
export const PIPELINE_STAGES = [
  "offen",
  "dokumentiert",
  "unterschrieben",
  "rechnung_erstellt",
  "versendet",
  "avis_erhalten",
  "bezahlt",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  offen: "Offen",
  dokumentiert: "Dokumentiert",
  unterschrieben: "Unterschrieben",
  rechnung_erstellt: "Rechnung erstellt",
  versendet: "Versendet",
  avis_erhalten: "Avis erhalten",
  bezahlt: "Bezahlt",
};

/**
 * Side-/Endzustände — KEIN Pipeline-Schritt, sondern Badges. Ihre € fließen
 * NICHT in die Stufen-Summen, werden aber separat ausgewiesen (Q1:
 * „Gesamtumsatz = Σ über alle Stufen + Side-Badges").
 */
export const PIPELINE_SIDE_STATES = [
  "storniert",
  "kunde_nicht_angetroffen",
  "nicht_abgerechnet",
] as const;
export type PipelineSideState = (typeof PIPELINE_SIDE_STATES)[number];

export const PIPELINE_SIDE_STATE_LABELS: Record<PipelineSideState, string> = {
  storniert: "Storniert",
  kunde_nicht_angetroffen: "Kunde nicht angetroffen",
  nicht_abgerechnet: "Nicht abgerechnet",
};

/**
 * Eine Atomic-Unit wird genau einem dieser drei Ausgänge zugeordnet:
 *  - `stage`    → eine Pipeline-Stufe (trägt € in die Stufen-Summe).
 *  - `side`     → ein Side-Badge (trägt € in die Side-Summe, nicht in Stufen).
 *  - `excluded` → keine Umsatz-tragende Einheit an dieser Stelle:
 *       `invoiced`  = Termin wurde abgerechnet, sein € lebt jetzt auf der
 *                     Rechnung (Hybrid-Bruchkante, vermeidet Doppelzählung).
 *       `cancelled` = stornierter Termin ohne Umsatz.
 */
export type PipelineExclusionReason = "invoiced" | "cancelled";

export type PipelineAssignment =
  | { kind: "stage"; stage: PipelineStage }
  | { kind: "side"; state: PipelineSideState }
  | { kind: "excluded"; reason: PipelineExclusionReason };

// ============================================
// TERMIN → STUFE (frühe Stufen, VOR Topf-Split)
// ============================================

export interface AppointmentPipelineInput {
  /** Persistierter Termin-Status (oder abgeleitetes `expired_unsigned`). */
  status: AppointmentStatus;
  /**
   * Ergebnis der SSoT `isAppointmentDocumentedAndSigned` (Termin `completed`
   * UND direkte- oder Leistungsnachweis-Unterschrift). Wird hier NICHT neu
   * abgeleitet, sondern vom Aufrufer aus der SSoT übernommen.
   */
  documentedAndSigned: boolean;
  /**
   * True, wenn der Termin bereits über eine nicht-stornierte Rechnung
   * abgerechnet ist. Dann verlässt er die Termin-Stufen und sein € lebt auf
   * der Rechnung (Hybrid-Einheit, Q1/D1).
   */
  isInvoiced: boolean;
}

/**
 * Ordnet einen Termin GENAU einem Pipeline-Ausgang zu (total + disjunkt).
 *
 * | Quelle                                   | Ausgang                       |
 * | ---------------------------------------- | ----------------------------- |
 * | `scheduled` / `documenting`              | Stufe „Offen"                 |
 * | `completed`, kein signierter LN          | Stufe „Dokumentiert"          |
 * | `completed` + signierter LN              | Stufe „Unterschrieben"        |
 * | bereits abgerechnet                      | excluded „invoiced"           |
 * | `cancelled`                              | excluded „cancelled"          |
 * | `customer_no_show`                       | Side „Kunde nicht angetroffen"|
 * | `expired_unsigned` (abgeleitet)          | Side „Nicht abgerechnet"      |
 */
export function assignAppointmentStage(input: AppointmentPipelineInput): PipelineAssignment {
  const { status } = input;

  // Terminale Side-/Excluded-Zustände haben Vorrang vor „abgerechnet?",
  // damit ein stornierter/No-Show-Termin nie als Umsatz erscheint.
  if (status === "cancelled") return { kind: "excluded", reason: "cancelled" };
  if (status === "customer_no_show") return { kind: "side", state: "kunde_nicht_angetroffen" };
  if (status === "expired_unsigned") return { kind: "side", state: "nicht_abgerechnet" };

  // Abgerechnete Termine: € lebt auf der Rechnung (keine Doppelzählung).
  if (input.isInvoiced) return { kind: "excluded", reason: "invoiced" };

  if (status === "scheduled" || status === "documenting") {
    return { kind: "stage", stage: "offen" };
  }
  // status === "completed"
  return input.documentedAndSigned
    ? { kind: "stage", stage: "unterschrieben" }
    : { kind: "stage", stage: "dokumentiert" };
}

// ============================================
// RECHNUNG → STUFE (späte Stufen, NACH Topf-Split)
// ============================================

export interface InvoicePipelineInput {
  /** Rechnungs-Status (`INVOICE_STATUSES`). */
  status: string;
  /** Rechnungs-Typ (`INVOICE_TYPES`): rechnung | stornorechnung | nachberechnung. */
  invoiceType: string;
}

/**
 * Ordnet eine Rechnung GENAU einem Pipeline-Ausgang zu (total + disjunkt).
 *
 * Stornierte Rechnungen (`status='storniert'`) und Gutschriften
 * (`invoiceType='stornorechnung'`) sind Side-Zustand „Storniert" und tragen
 * nicht in die Stufen-Summen ein (konsistent mit dem Default „Stornos
 * ausblenden" und der Umsatz-Statistik, die stornierte Rechnungen ausschließt).
 */
export function assignInvoiceStage(input: InvoicePipelineInput): PipelineAssignment {
  if (input.status === "storniert" || input.invoiceType === "stornorechnung") {
    return { kind: "side", state: "storniert" };
  }
  switch (input.status) {
    case "entwurf":
      return { kind: "stage", stage: "rechnung_erstellt" };
    case "versendet":
      return { kind: "stage", stage: "versendet" };
    case "avis_erhalten":
      return { kind: "stage", stage: "avis_erhalten" };
    case "bezahlt":
      return { kind: "stage", stage: "bezahlt" };
    default:
      // Unbekannter Status: konservativ als „Rechnung erstellt" behandeln,
      // damit die Zuordnung total bleibt (kein stiller Verlust eines €).
      return { kind: "stage", stage: "rechnung_erstellt" };
  }
}

// ============================================
// AGING-AMPEL (Q5) — drei getrennte Modelle, pur berechnet
// ============================================

export type AgingBucket = "none" | "green" | "yellow" | "orange" | "red";

/**
 * Aging-Modell je Karten-/Rechnungs-Kontext:
 *  - `selbstzahler`        — Anker `dueDate` (4 Stufen inkl. Mahnstufen).
 *  - `pflegekasse_pre_avis`— Anker `versendetAm` (vor Avis-Eingang).
 *  - `pflegekasse_post_avis`— Anker `avisErhaltenAm` (nach Avis, vor Zahlung).
 */
export type AgingModel = "selbstzahler" | "pflegekasse_pre_avis" | "pflegekasse_post_avis";

/** Ganztägige Differenz `asOf - anchor` in Tagen (kann negativ sein). */
export function daysBetweenIso(anchorIso: string, asOfIso: string): number {
  const anchor = parseLocalDate(anchorIso);
  const asOf = parseLocalDate(asOfIso);
  const a = Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const b = Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/**
 * Ordnet einen Aging-Bucket zu (pure). `anchorIso === null` ⇒ `none`
 * (z. B. eine noch nicht versendete Pflegekassen-Rechnung hat keinen
 * `versendetAm`-Anker).
 */
export function resolveAgingBucket(
  model: AgingModel,
  anchorIso: string | null,
  asOfIso: string,
): AgingBucket {
  if (!anchorIso) return "none";
  const days = daysBetweenIso(anchorIso, asOfIso);
  switch (model) {
    case "selbstzahler":
      // Anker = Fälligkeitsdatum. days = Tage ÜBER Fälligkeit.
      if (days <= 0) return "green"; // 0–14 T vor Fälligkeit (und früher)
      if (days <= 14) return "yellow"; // 1–14 T über (Erinnerung)
      if (days <= 30) return "orange"; // 15–30 T (Mahnstufe 1)
      return "red"; // 31+ T (Mahnstufe 2/Inkasso)
    case "pflegekasse_pre_avis":
      // Anker = Versanddatum.
      if (days <= 21) return "green";
      if (days <= 45) return "yellow"; // nachhaken
      return "red"; // Eskalation
    case "pflegekasse_post_avis":
      // Anker = Avis-Eingangsdatum.
      if (days <= 14) return "green";
      if (days <= 30) return "yellow";
      return "red";
  }
}

// ============================================
// €-KONSERVIERUNG (Q1) — pure Aggregation
// ============================================

/** Eine Atomic-Unit mit ihrer Zuordnung + ihrem €-Beitrag (Integer-Cents). */
export interface PipelineAtomicUnit {
  assignment: PipelineAssignment;
  cents: number;
}

export interface PipelineCentsSummary {
  /** €-Summe pro Pipeline-Stufe (Integer-Cents). */
  stageCents: Record<PipelineStage, number>;
  /** €-Summe pro Side-Badge (Integer-Cents). */
  sideCents: Record<PipelineSideState, number>;
  /** Σ über alle Stufen (ohne Side-Badges). */
  stageTotalCents: number;
  /** Σ über alle Side-Badges. */
  sideTotalCents: number;
  /** Σ Stufen + Side-Badges = Gesamtumsatz-Sicht (Q1). */
  grandTotalCents: number;
}

function emptyStageRecord(): Record<PipelineStage, number> {
  return PIPELINE_STAGES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<PipelineStage, number>,
  );
}

function emptySideRecord(): Record<PipelineSideState, number> {
  return PIPELINE_SIDE_STATES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<PipelineSideState, number>,
  );
}

/**
 * Aggregiert Atomic-Units zu €-Summen je Stufe/Side-Badge. Jede Einheit trägt
 * ihren € zu GENAU einem Topf bei (Stufe ODER Side); `excluded`-Einheiten
 * tragen nichts bei (ihr € lebt anderswo). Damit gilt per Konstruktion die
 * €-Konservierung „jeder € in genau einer Stufe".
 */
export function summarizePipelineCents(units: PipelineAtomicUnit[]): PipelineCentsSummary {
  const stageCents = emptyStageRecord();
  const sideCents = emptySideRecord();
  for (const unit of units) {
    if (unit.assignment.kind === "stage") {
      stageCents[unit.assignment.stage] += unit.cents;
    } else if (unit.assignment.kind === "side") {
      sideCents[unit.assignment.state] += unit.cents;
    }
    // excluded: kein €-Beitrag
  }
  const stageTotalCents = PIPELINE_STAGES.reduce((sum, s) => sum + stageCents[s], 0);
  const sideTotalCents = PIPELINE_SIDE_STATES.reduce((sum, s) => sum + sideCents[s], 0);
  return {
    stageCents,
    sideCents,
    stageTotalCents,
    sideTotalCents,
    grandTotalCents: stageTotalCents + sideTotalCents,
  };
}
