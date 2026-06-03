import { formatEuroDE } from "@shared/utils/money";
import type { BillingCustomerItem, InvoiceItem } from "@shared/api";
import { PDF_PENDING_THRESHOLD_MS } from "./constants";

export function formatAmount(cents: number): string {
  return formatEuroDE(cents);
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
