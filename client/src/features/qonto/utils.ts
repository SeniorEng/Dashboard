import { formatEuroDE } from "@shared/utils/money";

export function formatCents(cents: number): string {
  return formatEuroDE(cents);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Task #1672 — Confidence-Badge für eine zugeordnete Transaktion. „weak" (Betrag
 * allein) ⇒ „prüfen"-Ton, damit unsichere Auto-Treffer sichtbar sind. Unbekannte
 * Werte fallen neutral auf „automatisch" zurück.
 */
export function confidenceBadge(confidence: string | null): {
  label: string;
  className: string;
  weak: boolean;
} {
  switch (confidence) {
    case "auto_exact":
      return { label: "Auto · exakt", className: "bg-green-50 text-green-700 border-green-200", weak: false };
    case "auto_number":
      return { label: "Auto · Rechnungsnr.", className: "bg-green-50 text-green-700 border-green-200", weak: false };
    case "auto_bulk_advice":
      return { label: "Auto · Sammel-Avis", className: "bg-teal-50 text-teal-700 border-teal-200", weak: false };
    case "auto_amount":
      return { label: "Auto · nur Betrag · prüfen", className: "bg-amber-50 text-amber-700 border-amber-200", weak: true };
    case "auto_amount_review":
      // Task #1864 — reiner Betrags-Treffer OHNE bestätigendes Merkmal: gebunden,
      // aber NICHT bezahlt; muss vom Admin bestätigt oder abgelehnt werden.
      return { label: "Auto · nur Betrag · Bestätigung nötig", className: "bg-amber-50 text-amber-700 border-amber-200", weak: true };
    case "manual":
      return { label: "Manuell", className: "bg-sky-50 text-sky-700 border-sky-200", weak: false };
    case "manual_bulk":
      // Task #1710 — manuelle Mehrfach-Zuordnung mehrerer Rechnungen zu einer Zahlung.
      return { label: "Manuell · Sammel", className: "bg-sky-50 text-sky-700 border-sky-200", weak: false };
    default:
      return { label: "Automatisch", className: "bg-gray-50 text-gray-600 border-gray-200", weak: false };
  }
}
