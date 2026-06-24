import { formatEuroDE } from "@shared/utils/money";
import type { BillingCustomerItem, InvoiceItem } from "@shared/api";
import {
  agingModelForBillingType,
  assignInvoiceActionCluster,
  resolveAgingBucket,
  type AgingBucket,
  type InvoiceActionCluster,
} from "@shared/domain/billing-pipeline";
import { PDF_PENDING_THRESHOLD_MS } from "./constants";

export function formatAmount(cents: number): string {
  return formatEuroDE(cents);
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
  });
}

// Task #1412: Aging-Bucket einer Rechnung — nur in den wartenden Clustern (Avis-
// /Zahlung-ausstehend) relevant; sonst `none`. Spiegelt EXAKT die Anker-Wahl des
// Pipeline-Readers: Selbstzahler/Privat → Fälligkeitsdatum (`dueDate`),
// Pflegekasse → Versanddatum (`sentAt`).
export function invoiceAgingBucket(inv: InvoiceItem, asOfIso: string = todayIso()): AgingBucket {
  const cluster = invoiceActionCluster(inv);
  if (cluster !== "avis_ausstehend" && cluster !== "zahlung_ausstehend") return "none";
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
