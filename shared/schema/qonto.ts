import { pgTable, text, integer, serial, index, jsonb, unique } from "drizzle-orm/pg-core";
import { z } from "zod";
import { createInsertSchema } from "drizzle-zod";
import { timestamp } from "./common";
import { invoices } from "./billing";
import { users } from "./users";

export const qontoTransactions = pgTable("qonto_transactions", {
  id: serial("id").primaryKey(),
  qontoTransactionId: text("qonto_transaction_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("EUR"),
  side: text("side").notNull(),
  counterpartyName: text("counterparty_name"),
  reference: text("reference"),
  label: text("label"),
  emittedAt: timestamp("emitted_at").notNull(),
  status: text("status").notNull(),
  matchedInvoiceId: integer("matched_invoice_id").references(() => invoices.id),
  matchConfidence: text("match_confidence"),
  rawData: jsonb("raw_data"),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("qonto_transactions_qonto_id_unique").on(table.qontoTransactionId),
  index("qonto_transactions_emitted_at_idx").on(table.emittedAt),
  index("qonto_transactions_matched_invoice_idx").on(table.matchedInvoiceId),
  index("qonto_transactions_side_idx").on(table.side),
]);

export const paymentAdvices = pgTable("payment_advices", {
  id: serial("id").primaryKey(),
  insuranceProviderName: text("insurance_provider_name"),
  ikNummer: text("ik_nummer"),
  objectPath: text("object_path"),
  fileName: text("file_name").notNull(),
  notes: text("notes"),
  format: text("format").notNull().default("manuell"),
  avisNummer: text("avis_nummer"),
  belegNummer: text("beleg_nummer"),
  gesamtBetragCents: integer("gesamt_betrag_cents"),
  zahlungsDatum: text("zahlungs_datum"),
  kostentraegerIk: text("kostentraeger_ik"),
  kostentraegerName: text("kostentraeger_name"),
  zahlungsempfaengerIk: text("zahlungsempfaenger_ik"),
  zahlungsempfaengerIban: text("zahlungsempfaenger_iban"),
  skontoCents: integer("skonto_cents").notNull().default(0),
  kuerzungCents: integer("kuerzung_cents").notNull().default(0),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => users.id),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("payment_advices_uploaded_at_idx").on(table.uploadedAt),
]);

export const paymentAdviceItems = pgTable("payment_advice_items", {
  id: serial("id").primaryKey(),
  paymentAdviceId: integer("payment_advice_id").notNull().references(() => paymentAdvices.id),
  belegNr: text("beleg_nr"),
  vorgangsNr: text("vorgangs_nr"),
  rechnungsNummer: text("rechnungs_nummer"),
  rechnungsDatum: text("rechnungs_datum"),
  verwendungszweck: text("verwendungszweck"),
  betragCents: integer("betrag_cents").notNull(),
  skontoCents: integer("skonto_cents").notNull().default(0),
  buchungsDatum: text("buchungs_datum"),
  matchedInvoiceId: integer("matched_invoice_id").references(() => invoices.id),
}, (table) => [
  index("payment_advice_items_advice_id_idx").on(table.paymentAdviceId),
  index("payment_advice_items_matched_invoice_idx").on(table.matchedInvoiceId),
]);

export const insertQontoTransactionSchema = createInsertSchema(qontoTransactions).omit({
  id: true,
  createdAt: true,
  syncedAt: true,
});
export type InsertQontoTransaction = z.infer<typeof insertQontoTransactionSchema>;
export type QontoTransaction = typeof qontoTransactions.$inferSelect;

export const insertPaymentAdviceSchema = createInsertSchema(paymentAdvices).omit({
  id: true,
  uploadedAt: true,
  deletedAt: true,
});
export type InsertPaymentAdvice = z.infer<typeof insertPaymentAdviceSchema>;
export type PaymentAdvice = typeof paymentAdvices.$inferSelect;

export const insertPaymentAdviceItemSchema = createInsertSchema(paymentAdviceItems).omit({
  id: true,
});
export type InsertPaymentAdviceItem = z.infer<typeof insertPaymentAdviceItemSchema>;
export type PaymentAdviceItem = typeof paymentAdviceItems.$inferSelect;
