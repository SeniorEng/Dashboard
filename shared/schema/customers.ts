import { pgTable, text, integer, serial, date, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp, germanPhoneTransformSchema, optionalGermanPhoneSchema } from "./common";
import { users } from "./users";

// ============================================
// CUSTOMER & ASSIGNMENT TABLES
// ============================================

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  // Original combined name field (kept for backwards compatibility)
  name: text("name").notNull(),
  // Personal data
  vorname: text("vorname"),
  nachname: text("nachname"),
  email: text("email"),
  festnetz: text("festnetz"), // Landline phone
  telefon: text("telefon"), // Mobile phone (legacy field name kept for compatibility)
  geburtsdatum: date("geburtsdatum"),
  // Address fields
  address: text("address").notNull(),
  strasse: text("strasse"),
  nr: text("nr"),
  plz: text("plz"),
  stadt: text("stadt"),
  // Care level 1-5 (current, for quick access - historized in customer_care_level_history)
  pflegegrad: integer("pflegegrad"),
  // Employee assignments
  primaryEmployeeId: integer("primary_employee_id").references(() => users.id),
  backupEmployeeId: integer("backup_employee_id").references(() => users.id),
  // Health
  vorerkrankungen: text("vorerkrankungen"),
  // Pet info (for employee-customer matching)
  haustierVorhanden: boolean("haustier_vorhanden").notNull().default(false),
  haustierDetails: text("haustier_details"),
  // Customer status: erstberatung (initial consultation), aktiv (active customer), inaktiv (deactivated)
  status: text("status").notNull().default("aktiv"),
  personenbefoerderungGewuenscht: boolean("personenbefoerderung_gewuenscht").notNull().default(false),
  // Billing
  acceptsPrivatePayment: boolean("accepts_private_payment").notNull().default(false),
  // Legacy fields
  needs: text("needs").array().notNull().default([]),
  // Audit fields
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("customers_primary_employee_id_idx").on(table.primaryEmployeeId),
  index("customers_backup_employee_id_idx").on(table.backupEmployeeId),
  index("customers_name_idx").on(table.name),
]);

// ============================================
// EMERGENCY CONTACTS
// ============================================

export const CONTACT_TYPES = [
  "familie",
  "angehoerige", 
  "nachbar",
  "hausarzt",
  "betreuer",
  "sonstige",
] as const;

export type ContactType = typeof CONTACT_TYPES[number];

export const customerContacts = pgTable("customer_contacts", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  contactType: text("contact_type").notNull(), // familie, nachbar, hausarzt, etc.
  isPrimary: boolean("is_primary").notNull().default(false),
  vorname: text("vorname").notNull(),
  nachname: text("nachname").notNull(),
  telefon: text("telefon").notNull(),
  email: text("email"),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("customer_contacts_customer_id_idx").on(table.customerId),
  index("customer_contacts_active_idx").on(table.customerId, table.isActive),
]);

// ============================================
// CARE LEVEL HISTORY
// ============================================

export const customerCareLevelHistory = pgTable("customer_care_level_history", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  pflegegrad: integer("pflegegrad").notNull(), // 1-5
  pflegegradBeantragt: integer("pflegegrad_beantragt"), // Requested care level (optional)
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = current
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("customer_care_level_history_customer_id_idx").on(table.customerId),
  index("customer_care_level_history_valid_idx").on(table.customerId, table.validTo),
]);

// ============================================
// NEEDS ASSESSMENT
// ============================================

export const customerNeedsAssessments = pgTable("customer_needs_assessments", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  assessmentDate: date("assessment_date").notNull(),
  // Household info
  householdSize: integer("household_size").notNull().default(1),
  pflegedienstBeauftragt: boolean("pflegedienst_beauftragt").notNull().default(false),
  // Medical history
  anamnese: text("anamnese"), // Pre-existing conditions
  // Selected services - Haushaltsnahe Dienstleistungen
  serviceHaushaltHilfe: boolean("service_haushalt_hilfe").default(false),
  serviceMahlzeiten: boolean("service_mahlzeiten").default(false),
  serviceReinigung: boolean("service_reinigung").default(false),
  serviceWaeschePflege: boolean("service_waesche_pflege").default(false),
  serviceEinkauf: boolean("service_einkauf").default(false),
  // Selected services - Unterstützung Lebensführung
  serviceTagesablauf: boolean("service_tagesablauf").default(false),
  serviceAlltagsverrichtungen: boolean("service_alltagsverrichtungen").default(false),
  serviceTerminbegleitung: boolean("service_terminbegleitung").default(false),
  serviceBotengaenge: boolean("service_botengaenge").default(false),
  serviceGrundpflege: boolean("service_grundpflege").default(false),
  // Selected services - Betreuungsleistungen
  serviceFreizeitbegleitung: boolean("service_freizeitbegleitung").default(false),
  serviceDemenzbetreuung: boolean("service_demenzbetreuung").default(false),
  serviceGesellschaft: boolean("service_gesellschaft").default(false),
  serviceSozialeKontakte: boolean("service_soziale_kontakte").default(false),
  serviceFreizeitgestaltung: boolean("service_freizeitgestaltung").default(false),
  serviceKreativ: boolean("service_kreativ").default(false),
  // Other services
  sonstigeLeistungen: text("sonstige_leistungen"), // max 250 chars
  // Audit
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
});

// ============================================
// CUSTOMER PRICING (historized - like employee compensation)
// ============================================

export const customerPricingHistory = pgTable("customer_pricing_history", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  hauswirtschaftRateCents: integer("hauswirtschaft_rate_cents"), // €/Stunde in Cent
  alltagsbegleitungRateCents: integer("alltagsbegleitung_rate_cents"), // €/Stunde in Cent
  kilometerRateCents: integer("kilometer_rate_cents"), // €/km in Cent
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = currently valid
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("customer_pricing_customer_idx").on(table.customerId),
  index("customer_pricing_valid_idx").on(table.customerId, table.validFrom, table.validTo),
]);

// ============================================
// CUSTOMER ASSIGNMENT HISTORY (ZUWEISUNGS-HISTORIE)
// ============================================

export const ASSIGNMENT_ROLES = ["primary", "backup"] as const;
export type AssignmentRole = typeof ASSIGNMENT_ROLES[number];

export const customerAssignmentHistory = pgTable("customer_assignment_history", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").notNull().references(() => users.id),
  role: text("role").notNull(), // "primary" | "backup"
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = currently active
  changedByUserId: integer("changed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("assignment_history_customer_idx").on(table.customerId),
  index("assignment_history_employee_idx").on(table.employeeId),
  index("assignment_history_valid_idx").on(table.customerId, table.role, table.validFrom, table.validTo),
]);

export type CustomerAssignmentHistory = typeof customerAssignmentHistory.$inferSelect;

// Base customer schema from Drizzle, with phone validation override
const baseCustomerSchema = createInsertSchema(customers).omit({
  id: true,
});

// Customer schema with phone validation
export const insertCustomerSchema = baseCustomerSchema.extend({
  telefon: optionalGermanPhoneSchema,
});

// Schema for creating new customer during Erstberatung
export const insertErstberatungCustomerSchema = z.object({
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  telefon: germanPhoneTransformSchema,
  strasse: z.string().min(1, "Straße ist erforderlich"),
  nr: z.string().min(1, "Hausnummer ist erforderlich"),
  plz: z.string().regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben"),
  stadt: z.string().min(1, "Stadt ist erforderlich"),
  pflegegrad: z.number().min(1).max(5),
});

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type InsertErstberatungCustomer = z.infer<typeof insertErstberatungCustomerSchema>;

// Customer Contact schemas
export const insertCustomerContactSchema = z.object({
  customerId: z.number(),
  contactType: z.enum(CONTACT_TYPES),
  isPrimary: z.boolean().optional().default(false),
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  telefon: germanPhoneTransformSchema,
  email: z.string().email("Ungültige E-Mail-Adresse").optional().nullable(),
  notes: z.string().max(255).optional().nullable(),
  sortOrder: z.number().optional().default(0),
});

export type CustomerContact = typeof customerContacts.$inferSelect;
export type InsertCustomerContact = z.infer<typeof insertCustomerContactSchema>;

// Care Level History schemas
export const insertCareLevelHistorySchema = z.object({
  customerId: z.number(),
  pflegegrad: z.number().min(1).max(5),
  pflegegradBeantragt: z.number().min(1).max(5).optional().nullable(),
  validFrom: z.string(), // Date string
  validTo: z.string().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export type CustomerCareLevelHistory = typeof customerCareLevelHistory.$inferSelect;
export type InsertCareLevelHistory = z.infer<typeof insertCareLevelHistorySchema>;

// Needs Assessment schemas
export const insertNeedsAssessmentSchema = z.object({
  customerId: z.number(),
  assessmentDate: z.string(),
  householdSize: z.number().min(1).default(1),
  pflegedienstBeauftragt: z.boolean().default(false),
  anamnese: z.string().max(2000).optional().nullable(),
  // Haushaltsnahe Dienstleistungen
  serviceHaushaltHilfe: z.boolean().optional().default(false),
  serviceMahlzeiten: z.boolean().optional().default(false),
  serviceReinigung: z.boolean().optional().default(false),
  serviceWaeschePflege: z.boolean().optional().default(false),
  serviceEinkauf: z.boolean().optional().default(false),
  // Unterstützung Lebensführung
  serviceTagesablauf: z.boolean().optional().default(false),
  serviceAlltagsverrichtungen: z.boolean().optional().default(false),
  serviceTerminbegleitung: z.boolean().optional().default(false),
  serviceBotengaenge: z.boolean().optional().default(false),
  serviceGrundpflege: z.boolean().optional().default(false),
  // Betreuungsleistungen
  serviceFreizeitbegleitung: z.boolean().optional().default(false),
  serviceDemenzbetreuung: z.boolean().optional().default(false),
  serviceGesellschaft: z.boolean().optional().default(false),
  serviceSozialeKontakte: z.boolean().optional().default(false),
  serviceFreizeitgestaltung: z.boolean().optional().default(false),
  serviceKreativ: z.boolean().optional().default(false),
  // Other
  sonstigeLeistungen: z.string().max(250).optional().nullable(),
});

export type CustomerNeedsAssessment = typeof customerNeedsAssessments.$inferSelect;
export type InsertNeedsAssessment = z.infer<typeof insertNeedsAssessmentSchema>;

// Customer Pricing schemas
export const insertCustomerPricingSchema = z.object({
  customerId: z.number(),
  hauswirtschaftRateCents: z.number().min(0).nullable().optional(),
  alltagsbegleitungRateCents: z.number().min(0).nullable().optional(),
  kilometerRateCents: z.number().min(0).nullable().optional(),
  validFrom: z.string(), // ISO date string
});

export type CustomerPricing = typeof customerPricingHistory.$inferSelect;
export type InsertCustomerPricing = z.infer<typeof insertCustomerPricingSchema>;
