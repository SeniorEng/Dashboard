import { pgTable, text, integer, serial, boolean, numeric, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { timestamp, optionalGermanPhoneSchema, optionalInternationalPhoneSchema } from "./common";
import { encryptedText } from "./encrypted-columns";
import { users } from "./users";
import { customers } from "./customers";
import { generatedDocuments } from "./documents";

export const companySettings = pgTable("company_settings", {
  id: serial("id").primaryKey(),
  companyName: text("company_name"),
  geschaeftsfuehrer: text("geschaeftsfuehrer"),
  strasse: text("strasse"),
  hausnummer: text("hausnummer"),
  plz: text("plz"),
  stadt: text("stadt"),
  telefon: text("telefon"),
  email: text("email"),
  website: text("website"),
  steuernummer: text("steuernummer"),
  ustId: text("ust_id"),
  iban: encryptedText("iban"),
  bic: encryptedText("bic"),
  bankName: text("bank_name"),
  // Task #757: Optionaler abweichender Kontoinhaber für das Geschäftskonto.
  // Wenn gesetzt, wird er statt `companyName` im Zahlungsblock und als
  // PayeeFinancialAccount.AccountName im ZUGFeRD-XML gerendert.
  bankAccountHolder: text("bank_account_holder"),
  ikNummer: text("ik_nummer"),
  logoUrl: text("logo_url"),
  pdfLogoUrl: text("pdf_logo_url"),
  lohnartAlltagsbegleitung: text("lohnart_alltagsbegleitung"),
  lohnartHauswirtschaft: text("lohnart_hauswirtschaft"),
  lohnartUrlaub: text("lohnart_urlaub"),
  lohnartKrankheit: text("lohnart_krankheit"),
  smtpHost: text("smtp_host"),
  smtpPort: text("smtp_port"),
  smtpUser: text("smtp_user"),
  smtpPass: encryptedText("smtp_pass"),
  smtpFromEmail: text("smtp_from_email"),
  smtpFromName: text("smtp_from_name"),
  smtpSecure: boolean("smtp_secure").notNull().default(false),
  letterxpressUsername: text("letterxpress_username"),
  letterxpressApiKey: encryptedText("letterxpress_api_key"),
  minijobEarningsLimitCents: integer("minijob_earnings_limit_cents").notNull().default(60300),
  // Task #562 — Standard-Fälligkeit in Tagen für neu erzeugte Rechnungen.
  // Wird beim Insert auf invoices.due_date = issueDate + N Tage angewendet.
  // Mandant kann hier abweichen; Default 30 entspricht der gängigen Praxis.
  invoiceDefaultDueDays: integer("invoice_default_due_days").notNull().default(30),
  letterxpressTestMode: boolean("letterxpress_test_mode").notNull().default(false),
  qontoLogin: text("qonto_login"),
  qontoSecretKey: encryptedText("qonto_secret_key"),
  qontoIban: text("qonto_iban"),
  // Task #1587 — Weitere IBANs desselben Qonto-Logins, die im
  // Zahlungsabgleich mitsynchronisiert werden. `qontoIban` bleibt das
  // primäre Geschäftskonto; diese Liste ist rein additiv. IBANs sind nicht
  // sensibel (Pass-through), nur `qontoSecretKey` bleibt redigiert.
  qontoAdditionalIbans: text("qonto_additional_ibans").array().notNull().default(sql`ARRAY[]::text[]`),
  whatsappAccessToken: encryptedText("whatsapp_access_token"),
  whatsappPhoneNumberId: text("whatsapp_phone_number_id"),
  whatsappBusinessAccountId: text("whatsapp_business_account_id"),
  whatsappFromOrService: text("whatsapp_from_or_service"),
  whatsappEnabled: boolean("whatsapp_enabled").notNull().default(false),
  twilioAccountSid: text("twilio_account_sid"),
  twilioAuthToken: encryptedText("twilio_auth_token"),
  twilioPhoneNumber: text("twilio_phone_number"),
  leadCallBridgePhone: text("lead_call_bridge_phone"),
  leadCallBridgeEnabled: boolean("lead_call_bridge_enabled").notNull().default(false),
  deliveryEmailSubject: text("delivery_email_subject"),
  deliveryCoverLetterText: text("delivery_cover_letter_text"),
  leadAutoReplyEnabled: boolean("lead_auto_reply_enabled").notNull().default(false),
  leadAutoReplySubject: text("lead_auto_reply_subject"),
  leadAutoReplyBody: text("lead_auto_reply_body"),
  leadAutoReplyAttachmentPath: text("lead_auto_reply_attachment_path"),
  leadAutoReplyAttachmentName: text("lead_auto_reply_attachment_name"),
  latitude: numeric("latitude", { precision: 9, scale: 6, mode: "number" }),
  longitude: numeric("longitude", { precision: 9, scale: 6, mode: "number" }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id),
});

export type CompanySettings = typeof companySettings.$inferSelect;

export const updateCompanySettingsSchema = z.object({
  companyName: z.string().optional(),
  geschaeftsfuehrer: z.string().optional(),
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  telefon: optionalGermanPhoneSchema,
  email: z.string().optional(),
  website: z.string().optional().nullable(),
  steuernummer: z.string().optional(),
  ustId: z.string().optional().nullable(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  bankName: z.string().optional(),
  bankAccountHolder: z.string().optional().nullable(),
  ikNummer: z.string().optional(),
  logoUrl: z.string().optional().nullable(),
  pdfLogoUrl: z.string().optional().nullable(),
  lohnartAlltagsbegleitung: z.string().optional().nullable(),
  lohnartHauswirtschaft: z.string().optional().nullable(),
  lohnartUrlaub: z.string().optional().nullable(),
  lohnartKrankheit: z.string().optional().nullable(),
  smtpHost: z.string().optional().nullable(),
  smtpPort: z.string().optional().nullable(),
  smtpUser: z.string().optional().nullable(),
  smtpPass: z.string().optional().nullable(),
  smtpFromEmail: z.string().optional().nullable(),
  smtpFromName: z.string().optional().nullable(),
  smtpSecure: z.boolean().optional(),
  letterxpressUsername: z.string().optional().nullable(),
  letterxpressApiKey: z.string().optional().nullable(),
  minijobEarningsLimitCents: z.number().int().min(0, "Betrag darf nicht negativ sein").optional(),
  invoiceDefaultDueDays: z.number().int().min(0, "Anzahl Tage darf nicht negativ sein").max(365, "Maximal 365 Tage").optional(),
  letterxpressTestMode: z.boolean().optional(),
  qontoLogin: z.string().optional().nullable(),
  qontoSecretKey: z.string().optional().nullable(),
  qontoIban: z.string().optional().nullable(),
  qontoAdditionalIbans: z.array(z.string()).optional(),
  whatsappAccessToken: z.string().optional().nullable(),
  whatsappPhoneNumberId: z.string().optional().nullable(),
  whatsappBusinessAccountId: z.string().optional().nullable(),
  whatsappFromOrService: z.string().optional().nullable(),
  whatsappEnabled: z.boolean().optional(),
  twilioAccountSid: z.string().optional().nullable(),
  twilioAuthToken: z.string().optional().nullable(),
  twilioPhoneNumber: optionalInternationalPhoneSchema,
  leadCallBridgePhone: optionalInternationalPhoneSchema,
  leadCallBridgeEnabled: z.boolean().optional(),
  deliveryEmailSubject: z.string().optional().nullable(),
  deliveryCoverLetterText: z.string().optional().nullable(),
  leadAutoReplyEnabled: z.boolean().optional(),
  leadAutoReplySubject: z.string().optional().nullable(),
  leadAutoReplyBody: z.string().optional().nullable(),
  leadAutoReplyAttachmentPath: z.string().optional().nullable(),
  leadAutoReplyAttachmentName: z.string().optional().nullable(),
});

export type UpdateCompanySettings = z.infer<typeof updateCompanySettingsSchema>;

export const documentDeliveries = pgTable("document_deliveries", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").references(() => customers.id),
  generatedDocumentId: integer("generated_document_id").references(() => generatedDocuments.id),
  deliveryMethod: text("delivery_method").notNull(),
  status: text("status").notNull().default("pending"),
  recipientEmail: text("recipient_email"),
  recipientName: text("recipient_name"),
  recipientAddress: text("recipient_address"),
  letterxpressLetterId: text("letterxpress_letter_id"),
  errorMessage: text("error_message"),
  documentFileNames: text("document_file_names"),
  sentAt: timestamp("sent_at"),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("doc_deliveries_customer_idx").on(table.customerId),
  index("doc_deliveries_document_idx").on(table.generatedDocumentId),
  index("doc_deliveries_status_idx").on(table.status),
]);

export type DocumentDelivery = typeof documentDeliveries.$inferSelect;
export type InsertDocumentDelivery = typeof documentDeliveries.$inferInsert;
