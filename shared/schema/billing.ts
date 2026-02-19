import { pgTable, text, integer, serial, index, unique } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";
import { appointments } from "./appointments";

export const INVOICE_STATUSES = ["entwurf", "versendet", "bezahlt", "storniert"] as const;
export type InvoiceStatus = typeof INVOICE_STATUSES[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  entwurf: "Entwurf",
  versendet: "Versendet",
  bezahlt: "Bezahlt",
  storniert: "Storniert",
};

export const INVOICE_TYPES = ["rechnung", "stornorechnung", "nachberechnung"] as const;
export type InvoiceType = typeof INVOICE_TYPES[number];

export const INVOICE_TYPE_LABELS: Record<InvoiceType, string> = {
  rechnung: "Rechnung",
  stornorechnung: "Stornorechnung",
  nachberechnung: "Nachberechnung",
};

export const BILLING_TYPES = ["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"] as const;
export type BillingType = typeof BILLING_TYPES[number];

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull().unique(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  billingType: text("billing_type").notNull(),
  invoiceType: text("invoice_type").notNull(),
  billingMonth: integer("billing_month").notNull(),
  billingYear: integer("billing_year").notNull(),
  recipientName: text("recipient_name").notNull(),
  recipientAddress: text("recipient_address"),
  customerName: text("customer_name"),
  insuranceProviderName: text("insurance_provider_name"),
  insuranceIkNummer: text("insurance_ik_nummer"),
  versichertennummer: text("versichertennummer"),
  pflegegrad: integer("pflegegrad"),
  netAmountCents: integer("net_amount_cents").notNull().default(0),
  vatAmountCents: integer("vat_amount_cents").notNull().default(0),
  grossAmountCents: integer("gross_amount_cents").notNull().default(0),
  vatRate: integer("vat_rate"),
  status: text("status").notNull().default("entwurf"),
  stornierteRechnungId: integer("stornierte_rechnung_id"),
  pdfPath: text("pdf_path"),
  pdfHash: text("pdf_hash"),
  leistungsnachweisPath: text("leistungsnachweis_path"),
  leistungsnachweisHash: text("leistungsnachweis_hash"),
  sentAt: timestamp("sent_at"),
  paidAt: timestamp("paid_at"),
  storniertAt: timestamp("storniert_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("invoices_customer_id_idx").on(table.customerId),
  index("invoices_billing_period_idx").on(table.billingYear, table.billingMonth),
  index("invoices_status_idx").on(table.status),
  index("invoices_invoice_number_idx").on(table.invoiceNumber),
  index("invoices_stornierte_rechnung_id_idx").on(table.stornierteRechnungId),
]);

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  appointmentId: integer("appointment_id").references(() => appointments.id),
  appointmentDate: text("appointment_date").notNull(),
  serviceDescription: text("service_description").notNull(),
  serviceCode: text("service_code"),
  startTime: text("start_time"),
  endTime: text("end_time"),
  durationMinutes: integer("duration_minutes").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  employeeName: text("employee_name"),
  employeeLbnr: text("employee_lbnr"),
  appointmentNotes: text("appointment_notes"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  index("invoice_line_items_invoice_id_idx").on(table.invoiceId),
]);

export const createInvoiceSchema = z.object({
  customerId: z.number().int().positive(),
  billingMonth: z.number().int().min(1).max(12),
  billingYear: z.number().int().min(2020).max(2100),
});

export const updateInvoiceStatusSchema = z.object({
  status: z.enum(INVOICE_STATUSES),
  notes: z.string().optional().nullable(),
});

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type InsertInvoice = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceStatus = z.infer<typeof updateInvoiceStatusSchema>;
