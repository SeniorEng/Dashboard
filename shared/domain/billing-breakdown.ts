/**
 * Task #1453 — Abrechnungs-Breakdown (Phase 1): Leistungsart-Aufschlüsselung.
 *
 * PURE Domänen-Schicht für die Breakdown-Tabelle auf `/admin/billing`. Sie
 * KOMPONIERT die bestehenden SSoTs statt sie zu duplizieren:
 *  - Stufen-Zuordnung (Termin/Rechnung): `assignAppointmentStage` /
 *    `assignInvoiceStage` aus `billing-pipeline.ts` — dieselbe Hybrid-Bruchkante,
 *    damit jeder € genau einmal gezählt wird (keine Doppelzählung).
 *  - €-Konservierung: die Breakdown-Summe entspricht per Konstruktion exakt der
 *    Stufen-Summe der Pipeline (`summarizePipelineCents().stageTotalCents`), weil
 *    nur `stage`-Einheiten in die Tabelle einfließen.
 *  - km-Quantisierung: `quantizeKm` aus `invoice-line-items.ts` (km roh
 *    transportiert, erst bei der Anzeige quantisiert — kein doppeltes Runden).
 *  - Leistungsart (Hauswirtschaft/Alltagsbegleitung): `SERVICE_CATALOG`
 *    (`shared/config/services.ts`) als einzige Quelle der `lohnartKategorie`.
 *
 * Hintergrund (0,0h-Bug): die appointment-basierte Stunden-Aggregation liest
 * Stunden NUR aus Terminen mit Status `completed`/`documented`. Sobald ein
 * Termin abgerechnet ist, verlässt er die Termin-Stufen — seine Stunden tauchen
 * dann nirgends mehr auf (0,0h). Die Late-Stage-Stunden kommen daher aus
 * `invoice_line_items.duration_minutes` (`computeMinutesByInvoiceStage`),
 * während die Early-Stage-Stunden weiterhin aus den (noch nicht abgerechneten)
 * Terminen stammen. Die explizite Stufen-Zuordnung verhindert, dass dieselbe
 * Arbeit doppelt gezählt wird.
 *
 * Geldbeträge sind ausnahmslos Integer-Cents.
 */
import { SERVICE_CATALOG } from "../config/services";
import { isKmLineItem, quantizeKm } from "./invoice-line-items";
import {
  assignAppointmentStage,
  assignInvoiceStage,
  type PipelineAssignment,
} from "./billing-pipeline";

// ============================================
// LEISTUNGSART-KLASSIFIKATION
// ============================================

/**
 * Leistungsart einer abgerechneten/geplanten Position. `km` ist die
 * Anfahrts-/Customer-Kilometer-Strecke (eigene Spalte „Summe km"), `sonstige`
 * sammelt alles, was weder Hauswirtschaft/Alltagsbegleitung noch km ist (z. B.
 * No-Show-Pauschalen) — ihr € zählt mit, aber sie erscheinen in keiner der
 * Stunden-Spalten.
 */
export type ServiceCategory = "hauswirtschaft" | "alltagsbegleitung" | "km" | "sonstige";

/**
 * Ordnet einen Service-Code GENAU einer Leistungsart zu. km-Codes
 * (`travel_km`/`customer_km`) haben Vorrang; Stunden-Services mit
 * `lohnartKategorie` Hauswirtschaft/Alltagsbegleitung werden anhand des
 * `SERVICE_CATALOG` aufgelöst. Unbekannte/flache Codes → `sonstige`.
 */
export function categorizeServiceCode(serviceCode: string | null | undefined): ServiceCategory {
  if (isKmLineItem(serviceCode)) return "km";
  if (!serviceCode) return "sonstige";
  const entry = SERVICE_CATALOG.find((e) => e.code === serviceCode);
  if (
    entry &&
    entry.unitType === "hours" &&
    (entry.lohnartKategorie === "hauswirtschaft" || entry.lohnartKategorie === "alltagsbegleitung")
  ) {
    return entry.lohnartKategorie;
  }
  return "sonstige";
}

// ============================================
// MINUTEN/KM-AGGREGAT EINER EINHEIT
// ============================================

/** Minuten je Leistungsart + rohe (noch nicht quantisierte) km-Strecke. */
export interface CategoryBreakdown {
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  /** Summe der rohen km-Strecke (erst bei der Anzeige via `quantizeKm` gerundet). */
  kmRaw: number;
  /** Minuten, die in keiner der beiden Stunden-Spalten erscheinen. */
  sonstigeMinutes: number;
}

export function emptyCategoryBreakdown(): CategoryBreakdown {
  return { hauswirtschaftMinutes: 0, alltagsbegleitungMinutes: 0, kmRaw: 0, sonstigeMinutes: 0 };
}

/** Eine persistierte Rechnungs-Line für die Minuten-Aggregation. */
export interface InvoiceLineMinutesInput {
  serviceCode: string | null;
  durationMinutes: number;
  /** Bei km-Lines die quantisierte Strecke (Task #561); sonst optional. */
  quantityRaw?: number | null;
}

/**
 * FIX des 0,0h-Bugs: aggregiert die `duration_minutes` (und km) der Line-Items
 * EINER Rechnung (= einer späten Pipeline-Stufe) zur Leistungsart-Aufstellung.
 * Hauswirtschaft/Alltagsbegleitung tragen ihre Minuten bei, km-Lines die rohe
 * Strecke, alles andere die `sonstige`-Minuten (ohne Stunden-Spalte).
 */
export function computeMinutesByInvoiceStage(
  lines: readonly InvoiceLineMinutesInput[],
): CategoryBreakdown {
  const out = emptyCategoryBreakdown();
  for (const li of lines) {
    const category = categorizeServiceCode(li.serviceCode);
    switch (category) {
      case "km":
        out.kmRaw += li.quantityRaw ?? 0;
        break;
      case "hauswirtschaft":
        out.hauswirtschaftMinutes += li.durationMinutes;
        break;
      case "alltagsbegleitung":
        out.alltagsbegleitungMinutes += li.durationMinutes;
        break;
      default:
        out.sonstigeMinutes += li.durationMinutes;
        break;
    }
  }
  return out;
}

// ============================================
// BREAKDOWN-EINHEITEN + GRUPPIERUNG
// ============================================

export const BREAKDOWN_DIMENSIONS = ["kunde", "kasse"] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

/**
 * Eine Quell-Einheit der Breakdown-Berechnung: trägt ihre Pipeline-Zuordnung
 * (Stufe/Side/excluded), ihren €-Beitrag und ihre Leistungsart-Minuten. Nur
 * `stage`-Einheiten fließen weiter — dadurch ist die €-Summe per Konstruktion
 * identisch zur Stufen-Summe der Pipeline (keine Doppelzählung).
 */
export interface BreakdownSourceUnit {
  assignment: PipelineAssignment;
  customerId: number;
  customerName: string;
  billingType: string;
  cents: number;
  category: CategoryBreakdown;
}

/**
 * Eine vor-aggregierte Breakdown-Einheit pro (Kunde × Abrechnungstyp). Dies ist
 * die Transport-Form (Server → Client). km wird ROH geführt (`kmRaw`) und erst
 * in `groupBillingBreakdown` quantisiert.
 */
export interface AggregatedBreakdownUnit {
  customerId: number;
  customerName: string;
  billingType: string;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  kmRaw: number;
  totalCents: number;
}

/**
 * Filtert die Quell-Einheiten auf `stage` und aggregiert sie pro
 * (Kunde × Abrechnungstyp). Side-/excluded-Einheiten tragen nichts bei — exakt
 * wie `summarizePipelineCents` nur die Stufen-Summe bildet.
 */
export function aggregateBreakdownUnits(
  sources: readonly BreakdownSourceUnit[],
): AggregatedBreakdownUnit[] {
  const acc = new Map<string, AggregatedBreakdownUnit>();
  for (const unit of sources) {
    if (unit.assignment.kind !== "stage") continue;
    const key = `${unit.customerId}|${unit.billingType}`;
    const existing = acc.get(key);
    if (existing) {
      existing.hauswirtschaftMinutes += unit.category.hauswirtschaftMinutes;
      existing.alltagsbegleitungMinutes += unit.category.alltagsbegleitungMinutes;
      existing.kmRaw += unit.category.kmRaw;
      existing.totalCents += unit.cents;
    } else {
      acc.set(key, {
        customerId: unit.customerId,
        customerName: unit.customerName,
        billingType: unit.billingType,
        hauswirtschaftMinutes: unit.category.hauswirtschaftMinutes,
        alltagsbegleitungMinutes: unit.category.alltagsbegleitungMinutes,
        kmRaw: unit.category.kmRaw,
        totalCents: unit.cents,
      });
    }
  }
  return Array.from(acc.values());
}

/** Eine Zeile der Breakdown-Tabelle (Kunde ODER Kasse, je nach Dimension). */
export interface BreakdownRow {
  /** Stabiler Render-Key (`cust-<id>` bzw. `kasse-<billingType>`). */
  key: string;
  label: string;
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  /** Quantisierte Summe der km-Strecke (2 Nachkommastellen). */
  kmQuantized: number;
  totalCents: number;
}

export const BILLING_TYPE_BREAKDOWN_LABELS: Record<string, string> = {
  selbstzahler: "Selbstzahler",
  pflegekasse_gesetzlich: "Pflegekasse (gesetzlich)",
  pflegekasse_privat: "Pflegekasse (privat)",
  privat: "Privat",
};

function dimensionKeyAndLabel(
  unit: AggregatedBreakdownUnit,
  dimension: BreakdownDimension,
): { key: string; label: string } {
  if (dimension === "kasse") {
    return {
      key: `kasse-${unit.billingType}`,
      label: BILLING_TYPE_BREAKDOWN_LABELS[unit.billingType] ?? unit.billingType,
    };
  }
  return { key: `cust-${unit.customerId}`, label: unit.customerName };
}

/**
 * Gruppiert die vor-aggregierten Einheiten nach Kunde oder Kasse zu
 * Tabellenzeilen. km wird ROH summiert und erst hier quantisiert (kein
 * doppeltes Runden). Zeilen sind absteigend nach € sortiert.
 */
export function groupBillingBreakdown(
  units: readonly AggregatedBreakdownUnit[],
  dimension: BreakdownDimension,
): BreakdownRow[] {
  const acc = new Map<
    string,
    { label: string; hw: number; ab: number; kmRaw: number; cents: number }
  >();

  for (const unit of units) {
    const { key, label } = dimensionKeyAndLabel(unit, dimension);
    const row = acc.get(key) ?? { label, hw: 0, ab: 0, kmRaw: 0, cents: 0 };
    row.hw += unit.hauswirtschaftMinutes;
    row.ab += unit.alltagsbegleitungMinutes;
    row.kmRaw += unit.kmRaw;
    row.cents += unit.totalCents;
    acc.set(key, row);
  }

  return Array.from(acc.entries())
    .map(([key, r]) => ({
      key,
      label: r.label,
      hauswirtschaftMinutes: r.hw,
      alltagsbegleitungMinutes: r.ab,
      kmQuantized: quantizeKm(r.kmRaw),
      totalCents: r.cents,
    }))
    .sort((a, b) => b.totalCents - a.totalCents || a.label.localeCompare(b.label, "de"));
}

/** Spalten-Summen über alle Zeilen (Tabellen-Fuß). */
export interface BreakdownTotals {
  hauswirtschaftMinutes: number;
  alltagsbegleitungMinutes: number;
  kmQuantized: number;
  totalCents: number;
}

export function summarizeBreakdownRows(rows: readonly BreakdownRow[]): BreakdownTotals {
  let hw = 0;
  let ab = 0;
  let kmQuantized = 0;
  let cents = 0;
  for (const row of rows) {
    hw += row.hauswirtschaftMinutes;
    ab += row.alltagsbegleitungMinutes;
    kmQuantized += row.kmQuantized;
    cents += row.totalCents;
  }
  return {
    hauswirtschaftMinutes: hw,
    alltagsbegleitungMinutes: ab,
    kmQuantized: quantizeKm(kmQuantized),
    totalCents: cents,
  };
}

// Re-export der Stufen-Helfer, damit Aufrufer (Reader/Test) dieselbe SSoT
// importieren wie diese Datei — kein zweiter Importpfad.
export { assignAppointmentStage, assignInvoiceStage };
