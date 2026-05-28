export interface BillingCustomerItem {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  billingType: string;
  status: string;
  // Task #576: Partial-Signing-Sichtbarkeit im „Neue Rechnung
  // erstellen"-Dropdown. `completedAppointments` = Anzahl dokumentierter
  // Termine (`status = 'completed'`) im gewählten Monat,
  // `coveredAppointments` = Anzahl davon, die durch einen aktiven LN
  // abgedeckt sind. Differenz > 0 deutet auf Partial-Signing hin
  // (Hinweis im UI, dass evtl. ein zweiter LN nötig ist).
  completedAppointments: number;
  coveredAppointments: number;
}

export interface InvoiceItem {
  id: number;
  invoiceNumber: string;
  customerId: number;
  billingType: string;
  invoiceType: string;
  billingMonth: number;
  billingYear: number;
  recipientName: string;
  // Task #533: Kunden-Name (Vor-/Nachname) zusätzlich zur Empfängerzeile —
  // wird auf der Rechnungs-Karte angezeigt, damit der Kundenbezug auch bei
  // Pflegekassen-Rechnungen (Empfänger = Kasse) auf den ersten Blick sichtbar ist.
  customerName: string;
  customerVorname: string | null;
  customerNachname: string | null;
  netAmountCents: number;
  vatAmountCents: number;
  grossAmountCents: number;
  vatRate: number | null;
  status: string;
  // Task #533: Versanddatum für Listenanzeige (Badge „Versendet seit ...").
  sentAt: string | null;
  // Task #546: PDF-Persistierungs-Status. `pdfPath` ist NULL solange das
  // Hintergrund-Rendering läuft (oder fehlgeschlagen ist); `createdAt` dient
  // dem Frontend zur Unterscheidung zwischen „noch in Arbeit" und „Fehler".
  pdfPath: string | null;
  createdAt: string;
  // Task #759: Rechnungs-Split pro Budget-Topf. `billingRunId` gruppiert
  // alle Geschwister-Rechnungen eines Multi-Pot-Laufs (uuid). `budgetType`
  // identifiziert den konkreten Topf (NULL = Selbstzahler oder Single-Pot-
  // Bestand vor #759).
  billingRunId: string | null;
  budgetType: string | null;
}

interface InvoiceLineItem {
  id: number;
  appointmentDate: string;
  serviceDescription: string;
  serviceCode: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  // Task #572: Anzeige-Menge + Einheit, damit das Frontend dieselbe Quelle
  // wie PDF und ZUGFeRD nutzt (verhindert km-Drift „Menge × Satz ≠ Summe").
  // NULL für historische Zeilen vor Task #561 — der Frontend-Helper
  // `renderLineItemQuantity` fällt dann auf `durationMinutes` zurück.
  quantityRaw: number | null;
  quantityUnit: "hours" | "km" | null;
  totalCents: number;
  unitPriceCents: number;
  employeeName: string | null;
}

export interface InvoiceDetail extends InvoiceItem {
  lineItems: InvoiceLineItem[];
  // Task #522: Drift-Indikatoren — true, wenn die Live-Daten nicht mehr zum
  // Fingerprint des persistierten Rechnungs- bzw. Leistungsnachweis-PDFs passen.
  pdfDrift?: boolean;
  leistungsnachweisDrift?: boolean;
}

export interface DeliveryRecord {
  id: number;
  deliveryMethod: string;
  status: string;
  recipientEmail: string | null;
  recipientName: string | null;
  recipientAddress: string | null;
  documentFileNames: string | null;
  sentAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  letterxpressLetterId: string | null;
}

// Task #750: Vorschau im „Neue Rechnung erstellen"-Dialog. Wird vom selben
// Helper berechnet (`buildInvoiceDraft`) wie `POST /billing/generate`,
// damit angezeigte Werte und finale Rechnungssumme nicht driften können.
export interface BillingInvoicePreview {
  // Anzahl unterschriebener Leistungsnachweise im Zeitraum.
  serviceRecordCount: number;
  // Termine, die tatsächlich abgerechnet werden (nach Filter „bereits abgerechnet").
  coveredAppointments: number;
  // Dokumentierte Termine (`status = 'completed'`) im Monat — Sekundärwert
  // für den Partial-Signing-Hinweis im UI.
  completedAppointments: number;
  // Brutto-Summe über alle entstehenden Folge-Rechnungen
  // (bei Budget-Split: Kasse + Privat).
  totalCents: number;
  // True, wenn der Generate-Aufruf in zwei Rechnungen (Kassenanteil + Privatanteil) aufspaltet.
  splitInvoices: boolean;
}

export interface GenerateInvoiceResponse {
  splitInvoices?: boolean;
  invoices?: { id: number }[];
  message?: string;
}

export interface SendInvoiceResponse {
  message: string;
  invoice?: InvoiceItem;
  results?: { invoiceId: number; status: string; recipientEmail: string; customerCopy?: boolean }[];
}

export interface BatchSendInvoiceResponse {
  message: string;
  summary: { sent: number; errors: number; skipped: number; total: number };
  results: { invoiceId: number; invoiceNumber: string; status: string; error?: string; recipientEmail?: string }[];
}

// Task #534: Typenübergreifender Bulk-Versand. Pflegekassen-Entwürfe werden
// manuell als „versendet" markiert (kein TI-Anschluss), Selbstzahler-Entwürfe
// erhalten den Status „versendet" über den regulären Status-Pfad.
// Krankenkassen-Filter: Liste der Pflegekassen, die im gewählten Monat/Jahr
// mindestens eine Rechnung haben. Wird im Filter-Dropdown der
// Abrechnungs-Seite angezeigt; `invoiceCount` dient als Hilfs-Label.
export interface PayerSummary {
  insuranceProviderId: number;
  name: string;
  invoiceCount: number;
}

export interface BulkSendInvoiceResponse {
  summary: {
    total: number;
    sent: number;
    markedSent: number;
    skipped: number;
    errors: number;
  };
  results: Array<{
    invoiceId: number;
    invoiceNumber: string;
    customerId: number;
    billingType: string;
    status: "sent" | "marked_sent" | "skipped" | "error";
    message?: string;
  }>;
}
