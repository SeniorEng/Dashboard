import { pgTable, text, integer, numeric, serial, index, unique, date, time, jsonb, type AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";
import { appointments } from "./appointments";

export const INVOICE_STATUSES = ["entwurf", "versendet", "avis_erhalten", "bezahlt", "storniert"] as const;
export type InvoiceStatus = typeof INVOICE_STATUSES[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  entwurf: "Entwurf",
  versendet: "Versendet",
  avis_erhalten: "Avis erhalten",
  bezahlt: "Bezahlt",
  storniert: "Storniert",
};

// Task #585: "nachberechnung" wurde als Rechnungstyp abgeschafft. Der Wert
// bleibt in der Union erhalten, weil historische DB-Zeilen ihn weiterhin
// tragen können (GoBD-Immutabilität, Spalte ist `text`, keine Enum-Migration).
// Neu erzeugte Rechnungen verwenden ausschließlich "rechnung" oder
// "stornorechnung". Anzeige historischer "nachberechnung"-Zeilen wird
// einheitlich auf "Rechnung" gemappt (PDF + UI).
export const INVOICE_TYPES = ["rechnung", "stornorechnung", "nachberechnung"] as const;
export type InvoiceType = typeof INVOICE_TYPES[number];

export const INVOICE_TYPE_LABELS: Record<InvoiceType, string> = {
  rechnung: "Rechnung",
  stornorechnung: "Stornorechnung",
  nachberechnung: "Rechnung",
};

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull(),
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
  // Task #562 — ZUGFeRD/EN-16931 Pflichtfelder für Dunkelverarbeitung.
  // dueDate (BT-9): Fälligkeitsdatum. Beim Insert auf Rechnungsdatum + N
  // Tage (default 30, konfigurierbar über company_settings.invoice_default_due_days)
  // gesetzt. Nullable für Bestand (kein Backfill, GoBD).
  dueDate: date("due_date"),
  // buyerReference (BT-10): Käuferreferenz/Aktenzeichen. Nullable; Pflegekassen
  // erhalten beim Insert die Versicherten-Nr. als Fallback.
  buyerReference: text("buyer_reference"),
  // Abtretungserklärung (Datum + interne Ref). Wird aus Customer-Stammdaten
  // beim Insert übernommen, damit historische Rechnungen unverändert bleiben.
  assignmentDeclarationDate: date("assignment_declaration_date"),
  assignmentDeclarationRef: text("assignment_declaration_ref"),
  netAmountCents: integer("net_amount_cents").notNull().default(0),
  vatAmountCents: integer("vat_amount_cents").notNull().default(0),
  grossAmountCents: integer("gross_amount_cents").notNull().default(0),
  vatRate: integer("vat_rate"),
  status: text("status").notNull().default("entwurf"),
  stornierteRechnungId: integer("stornierte_rechnung_id").references((): AnyPgColumn => invoices.id),
  referencedStornoInvoiceIds: integer("referenced_storno_invoice_ids").array(),
  pdfPath: text("pdf_path"),
  pdfHash: text("pdf_hash"),
  zugferdXml: text("zugferd_xml"),
  leistungsnachweisPath: text("leistungsnachweis_path"),
  leistungsnachweisHash: text("leistungsnachweis_hash"),
  // Task #522: Fingerprint der PDF-Eingabedaten (kanonisch serialisiert) zur
  // Drift-Erkennung. Beim Abruf wird ein Live-Fingerprint berechnet und
  // verglichen — weicht er ab, wurden Stammdaten/Positionen/Unterschriften
  // nach der PDF-Erstellung geändert.
  pdfDataFingerprint: text("pdf_data_fingerprint"),
  leistungsnachweisDataFingerprint: text("leistungsnachweis_data_fingerprint"),
  // Task #593: Snapshot der Render-Eingabedaten (companySettings + relevante
  // Kunden-Stammfelder) zum Zeitpunkt der initialen PDF-/XML-Erstellung.
  // Wird vom `verifyInvoiceIntegrity`-Re-Render verwendet, damit parallele
  // Mutationen an `company_settings` oder am Kunden-Datensatz nicht zu
  // falsch-positiven Drift-Treffern führen — die Re-Rendering-Quelle bleibt
  // an die zur Generierung gespeicherten Daten gepinnt (GoBD-konform: die
  // Rechnung muss aus den damals gültigen Stamm-/Firmendaten reproduzierbar
  // bleiben, auch wenn sich Stammdaten später ändern). NULL für Bestand vor
  // #593 — der Verifier fällt dann auf den Live-Snapshot zurück.
  renderSnapshot: jsonb("render_snapshot"),
  sentAt: timestamp("sent_at"),
  paidAt: timestamp("paid_at"),
  storniertAt: timestamp("storniert_at"),
  notes: text("notes"),
  // Task #759 — Variant C: Rechnungs-Split pro Budget-Topf.
  // `budgetType` markiert, welchem Topf der Rechnungs-Anteil zugeordnet ist
  // (`entlastungsbetrag_45b` | `umwandlung_45a` | `ersatzpflege_39_42a`).
  // NULL = Selbstzahler-/Privat-Anteil oder Bestands-Rechnung vor #759
  // (GoBD: keine Backfill-Mutation auf historische Datensätze).
  budgetType: text("budget_type"),
  // `billingRunId` (UUID-Text) gruppiert alle Pot-Rechnungen, die in einem
  // gemeinsamen Abrechnungslauf entstanden sind. Wird nur gesetzt, wenn der
  // Lauf >1 Rechnung produziert hat — Single-Pot-Läufe bleiben NULL und
  // verhalten sich exakt wie vor #759 (Bestand bleibt unverändert).
  billingRunId: text("billing_run_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  unique("invoices_invoice_number_key").on(table.invoiceNumber),
  index("invoices_customer_id_idx").on(table.customerId),
  index("invoices_billing_period_idx").on(table.billingYear, table.billingMonth),
  index("invoices_status_idx").on(table.status),
  index("invoices_invoice_number_idx").on(table.invoiceNumber),
  index("invoices_stornierte_rechnung_id_idx").on(table.stornierteRechnungId),
  index("invoices_billing_run_id_idx").on(table.billingRunId),
]);

// Task #759 — Optionaler Override des Rechnungs-Empfängers pro
// (Kunde × Budget-Topf). Wird vom Resolver bevorzugt; fehlt ein
// gültiger Eintrag, fällt der Resolver auf die aktuelle
// `customer_insurance_history`-Zeile (Kasse-Töpfe) bzw. die
// Kunden-Stammadresse (Selbstzahler-Pot) zurück.
//
// Append-only-Historisierung über validFrom/validTo (GoBD).
export const customerBudgetRecipients = pgTable("customer_budget_recipients", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  budgetType: text("budget_type").notNull(),
  insuranceProviderId: integer("insurance_provider_id"),
  recipientName: text("recipient_name").notNull(),
  recipientAddress: text("recipient_address"),
  ikNummer: text("ik_nummer"),
  versichertennummer: text("versichertennummer"),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("customer_budget_recipients_customer_idx").on(table.customerId, table.budgetType),
]);

export type CustomerBudgetRecipient = typeof customerBudgetRecipients.$inferSelect;

export const invoiceLineItems = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  appointmentId: integer("appointment_id").references(() => appointments.id),
  appointmentDate: date("appointment_date").notNull(),
  serviceDescription: text("service_description").notNull(),
  serviceCode: text("service_code"),
  startTime: time("start_time"),
  endTime: time("end_time"),
  durationMinutes: integer("duration_minutes").notNull(),
  // Task #561: explizite Menge + Einheit. `quantityRaw` ist Dezimal (Stunden
  // oder Kilometer, je nach `quantityUnit`); historische Zeilen haben hier
  // NULL und fallen im PDF-Template auf `durationMinutes` zurück.
  quantityRaw: numeric("quantity_raw", { precision: 10, scale: 3, mode: "number" }),
  quantityUnit: text("quantity_unit"),
  unitPriceCents: integer("unit_price_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  employeeName: text("employee_name"),
  appointmentNotes: text("appointment_notes"),
  serviceDetails: text("service_details"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (table) => [
  index("invoice_line_items_invoice_id_idx").on(table.invoiceId),
]);

export const createInvoiceSchema = z.object({
  customerId: z.number().int().positive("Kunden-ID ist erforderlich"),
  billingMonth: z.number().int().min(1, "Monat muss zwischen 1 und 12 liegen").max(12, "Monat muss zwischen 1 und 12 liegen"),
  billingYear: z.number().int().min(2020, "Jahr muss zwischen 2020 und 2100 liegen").max(2100, "Jahr muss zwischen 2020 und 2100 liegen"),
});

export const updateInvoiceStatusSchema = z.object({
  status: z.enum(INVOICE_STATUSES),
  notes: z.string().optional().nullable(),
  // Task #759 — Variant C: bei `status='storniert'` und `cascadeRun=true`
  // storniert der Endpoint zusätzlich alle Geschwister-Rechnungen mit
  // identischer `billingRunId` in EINEM withAudit-Block.
  cascadeRun: z.boolean().optional(),
});

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;

/**
 * Task #593: Snapshot der Render-Eingabedaten, der zusammen mit dem
 * persistierten ZUGFeRD-XML gespeichert wird. Wird vom Integrity-Verifier
 * verwendet, damit `verifyInvoiceIntegrity` auch nach parallelen Mutationen
 * an `company_settings` oder am Kunden-Datensatz das ursprünglich gerenderte
 * XML byte-genau reproduzieren kann.
 */
/**
 * Strikte Allow-Liste: ausschliesslich die companySettings-Felder, die in
 * `buildPdfData` / ZUGFeRD-XML-Generierung tatsächlich gelesen werden. KEINE
 * Secrets (smtpPass, letterxpressApiKey, qontoSecretKey, whatsappAccessToken,
 * twilioAuthToken, …) — der Snapshot wird als JSONB pro Rechnung persistiert,
 * Secret-Replikation wäre eine DSGVO/GoBD-Eskalation.
 */
export interface InvoiceRenderCompanySnapshot {
  companyName: string | null;
  logoUrl: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  stadt: string | null;
  telefon: string | null;
  email: string | null;
  website: string | null;
  steuernummer: string | null;
  ustId: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  bankAccountHolder: string | null;
  ikNummer: string | null;
  geschaeftsfuehrer: string | null;
}

/**
 * Whitelist der companySettings-Keys, die im InvoiceRenderSnapshot persistiert
 * werden dürfen. Source of truth für den Sanitizer + Architektur-Test.
 */
export const INVOICE_RENDER_COMPANY_SNAPSHOT_KEYS: readonly (keyof InvoiceRenderCompanySnapshot)[] = [
  "companyName",
  "logoUrl",
  "strasse",
  "hausnummer",
  "plz",
  "stadt",
  "telefon",
  "email",
  "website",
  "steuernummer",
  "ustId",
  "iban",
  "bic",
  "bankName",
  "bankAccountHolder",
  "ikNummer",
  "geschaeftsfuehrer",
] as const;

export interface InvoiceRenderSnapshot {
  /** Allow-Liste der companySettings-Felder, die in `buildPdfData` einfliessen. */
  companySettings: InvoiceRenderCompanySnapshot;
  /** Kundenfelder, die in `buildInvoicePdfData` zur XML-Erzeugung gelesen werden. */
  customer: {
    geburtsdatum: string | null;
    beihilfeBerechtigt: boolean | null;
    rechnungAnKunde: boolean | null;
    name: string | null;
    vorname: string | null;
    nachname: string | null;
    strasse: string | null;
    nr: string | null;
    plz: string | null;
    stadt: string | null;
  };
  /**
   * Task #654 — Invoice-Datum-Snapshot. `buildPdfData` löst `invoiceDate`
   * aus `invoice.sentAt ?? todayISO()` auf — d.h. eine zum Persistierzeitpunkt
   * noch nicht versendete Rechnung würde bei jedem späteren Re-Render mit
   * dem dann aktuellen `todayISO()` (bzw. mit dem inzwischen gesetzten
   * `sentAt`) gerendert, und das ZUGFeRD-XML driftet byte-weise gegen das
   * persistierte Original. Wir frieren das damals tatsächlich verwendete
   * Anzeige-Datum (im de-DE-Format `DD.MM.YYYY`) sowie das Fälligkeitsdatum
   * ein und lassen das Re-Render dieselben Werte verwenden. Optional, damit
   * Bestände vor #654 keinen Migrations-Backfill brauchen.
   */
  invoice?: {
    invoiceDate: string;
    invoiceDueDate: string | null;
  };
  /**
   * Task #1047 — eingefrorener PDF-Erzeugungszeitpunkt (ISO-8601). PDFs betten
   * Wall-Clock-Zeitstempel (`/CreationDate`/`/ModDate`, XMP-Metadaten) und eine
   * zufällige Datei-`/ID` ein, sodass ein Re-Render NIE byte-genau den
   * versiegelten `pdf_hash` reproduziert. Beim Erst-Persist wird dieser
   * Zeitpunkt EINMAL festgehalten; jedes Re-Render aus dem Snapshot
   * (Integritäts-Verifier, Clobbered-PDF-Restore) speist denselben Wert in die
   * Render-Pipeline (`buildInvoicePdfBytes` → `embedZugferdXml` /
   * `normalizePdfDeterminism`) und erzeugt damit byte-identische PDFs.
   * Optional, damit Bestände vor #1047 keinen Migrations-Backfill brauchen
   * (diese re-rendern weiterhin nicht byte-genau → werden im Restore „flagged").
   */
  pdfCreationDate?: string;
  /**
   * Task #1073 — eingefrorenes ZUGFeRD-Profil. Bestimmt, mit welchem Profil das
   * eingebettete Factur-X/ZUGFeRD-XML beim Re-Render reproduziert wird.
   * `undefined` = Bestand, der VOR der EN-16931-Umstellung mit dem BASIC-Profil
   * versiegelt wurde → MUSS als `"basic"` re-gerendert werden, sonst driftet das
   * XML byte-weise gegen das in `invoices.zugferd_xml` versiegelte Original.
   * Neue Rechnungen werden mit `"en16931"` (EN 16931 / COMFORT) versiegelt.
   */
  profile?: "basic" | "en16931";
  /**
   * Task #1083 — eingefrorener Positions-Aggregationsmodus. Bestimmt, ob das
   * Rechnungs-PDF und das eingebettete ZUGFeRD-XML die Positionen pro Termin
   * (`per_appointment`) oder kumuliert je Leistungs-/Fahrtkosten-Typ
   * (`cumulative`) rendern. `undefined` = Bestand, der VOR der Kumulierung
   * versiegelt wurde → MUSS als `per_appointment` re-gerendert werden, sonst
   * driftet PDF/XML byte-weise gegen das in `invoices.zugferd_xml` / `pdf_hash`
   * versiegelte Original (Integritäts-Verifier). Neu erzeugte Rechnungen werden
   * mit `"cumulative"` versiegelt.
   */
  lineAggregation?: "cumulative" | "per_appointment";
  /**
   * Task #1098 — eingefrorenes BT-131-Flag (`LineTotalAmount`, Pro-Zeilen-Betrag
   * im eingebetteten ZUGFeRD-/EN-16931-XML). `true` = die Rechnung wurde MIT
   * BT-131 versiegelt; das Re-Render emittiert den Positionsbetrag je Zeile.
   * `undefined`/`false` = Bestand, der VOR dieser Korrektur OHNE BT-131
   * versiegelt wurde (node-zugferd verwarf den damals falschen Schlüssel still)
   * → MUSS weiterhin OHNE BT-131 re-gerendert werden, sonst driftet das XML
   * byte-weise gegen das in `invoices.zugferd_xml` / `pdf_hash` versiegelte
   * Original (Integritäts-Verifier). Neu erzeugte Rechnungen werden mit `true`
   * versiegelt.
   */
  includeLineTotalAmount?: boolean;
  /**
   * Task #1105 — eingefrorenes Flag für die korrekte Header-Settlement-
   * Aufschlüsselung (BG-16 `paymentInstruction` + BG-23 `vatBreakdown`) im
   * eingebetteten ZUGFeRD-/EN-16931-XML. `true` = die Rechnung wurde mit der
   * XSD-strikt-konformen USt-/Zahlungs-Aufschlüsselung versiegelt; das Re-Render
   * emittiert sie byte-genau. `undefined`/`false` = Bestand, der mit den
   * FRÜHEREN (von node-zugferd still verworfenen) Schlüsseln `paymentMeans`/
   * `tradeTax` versiegelt wurde → MUSS weiterhin OHNE Header-Aufschlüsselung
   * re-gerendert werden, sonst driftet das XML byte-weise gegen das in
   * `invoices.zugferd_xml` versiegelte Original (Integritäts-Verifier).
   * Neu erzeugte Rechnungen werden mit `true` versiegelt.
   */
  strictSettlement?: boolean;
  /**
   * Task #1106 — eingefrorenes Flag für die XMP-Namespace-Reparatur (PDF/A-3b).
   * `true` = die Rechnung wurde mit repariertem XMP-Namespace versiegelt
   * (node-zugferd schreibt fälschlich `xmlns:about=""` statt `rdf:about=""`, was
   * den XMP-Parse bricht und veraPDF PDF/A-3b fehlschlagen lässt). `undefined`/
   * `false` = Bestand, der VOR dieser Korrektur versiegelt wurde → MUSS weiterhin
   * mit dem (fehlerhaften) Original-XMP re-gerendert werden, sonst driftet das PDF
   * byte-weise gegen den in `pdf_hash` versiegelten Original-Stand (Integritäts-
   * Verifier). Orthogonal zu `strictSettlement` (XML-Header): erst beide Flags
   * zusammen ergeben eine vollständig EN-16931- UND PDF/A-3b-konforme Rechnung.
   * Neu erzeugte Rechnungen werden mit `true` versiegelt.
   */
  includeConformantSettlement?: boolean;
}
export type InsertInvoice = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceStatus = z.infer<typeof updateInvoiceStatusSchema>;
