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
  grossAmountCents: number;
  status: string;
}

interface InvoiceLineItem {
  id: number;
  appointmentDate: string;
  serviceDescription: string;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  totalCents: number;
  employeeName: string | null;
}

export interface InvoiceDetail extends InvoiceItem {
  lineItems: InvoiceLineItem[];
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
