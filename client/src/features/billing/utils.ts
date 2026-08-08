import { formatEuroDE } from "@shared/utils/money";
import type { BillingCustomerItem, InvoiceItem } from "@shared/api";
import {
  agingModelForBillingType,
  assignInvoiceActionCluster,
  resolveAgingBucket,
  type AgingBucket,
  type InvoiceActionCluster,
  isAgingCluster,
} from "@shared/domain/billing-pipeline";
import { PDF_PENDING_THRESHOLD_MS } from "./constants";

export function formatAmount(cents: number): string {
  return formatEuroDE(cents);
}

// Task #1444: Minuten → Stunden-Anzeige (eine Nachkommastelle, DE-Komma) für
// die Cockpit-Trichterleiste. Reine Darstellung, keine Geld-/Domänen-Mathematik.
export function formatHoursFromMinutes(minutes: number): string {
  const hours = minutes / 60;
  return `${hours.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
}

// Task #1473: Kilometer-Anzeige (DE-Komma, max. 1 NK) für die Economics-Tabelle.
// Reine Darstellung — die km-Mengen kommen fertig aus dem Reader.
export function formatKm(km: number): string {
  return `${km.toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
}

// Task #1473: Anzeige-Satz pro Einheit (Integer-Cents → "38,00 €" / "0,35 €").
// Reine Darstellung; delegiert an die Geld-SSoT formatEuroDE.
export function formatRate(cents: number): string {
  return formatEuroDE(cents);
}

// Task #1473: Margen-Gesundheits-Farbe (ganze Prozent): ≥50 grün, 35–49 amber,
// <35 rosé. Reine Darstellung der bereits berechneten Marge.
export function marginHealthTextColor(percent: number): string {
  if (percent >= 50) return "text-green-700";
  if (percent >= 35) return "text-amber-700";
  return "text-rose-700";
}

// Task #1412: Heutiger Stichtag als ISO yyyy-mm-dd (lokale Zeitzone), Anker für
// die Aging-Einstufung.
function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Task #1412: Handlungs-Cluster einer Rechnung (reine SICHT auf Status + Zahler-
// Typ). Delegiert an die SSoT `assignInvoiceActionCluster` (shared).
export function invoiceActionCluster(inv: InvoiceItem): InvoiceActionCluster {
  return assignInvoiceActionCluster({
    status: inv.status,
    invoiceType: inv.invoiceType,
    billingType: inv.billingType,
    // #1897 — die Zahlungsbindung kommt vom Listen-Endpunkt (GET /api/billing/).
    // Fehlt sie (aeltere Antwort, anderer Aufrufer), bleibt die Zuordnung exakt
    // die alte: `undefined` wird in der SSoT wie `false` behandelt.
    hasBoundPayment: inv.hasBoundPayment,
  });
}

// Task #1412: Aging-Bucket einer Rechnung — nur in den wartenden Clustern (Avis-
// /Zahlung-ausstehend) relevant; sonst `none`. Spiegelt EXAKT die Anker-Wahl des
// Pipeline-Readers: Selbstzahler/Privat → Fälligkeitsdatum (`dueDate`),
// Pflegekasse → Versanddatum (`sentAt`).
export function invoiceAgingBucket(inv: InvoiceItem, asOfIso: string = todayIso()): AgingBucket {
  // #1897 — dieselbe Funktion, die der Cockpit-Reader liest
  // (`server/storage/billing/pipeline-reader.ts`). Vorher stand die
  // Cluster-Aufzaehlung hier doppelt; driftete eine Seite, mahnte genau eine
  // von beiden weiter.
  const cluster = invoiceActionCluster(inv);
  if (!isAgingCluster(cluster)) return "none";
  const model = agingModelForBillingType(inv.billingType);
  const anchorIso =
    model === "selbstzahler"
      ? inv.dueDate ?? null
      : inv.sentAt
        ? inv.sentAt.slice(0, 10)
        : null;
  return resolveAgingBucket(model, anchorIso, asOfIso);
}

export function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

export function getCustomerName(c: BillingCustomerItem): string {
  return c.vorname && c.nachname ? `${c.vorname} ${c.nachname}` : c.name;
}

export function getInvoiceCustomerDisplayName(inv: InvoiceItem): string {
  if (inv.customerVorname && inv.customerNachname) {
    return `${inv.customerVorname} ${inv.customerNachname}`;
  }
  return inv.customerName || "";
}

export function getPdfStatus(invoice: InvoiceItem): "ok" | "pending" | "error" {
  if (invoice.pdfPath) return "ok";
  const createdAt = invoice.createdAt ? new Date(invoice.createdAt).getTime() : NaN;
  if (Number.isNaN(createdAt)) return "pending";
  return Date.now() - createdAt > PDF_PENDING_THRESHOLD_MS ? "error" : "pending";
}

export function formatSentAt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// #1897 — Beschriftung des Zahlungs-Badges. Bewusst hier und nicht in der
// Zeile: dieselbe Formulierung wird im Cockpit gebraucht, sobald dort die
// Zahlungsbindung angezeigt wird, und eine zweite Fassung würde sofort
// auseinanderlaufen.
//
// Die Klassifikation kommt aus der SSoT (`paymentDifferenceResult`), es wird
// hier NICHT neu gegen Beträge verglichen. `tolerated` heißt: innerhalb der
// 100-Cent-Toleranz, fachlich gedeckt — deshalb dieselbe Aussage wie `exact`,
// nur mit dem Zusatz im Tooltip.
export function paymentBadgeLabel(
  inv: InvoiceItem,
  formatAmount: (cents: number) => string,
): string {
  const paid = inv.boundPaidCents;
  if (paid === undefined) return "Zahlung zugeordnet";
  const betrag = formatAmount(paid);
  const diff = inv.paymentDifferenceCents ?? 0;
  switch (inv.paymentDifferenceResult) {
    case "exact":
    case "tolerated":
      return `Zahlung ${betrag} · gedeckt`;
    case "underpaid":
      return `Zahlung ${betrag} · ${formatAmount(diff)} fehlen`;
    case "overpaid":
      return `Zahlung ${betrag} · ${formatAmount(Math.abs(diff))} zu viel`;
    default:
      return `Zahlung ${betrag}`;
  }
}

/** Erklärt im Tooltip, was der Zustand für die Bearbeitung bedeutet. */
export function paymentBadgeTitle(inv: InvoiceItem): string {
  switch (inv.paymentDifferenceResult) {
    case "exact":
      return "Zahlungseingang deckt den Rechnungsbetrag exakt — kann freigegeben werden.";
    case "tolerated":
      return "Zahlungseingang deckt den Rechnungsbetrag innerhalb der Toleranz (bis 1,00 €) — kann freigegeben werden.";
    case "underpaid":
      return "Zahlungseingang deckt den Rechnungsbetrag noch nicht vollständig.";
    case "overpaid":
      return "Es ist mehr eingegangen als berechnet — bitte klären, nicht still als bezahlt buchen.";
    default:
      return "Eine Zahlung ist dieser Rechnung zugeordnet.";
  }
}
