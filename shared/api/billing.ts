export interface BillingCustomerItem {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  billingType: string;
  status: string;
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
}

interface InvoiceLineItem {
  id: number;
  appointmentDate: string;
  serviceDescription: string;
  serviceCode: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  totalCents: number;
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
