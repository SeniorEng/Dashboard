import { pgTable, text, integer, serial, date, boolean, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp, ikNummerSchema, versichertennummerSchema, optionalGermanPhoneSchema } from "./common";
import { customers } from "./customers";
import { users } from "./users";

// ============================================
// INSURANCE TABLES
// ============================================

// Lookup table for Pflegekassen / Kostenträger (insurance providers)
export const ZAHLUNGSBEDINGUNGEN = ["sofort", "7_tage", "14_tage", "30_tage", "45_tage", "60_tage"] as const;
export const ZAHLUNGSARTEN = ["ueberweisung", "lastschrift", "bar"] as const;

export const ZAHLUNGSBEDINGUNGEN_LABELS: Record<string, string> = {
  sofort: "Sofort",
  "7_tage": "7 Tage",
  "14_tage": "14 Tage",
  "30_tage": "30 Tage",
  "45_tage": "45 Tage",
  "60_tage": "60 Tage",
};

export const ZAHLUNGSARTEN_LABELS: Record<string, string> = {
  ueberweisung: "Überweisung",
  lastschrift: "Lastschrift",
  bar: "Bar",
};

export const insuranceProviders = pgTable("insurance_providers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // Suchbegriff (z.B. "DAK")
  empfaenger: text("empfaenger"), // Empfänger (z.B. "DAK NordWest")
  empfaengerZeile2: text("empfaenger_zeile2"), // Empfänger Zeile 2 (optional, z.B. "z.H. Herrn Mustermann")
  ikNummer: text("ik_nummer").notNull().unique(), // 9-digit Institutionskennzeichen
  strasse: text("strasse"),
  hausnummer: text("hausnummer"),
  plz: text("plz"),
  stadt: text("stadt"),
  telefon: text("telefon"),
  email: text("email"),
  emailInvoiceEnabled: boolean("email_invoice_enabled").notNull().default(false),
  zahlungsbedingungen: text("zahlungsbedingungen").default("30_tage"),
  zahlungsart: text("zahlungsart").default("ueberweisung"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Legacy columns (kept for data migration, will be removed later)
  anschrift: text("anschrift"),
  plzOrt: text("plz_ort"),
});

// Customer insurance history (tracks changes over time)
export const customerInsuranceHistory = pgTable("customer_insurance_history", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  insuranceProviderId: integer("insurance_provider_id").notNull().references(() => insuranceProviders.id),
  versichertennummer: text("versichertennummer").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("customer_insurance_history_customer_id_idx").on(table.customerId),
  index("customer_insurance_history_provider_id_idx").on(table.insuranceProviderId),
]);

// Insurance Provider schemas
export const insertInsuranceProviderSchema = z.object({
  name: z.string().min(1, "Suchbegriff ist erforderlich"),
  empfaenger: z.string().optional().nullable(),
  empfaengerZeile2: z.string().optional().nullable(),
  ikNummer: ikNummerSchema,
  strasse: z.string().optional().nullable(),
  hausnummer: z.string().optional().nullable(),
  plz: z.string().regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben").optional().nullable().or(z.literal("")),
  stadt: z.string().optional().nullable(),
  telefon: optionalGermanPhoneSchema,
  email: z.string().email("Ungültige E-Mail-Adresse").optional().nullable(),
  emailInvoiceEnabled: z.boolean().optional().default(false),
  zahlungsbedingungen: z.enum(ZAHLUNGSBEDINGUNGEN).optional().default("30_tage"),
  zahlungsart: z.enum(ZAHLUNGSARTEN).optional().default("ueberweisung"),
  isActive: z.boolean().optional().default(true),
});

export type InsuranceProvider = typeof insuranceProviders.$inferSelect;
export type InsertInsuranceProvider = z.infer<typeof insertInsuranceProviderSchema>;

// Customer Insurance History schemas
export const insertCustomerInsuranceSchema = z.object({
  customerId: z.number(),
  insuranceProviderId: z.number(),
  versichertennummer: versichertennummerSchema,
  validFrom: z.string(), // Date string
  validTo: z.string().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export type CustomerInsuranceHistory = typeof customerInsuranceHistory.$inferSelect;
export type InsertCustomerInsurance = z.infer<typeof insertCustomerInsuranceSchema>;
