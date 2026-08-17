import { pgTable, text, integer, serial, index, uniqueIndex, jsonb, unique, check } from "drizzle-orm/pg-core";
import { z } from "zod";
import { sql } from "drizzle-orm";
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
  // Task #1587 — IBAN des Kontos, von dem diese Transaktion beim Sync
  // eingesammelt wurde. Erlaubt es, fehlgeleitete Eingänge (Zahlung auf das
  // falsche Konto desselben Qonto-Logins) in der Liste erkennbar zu machen.
  // Nullable: Altbestand vor diesem Task trägt keine Quell-IBAN.
  sourceIban: text("source_iban"),
  matchedInvoiceId: integer("matched_invoice_id").references(() => invoices.id),
  // Task #1672 — Sammel-Avis-Zuordnung: eine Sammelzahlung (Qonto-Sammel-Credit)
  // zeigt statt auf eine einzelne Rechnung auf das ganze Pflegekassen-Avis. XOR
  // zu matchedInvoiceId (nie beide gleichzeitig, DB-Check unten). Ersetzt den
  // Missbrauch von matchedInvoiceId für Bulk-Zahlungen (eine Zahlung auf eine
  // beliebige Einzelrechnung gezwungen).
  matchedPaymentAdviceId: integer("matched_payment_advice_id").references(() => paymentAdvices.id),
  matchConfidence: text("match_confidence"),
  // Qonto-Zahlung als „nicht abrechnungsrelevant" markieren: setzt einen
  // Zeitstempel (Wer/Wann werden über das audit_log historisiert). NULL =
  // abrechnungsrelevant (Default, Altbestand). Solche Eingänge (sonstige
  // Einnahmen/Erstattungen/Kosten) fallen aus dem offenen Abgleich UND aus
  // dem Auto-Abgleich heraus. Reversibel (kann wieder auf NULL gesetzt werden).
  billingIrrelevantAt: timestamp("billing_irrelevant_at"),
  // Woher stammt die Markierung: 'manual' (Nutzer hat den ⊘-Button geklickt)
  // oder 'auto' (eine Auto-Ausblenden-Regel hat gegriffen). NULL, solange die
  // Transaktion abrechnungsrelevant ist. Nur informativ / für Audit-Kontext.
  billingIrrelevantSource: text("billing_irrelevant_source"),
  // „Manuelle Wahl gewinnt": Hat der Nutzer eine Transaktion aktiv wieder
  // sichtbar gemacht (Markierung aufgehoben), wird hier ein Zeitstempel
  // gesetzt. Auto-Ausblenden-Regeln überspringen jede Transaktion mit
  // gesetztem Override dauerhaft, damit eine Regel eine bewusste manuelle
  // Entscheidung nicht wieder überschreibt. Manuelles Ausblenden setzt den
  // Override zurück (der Nutzer entscheidet sich dann bewusst fürs Ausblenden).
  billingRelevantOverrideAt: timestamp("billing_relevant_override_at"),
  // Task #1672 — ein abgelehnter rückwirkender Sammel-Avis-Vorschlag darf beim
  // nächsten Sync/Import nicht erneut erscheinen. Setzt ein Zeitstempel beim
  // „Ablehnen"; die Vorschlags-Suche überspringt Transaktionen mit gesetztem
  // Wert. Ein explizites manuelles Zuordnen bleibt weiterhin möglich.
  adviceSuggestionDismissedAt: timestamp("advice_suggestion_dismissed_at"),
  rawData: jsonb("raw_data"),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("qonto_transactions_qonto_id_unique").on(table.qontoTransactionId),
  index("qonto_transactions_emitted_at_idx").on(table.emittedAt),
  index("qonto_transactions_matched_invoice_idx").on(table.matchedInvoiceId),
  index("qonto_transactions_side_idx").on(table.side),
  // Task #1822 — KEIN Unique-Index mehr auf matched_invoice_id: mehrere
  // Teilüberweisungen dürfen sich auf DIESELBE Rechnung legen und summieren
  // sich zum Restbetrag auf. (Das hiess bis zum Status-Umbau "teilweise_bezahlt"
  // und war ein Status; heute ist es ein Badge aus der Zahlungssumme.) Der frühere
  // partielle Unique-Index (qonto_transactions_matched_invoice_unique_idx,
  // Task #445) wird beim Boot per Migration entfernt
  // (server/startup/drop-qonto-match-unique-index.ts). Die Per-Transaktions-
  // Idempotenz (dieselbe Transaktion nicht doppelt binden) bleibt über den
  // `isNull(matchedInvoiceId)`-Guard in den Match-Schreibpfaden erhalten.
  // Der reine Lookup ist weiterhin über den plain-Index oben abgedeckt.
  // Task #1672 — pro Avis darf höchstens eine Sammelzahlung gematcht sein
  // (eine Zahlung ↔ ein Avis), analog zum Einzelrechnungs-Index.
  uniqueIndex("qonto_transactions_matched_advice_unique_idx")
    .on(table.matchedPaymentAdviceId)
    .where(sql`matched_payment_advice_id IS NOT NULL`),
  index("qonto_transactions_matched_advice_idx").on(table.matchedPaymentAdviceId),
  // Task #1672 — XOR: eine Transaktion zeigt entweder auf eine Einzelrechnung
  // ODER auf ein Sammel-Avis, nie auf beides gleichzeitig.
  check(
    "qonto_transactions_match_xor",
    sql`NOT (matched_invoice_id IS NOT NULL AND matched_payment_advice_id IS NOT NULL)`,
  ),
]);

// Auto-Ausblenden-Regeln: markieren neu eingehende (oder bei Regel-Anlage
// bereits vorhandene, noch offene) Qonto-Zahlungseingänge automatisch als
// „nicht abrechnungsrelevant". Eine Regel trifft entweder über einen
// Teilstring im Zahler-/Counterparty-Namen ODER über eine ganze Quell-IBAN.
// Eine manuell wieder sichtbar gemachte Transaktion (Override) wird NIE erneut
// automatisch ausgeblendet. Soft-Delete (deletedAt) für Audit-Nachvollzug.
export const qontoHideRules = pgTable("qonto_hide_rules", {
  id: serial("id").primaryKey(),
  // 'counterparty' = Teilstring-Treffer im Zahler-Namen; 'iban' = exakte
  // (normalisierte) Quell-IBAN.
  ruleType: text("rule_type").notNull(),
  // Bei 'counterparty' der gesuchte Teilstring; bei 'iban' die (bereits
  // normalisierte) IBAN.
  value: text("value").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  index("qonto_hide_rules_active_idx").on(table.deletedAt),
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

export const insertQontoHideRuleSchema = createInsertSchema(qontoHideRules).omit({
  id: true,
  createdAt: true,
  deletedAt: true,
});
export type InsertQontoHideRule = z.infer<typeof insertQontoHideRuleSchema>;
export type QontoHideRule = typeof qontoHideRules.$inferSelect;

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
