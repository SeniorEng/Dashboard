import { pgTable, text, integer, timestamp as pgTimestamp, serial, time, date, boolean, unique, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

import { z } from "zod";

import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js";
import { BUDGET_45B_MAX_MONTHLY_CENTS, BUDGET_39_42A_MAX_YEARLY_CENTS } from "./domain/budgets";

const timestamp = (name: string) => pgTimestamp(name, { withTimezone: true });

// ============================================
// USER & AUTHENTICATION TABLES
// ============================================

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  vorname: text("vorname"),
  nachname: text("nachname"),
  telefon: text("telefon"), // Phone number in E.164 format
  strasse: text("strasse"),
  hausnummer: text("hausnummer"),
  plz: text("plz"),
  stadt: text("stadt"),
  geburtsdatum: date("geburtsdatum"),
  isActive: boolean("is_active").notNull().default(true),
  deactivatedAt: timestamp("deactivated_at"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Employee roles/capabilities - can have multiple per user
export const userRoles = pgTable("user_roles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // "hauswirtschaft" | "alltagsbegleitung" | "erstberatung" | "personenbefoerderung" | "kinderbetreuung"
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("user_role_unique").on(table.userId, table.role),
]);

// Sessions for authentication
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Password reset tokens
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Employee compensation history (historized)
export const TRAVEL_COST_TYPES = ["kilometergeld", "pauschale"] as const;
export type TravelCostType = typeof TRAVEL_COST_TYPES[number];

export const employeeCompensationHistory = pgTable("employee_compensation_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  hourlyRateHauswirtschaftCents: integer("hourly_rate_hauswirtschaft_cents"),
  hourlyRateAlltagsbegleitungCents: integer("hourly_rate_alltagsbegleitung_cents"),
  travelCostType: text("travel_cost_type"), // "kilometergeld" | "pauschale"
  kilometerRateCents: integer("kilometer_rate_cents"),
  monthlyTravelAllowanceCents: integer("monthly_travel_allowance_cents"),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = currently valid
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("employee_compensation_user_idx").on(table.userId),
  index("employee_compensation_valid_idx").on(table.userId, table.validFrom, table.validTo),
]);

// Employee role types
export const EMPLOYEE_ROLES = [
  "hauswirtschaft",
  "alltagsbegleitung", 
  "erstberatung",
  "personenbefoerderung",
  "kinderbetreuung",
] as const;

export type EmployeeRole = typeof EMPLOYEE_ROLES[number];

// User schemas
export const insertUserSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
  password: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben"),
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  telefon: z.string().optional(),
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: z.string().optional(),
  stadt: z.string().optional(),
  geburtsdatum: z.string().optional(),
  isAdmin: z.boolean().optional().default(false),
  roles: z.array(z.enum(EMPLOYEE_ROLES)).optional().default([]),
});

export const loginSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
  password: z.string().min(1, "Passwort ist erforderlich"),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
});

export const passwordResetSchema = z.object({
  token: z.string().min(1, "Token ist erforderlich"),
  newPassword: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben"),
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserRole = typeof userRoles.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

// Employee compensation schemas
export const insertEmployeeCompensationSchema = z.object({
  userId: z.number(),
  hourlyRateHauswirtschaftCents: z.number().int().nullable().optional(),
  hourlyRateAlltagsbegleitungCents: z.number().int().nullable().optional(),
  travelCostType: z.enum(TRAVEL_COST_TYPES).nullable().optional(),
  kilometerRateCents: z.number().int().nullable().optional(),
  monthlyTravelAllowanceCents: z.number().int().nullable().optional(),
  validFrom: z.string(),
}).refine((data) => {
  if (data.travelCostType === "kilometergeld") {
    return data.kilometerRateCents && !data.monthlyTravelAllowanceCents;
  }
  if (data.travelCostType === "pauschale") {
    return data.monthlyTravelAllowanceCents && !data.kilometerRateCents;
  }
  return true;
}, {
  message: "Bei Kilometergeld muss der Km-Satz angegeben werden, bei Pauschale die monatliche Pauschale",
});

export type EmployeeCompensation = typeof employeeCompensationHistory.$inferSelect;
export type InsertEmployeeCompensation = z.infer<typeof insertEmployeeCompensationSchema>;

// User with roles (for API responses)
export type UserWithRoles = User & { roles: EmployeeRole[] };

// User with roles and current compensation (for admin views)
export type UserWithRolesAndCompensation = UserWithRoles & { 
  currentCompensation: EmployeeCompensation | null;
};

// German phone validation using libphonenumber-js
export const germanPhoneSchema = z.string().refine(
  (value) => {
    if (!value || value.trim() === "") return false;
    try {
      if (!isValidPhoneNumber(value, "DE")) return false;
      const parsed = parsePhoneNumber(value, "DE");
      return parsed?.country === "DE";
    } catch {
      return false;
    }
  },
  { message: "Ungültige deutsche Telefonnummer" }
);

// Transform phone to E.164 format for storage
export const germanPhoneTransformSchema = germanPhoneSchema.transform((value) => {
  const parsed = parsePhoneNumber(value, "DE");
  return parsed?.format("E.164") ?? value;
});

// Legacy regex (kept for backward compatibility)
export const germanPhoneRegex = /^(\+49|0)[1-9]\d{1,14}$/;

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
  anschrift: text("anschrift"), // Anschrift (z.B. "Musterstr. 2")
  plzOrt: text("plz_ort"), // PLZ & Ort (z.B. "12345 Musterstadt")
  telefon: text("telefon"),
  email: text("email"),
  emailInvoiceEnabled: boolean("email_invoice_enabled").notNull().default(false),
  zahlungsbedingungen: text("zahlungsbedingungen").default("30_tage"),
  zahlungsart: text("zahlungsart").default("ueberweisung"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Legacy columns (kept for backward compatibility)
  strasse: text("strasse"),
  hausnummer: text("hausnummer"),
  plz: text("plz"),
  stadt: text("stadt"),
});

// Customer insurance history (tracks changes over time)
export const customerInsuranceHistory = pgTable("customer_insurance_history", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  insuranceProviderId: integer("insurance_provider_id").notNull().references(() => insuranceProviders.id),
  versichertennummer: text("versichertennummer").notNull(), // Format: 1 letter + 8 digits + 1 check digit
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = current
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
});

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
// BUDGETS (historized) - Legacy table, kept for migration
// ============================================

export const customerBudgets = pgTable("customer_budgets", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  // Monthly budget amounts in cents (to avoid floating point issues)
  entlastungsbetrag45b: integer("entlastungsbetrag_45b").notNull().default(0), // § 45b SGB XI
  verhinderungspflege39: integer("verhinderungspflege_39").notNull().default(0), // § 39 SGB XI
  pflegesachleistungen36: integer("pflegesachleistungen_36").notNull().default(0), // § 36 SGB XI
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = current
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("customer_budgets_customer_id_idx").on(table.customerId),
]);

// ============================================
// BUDGET LEDGER SYSTEM (§45b, §45a, §39/§42a)
// ============================================

// Budget allocation sources
export const BUDGET_ALLOCATION_SOURCES = [
  "monthly_auto",      // Regular monthly auto-allocation
  "carryover",         // Carryover from previous year (expires June 30)
  "initial_balance",   // Initial balance when customer joins
  "manual_adjustment", // Manual correction/adjustment
  "yearly_auto",       // Yearly auto-allocation (for §39/§42a)
] as const;

export type BudgetAllocationSource = typeof BUDGET_ALLOCATION_SOURCES[number];

// Budget allocations - credits to the customer's account
export const budgetAllocations = pgTable("budget_allocations", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  budgetType: text("budget_type").notNull().default("entlastungsbetrag_45b"), // For future: other budget types
  year: integer("year").notNull(),
  month: integer("month"), // null for carryover/initial entries
  amountCents: integer("amount_cents").notNull(), // Amount in cents (e.g., 13100 = 131€)
  source: text("source").notNull(), // monthly, carryover, initial_balance, manual_adjustment
  validFrom: date("valid_from").notNull(), // When this allocation becomes available
  expiresAt: date("expires_at"), // null = never expires, set for carryover (June 30)
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("budget_allocations_customer_idx").on(table.customerId),
  index("budget_allocations_customer_year_idx").on(table.customerId, table.year),
  index("budget_allocations_expires_idx").on(table.expiresAt),
  index("budget_allocations_fifo_idx").on(table.customerId, table.budgetType, table.validFrom),
  uniqueIndex("budget_allocations_auto_unique_idx").on(table.customerId, table.budgetType, table.year, table.month, table.source),
]);

// Budget transaction types
export const BUDGET_TRANSACTION_TYPES = [
  "consumption",       // Service consumption (appointment)
  "expiration",        // Carryover expiration after June 30
  "reversal",          // Reversal of a consumption (e.g., cancelled appointment)
  "manual_adjustment", // Manual correction
  "write_off",         // Automatic write-off of expired carryover funds (CORRECTION_WRITE_OFF)
] as const;

export type BudgetTransactionType = typeof BUDGET_TRANSACTION_TYPES[number];

// Budget transactions - debits from the customer's account
export const budgetTransactions = pgTable("budget_transactions", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  budgetType: text("budget_type").notNull().default("entlastungsbetrag_45b"),
  transactionDate: date("transaction_date").notNull(),
  transactionType: text("transaction_type").notNull(), // consumption, expiration, reversal, manual_adjustment
  amountCents: integer("amount_cents").notNull(), // Negative for consumption, positive for reversals
  // Breakdown for consumption transactions
  hauswirtschaftMinutes: integer("hauswirtschaft_minutes"),
  hauswirtschaftCents: integer("hauswirtschaft_cents"),
  alltagsbegleitungMinutes: integer("alltagsbegleitung_minutes"),
  alltagsbegleitungCents: integer("alltagsbegleitung_cents"),
  travelKilometers: integer("travel_kilometers"),
  travelCents: integer("travel_cents"),
  customerKilometers: integer("customer_kilometers"),
  customerKilometersCents: integer("customer_kilometers_cents"),
  // Reference to source
  appointmentId: integer("appointment_id").references(() => appointments.id),
  allocationId: integer("allocation_id").references(() => budgetAllocations.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("budget_transactions_customer_idx").on(table.customerId),
  index("budget_transactions_customer_date_idx").on(table.customerId, table.transactionDate),
  index("budget_transactions_appointment_idx").on(table.appointmentId),
  index("budget_transactions_allocation_idx").on(table.allocationId),
  index("budget_transactions_allocation_type_idx").on(table.allocationId, table.transactionType),
]);

// Customer budget preferences (monthly limit, etc.)
export const customerBudgetPreferences = pgTable("customer_budget_preferences", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }).unique(),
  monthlyLimitCents: integer("monthly_limit_cents"), // Desired monthly usage limit (null = no limit, use full 131€)
  budgetStartDate: date("budget_start_date"), // When customer started using budget (for pro-rata calculation)
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("customer_budget_preferences_customer_idx").on(table.customerId),
]);

// Per-budget-type settings per customer (enabled, priority, monthly limit)
export const customerBudgetTypeSettings = pgTable("customer_budget_type_settings", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  budgetType: text("budget_type").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(1),
  monthlyLimitCents: integer("monthly_limit_cents"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("customer_budget_type_settings_unique_idx").on(table.customerId, table.budgetType),
  index("customer_budget_type_settings_customer_idx").on(table.customerId),
]);

// ============================================
// CONTRACTS & PRICING
// ============================================

// Customer service contracts
export const customerContracts = pgTable("customer_contracts", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  contractStart: date("contract_start").notNull(),
  contractEnd: date("contract_end"), // null = ongoing
  // Service scope
  hoursPerPeriod: integer("hours_per_period").notNull(), // Total hours
  periodType: text("period_type").notNull(), // "week" | "month" | "year"
  // Pricing (in cents) - required for all contracts
  hauswirtschaftRateCents: integer("hauswirtschaft_rate_cents").notNull().default(0), // €/Stunde in Cent
  alltagsbegleitungRateCents: integer("alltagsbegleitung_rate_cents").notNull().default(0), // €/Stunde in Cent
  kilometerRateCents: integer("kilometer_rate_cents").notNull().default(0), // €/km in Cent
  // Status
  status: text("status").notNull().default("active"), // "active" | "paused" | "terminated"
  notes: text("notes"),
  // Audit
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("customer_contracts_customer_status_idx").on(table.customerId, table.status),
]);

// Service categories for pricing
export const SERVICE_CATEGORIES = [
  "hauswirtschaft",
  "alltagsbegleitung",
  "erstberatung",
] as const;

export type ServiceCategory = typeof SERVICE_CATEGORIES[number];

// Default service rates (company-wide, historized)
export const serviceRates = pgTable("service_rates", {
  id: serial("id").primaryKey(),
  serviceCategory: text("service_category").notNull(), // hauswirtschaft, alltagsbegleitung
  hourlyRateCents: integer("hourly_rate_cents").notNull(), // Rate in cents
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = current
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
});

// Customer-specific rate overrides (historized)
export const customerContractRates = pgTable("customer_contract_rates", {
  id: serial("id").primaryKey(),
  contractId: integer("contract_id").notNull().references(() => customerContracts.id, { onDelete: "cascade" }),
  serviceCategory: text("service_category").notNull(), // hauswirtschaft, alltagsbegleitung
  hourlyRateCents: integer("hourly_rate_cents").notNull(), // Rate in cents (overrides default)
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = current
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
});

// ============================================
// APPOINTMENT TABLES
// ============================================

export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  assignedEmployeeId: integer("assigned_employee_id").references(() => users.id), // Employee assigned to this appointment
  performedByEmployeeId: integer("performed_by_employee_id").references(() => users.id), // Employee who actually performed the appointment (set during documentation)
  appointmentType: text("appointment_type").notNull(), // "Erstberatung" | "Kundentermin"
  // Service durations in minutes (15-min increments) - for Kundentermin
  hauswirtschaftDauer: integer("hauswirtschaft_dauer"), // null if not selected
  alltagsbegleitungDauer: integer("alltagsbegleitung_dauer"), // null if not selected
  // Service durations in minutes (15-min increments) - for Erstberatung
  erstberatungDauer: integer("erstberatung_dauer"), // null if not Erstberatung
  // Service documentation - actual duration and details (max 55 chars)
  hauswirtschaftActualDauer: integer("hauswirtschaft_actual_dauer"),
  hauswirtschaftDetails: text("hauswirtschaft_details"),
  alltagsbegleitungActualDauer: integer("alltagsbegleitung_actual_dauer"),
  alltagsbegleitungDetails: text("alltagsbegleitung_details"),
  erstberatungActualDauer: integer("erstberatung_actual_dauer"),
  erstberatungDetails: text("erstberatung_details"),
  // Legacy serviceType field (for display compatibility)
  serviceType: text("service_type"),
  date: date("date").notNull(),
  // Scheduled times (planned appointment slot)
  scheduledStart: time("scheduled_start").notNull(),
  scheduledEnd: time("scheduled_end"),
  durationPromised: integer("duration_promised").notNull(),
  status: text("status").notNull().default("scheduled"),
  // Actual visit times (recorded during visit) - stored as time strings "HH:MM:SS"
  actualStart: time("actual_start"),
  actualEnd: time("actual_end"),
  // Travel documentation
  travelOriginType: text("travel_origin_type"), // "home" | "appointment"
  travelFromAppointmentId: integer("travel_from_appointment_id"),
  travelKilometers: integer("travel_kilometers"),
  travelMinutes: integer("travel_minutes"),
  // Customer kilometers (for Alltagsbegleitung - trips with/for customer)
  customerKilometers: integer("customer_kilometers"),
  notes: text("notes"),
  servicesDone: text("services_done").array().default([]),
  signatureData: text("signature_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("appointments_customer_id_idx").on(table.customerId),
  index("appointments_date_idx").on(table.date),
  index("appointments_assigned_employee_id_idx").on(table.assignedEmployeeId),
  index("appointments_performed_by_employee_id_idx").on(table.performedByEmployeeId),
  index("appointments_date_customer_id_idx").on(table.date, table.customerId),
  index("appointments_status_date_idx").on(table.status, table.date),
  index("appointments_employee_date_idx").on(table.assignedEmployeeId, table.date),
]);

// Base customer schema from Drizzle, with phone validation override
const baseCustomerSchema = createInsertSchema(customers).omit({
  id: true,
});

// Optional phone validation - validates and transforms to E.164 if provided
// Handles: null, undefined, empty string, E.164 format, user input formats
const optionalGermanPhoneSchema = z.union([
  z.null(),
  z.undefined(),
  z.literal(""),
  z.string(),
]).transform((value, ctx) => {
  if (value === null || value === undefined || value === "") return null;
  
  const trimmed = value.trim();
  if (trimmed === "") return null;
  
  try {
    if (!isValidPhoneNumber(trimmed, "DE")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ungültige deutsche Telefonnummer",
      });
      return z.NEVER;
    }
    const parsed = parsePhoneNumber(trimmed, "DE");
    if (parsed?.country !== "DE") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Ungültige deutsche Telefonnummer",
      });
      return z.NEVER;
    }
    return parsed.format("E.164");
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Ungültige deutsche Telefonnummer",
    });
    return z.NEVER;
  }
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

// Base appointment insert schema
const baseAppointmentSchema = createInsertSchema(appointments).omit({
  id: true,
  createdAt: true,
});

// Schema for Kundentermin appointment
export const insertKundenterminSchema = z.object({
  customerId: z.number(),
  date: z.string(),
  scheduledStart: z.string(),
  hauswirtschaftDauer: z.number().min(15).multipleOf(15).nullable().optional(),
  alltagsbegleitungDauer: z.number().min(15).multipleOf(15).nullable().optional(),
  notes: z.string().max(255).optional(),
  assignedEmployeeId: z.number().nullable().optional(), // Admin can assign employee
}).refine(
  (data) => data.hauswirtschaftDauer || data.alltagsbegleitungDauer,
  { message: "Mindestens ein Service muss ausgewählt werden" }
);

// Schema for Erstberatung appointment
export const insertErstberatungSchema = z.object({
  customer: insertErstberatungCustomerSchema,
  date: z.string(),
  scheduledStart: z.string(),
  erstberatungDauer: z.number().min(15).multipleOf(15),
  notes: z.string().max(255).optional(),
  assignedEmployeeId: z.number().nullable().optional(), // Admin can assign employee
});

// Refined schema for general appointment insert
export const insertAppointmentSchema = baseAppointmentSchema.superRefine((data, ctx) => {
  if (data.appointmentType === "Kundentermin") {
    if (!data.hauswirtschaftDauer && !data.alltagsbegleitungDauer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Mindestens ein Service muss ausgewählt werden",
        path: ["serviceType"],
      });
    }
  }
});

export const updateAppointmentSchema = baseAppointmentSchema.partial();

// Schema for documenting any appointment (Kundentermin or Erstberatung)
export const documentAppointmentSchema = z.object({
  // Employee who actually performed this appointment (defaults to assignedEmployeeId if not provided)
  performedByEmployeeId: z.number().nullable().optional(),
  // Actual start time (confirmed or adjusted by user during documentation)
  actualStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Ungültiges Zeitformat (HH:MM erwartet)"),
  // Service documentation (at least one required based on what was scheduled)
  hauswirtschaftActualDauer: z.number().min(1).nullable().optional(),
  hauswirtschaftDetails: z.string().max(55, "Maximal 55 Zeichen").nullable().optional(),
  alltagsbegleitungActualDauer: z.number().min(1).nullable().optional(),
  alltagsbegleitungDetails: z.string().max(55, "Maximal 55 Zeichen").nullable().optional(),
  erstberatungActualDauer: z.number().min(1).nullable().optional(),
  erstberatungDetails: z.string().max(55, "Maximal 55 Zeichen").nullable().optional(),
  // Travel documentation
  travelOriginType: z.enum(["home", "appointment"]),
  travelFromAppointmentId: z.number().nullable().optional(),
  travelKilometers: z.number().min(0, "Kilometer müssen positiv sein"),
  travelMinutes: z.number().min(0).nullable().optional(), // Only required if origin is appointment
  // Customer kilometers (for Alltagsbegleitung - trips with/for customer)
  customerKilometers: z.number().min(0).nullable().optional(),
  // Optional notes
  notes: z.string().max(255).nullable().optional(),
}).refine(
  (data) => {
    // If origin is "appointment", travelMinutes is required
    if (data.travelOriginType === "appointment" && (data.travelMinutes === null || data.travelMinutes === undefined)) {
      return false;
    }
    return true;
  },
  { message: "Fahrzeit ist erforderlich wenn Sie von einem anderen Termin kommen", path: ["travelMinutes"] }
);

// Alias for backward compatibility
export const documentKundenterminSchema = documentAppointmentSchema;

export type DocumentAppointment = z.infer<typeof documentAppointmentSchema>;
export type DocumentKundentermin = DocumentAppointment;

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type InsertErstberatungCustomer = z.infer<typeof insertErstberatungCustomerSchema>;

export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = z.infer<typeof baseAppointmentSchema>;
export type UpdateAppointment = z.infer<typeof updateAppointmentSchema>;
export type InsertKundentermin = z.infer<typeof insertKundenterminSchema>;
export type InsertErstberatung = z.infer<typeof insertErstberatungSchema>;

// ============================================
// NEW CUSTOMER MANAGEMENT SCHEMAS & TYPES
// ============================================

// German validation patterns
export const ikNummerSchema = z.string()
  .regex(/^\d{9}$/, "IK-Nummer muss genau 9 Ziffern haben");

export const versichertennummerSchema = z.string()
  .regex(/^[A-Z]\d{9}$/, "Versichertennummer muss 1 Buchstabe + 9 Ziffern sein (z.B. A123456789)");

export const plzSchema = z.string()
  .regex(/^\d{5}$/, "PLZ muss 5 Ziffern haben");

// Insurance Provider schemas
export const insertInsuranceProviderSchema = z.object({
  name: z.string().min(1, "Suchbegriff ist erforderlich"),
  empfaenger: z.string().optional().nullable(),
  empfaengerZeile2: z.string().optional().nullable(),
  ikNummer: ikNummerSchema,
  anschrift: z.string().optional().nullable(),
  plzOrt: z.string().optional().nullable(),
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

// Budget schemas
export const insertCustomerBudgetSchema = z.object({
  customerId: z.number(),
  entlastungsbetrag45b: z.number().min(0).max(BUDGET_45B_MAX_MONTHLY_CENTS).default(0),
  verhinderungspflege39: z.number().min(0).max(BUDGET_39_42A_MAX_YEARLY_CENTS).default(0),
  pflegesachleistungen36: z.number().min(0).default(0), // Max depends on Pflegegrad, validated in route
  validFrom: z.string(),
  validTo: z.string().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export type CustomerBudget = typeof customerBudgets.$inferSelect;
export type InsertCustomerBudget = z.infer<typeof insertCustomerBudgetSchema>;

// Budget Allocation schemas (Ledger system)
export const insertBudgetAllocationSchema = z.object({
  customerId: z.number(),
  budgetType: z.string().default("entlastungsbetrag_45b"),
  year: z.number().min(2020).max(2100),
  month: z.number().min(1).max(12).nullable().optional(),
  amountCents: z.number().min(0),
  source: z.enum(BUDGET_ALLOCATION_SOURCES),
  validFrom: z.string(),
  expiresAt: z.string().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export type BudgetAllocation = typeof budgetAllocations.$inferSelect;
export type InsertBudgetAllocation = z.infer<typeof insertBudgetAllocationSchema>;

// Budget Transaction schemas (Ledger system)
export const insertBudgetTransactionSchema = z.object({
  customerId: z.number(),
  budgetType: z.string().default("entlastungsbetrag_45b"),
  transactionDate: z.string(),
  transactionType: z.enum(BUDGET_TRANSACTION_TYPES),
  amountCents: z.number(), // Negative for consumption, positive for reversals
  hauswirtschaftMinutes: z.number().nullable().optional(),
  hauswirtschaftCents: z.number().nullable().optional(),
  alltagsbegleitungMinutes: z.number().nullable().optional(),
  alltagsbegleitungCents: z.number().nullable().optional(),
  travelKilometers: z.number().nullable().optional(),
  travelCents: z.number().nullable().optional(),
  customerKilometers: z.number().nullable().optional(),
  customerKilometersCents: z.number().nullable().optional(),
  appointmentId: z.number().nullable().optional(),
  allocationId: z.number().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export type BudgetTransaction = typeof budgetTransactions.$inferSelect;
export type InsertBudgetTransaction = z.infer<typeof insertBudgetTransactionSchema>;

// Customer Budget Preferences schemas
export const insertBudgetPreferencesSchema = z.object({
  customerId: z.number(),
  monthlyLimitCents: z.number().min(0).nullable().optional(),
  budgetStartDate: z.string().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const updateBudgetPreferencesSchema = insertBudgetPreferencesSchema.partial().omit({ customerId: true });

export type CustomerBudgetPreferences = typeof customerBudgetPreferences.$inferSelect;
export type InsertBudgetPreferences = z.infer<typeof insertBudgetPreferencesSchema>;

// Customer Budget Type Settings schemas
export const insertBudgetTypeSettingsSchema = createInsertSchema(customerBudgetTypeSettings).omit({
  id: true,
}).extend({
  budgetType: z.enum(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"]),
  priority: z.number().min(1).max(3),
  monthlyLimitCents: z.number().min(0).nullable().optional(),
});

export type CustomerBudgetTypeSetting = typeof customerBudgetTypeSettings.$inferSelect;
export type InsertBudgetTypeSetting = z.infer<typeof insertBudgetTypeSettingsSchema>;

// Contract schemas
export const CONTRACT_PERIOD_TYPES = ["week", "month", "year"] as const;
export const CONTRACT_STATUS = ["active", "paused", "terminated"] as const;

export const insertCustomerContractSchema = z.object({
  customerId: z.number(),
  contractStart: z.string(),
  contractEnd: z.string().optional().nullable(),
  hoursPerPeriod: z.number().min(1),
  periodType: z.enum(CONTRACT_PERIOD_TYPES),
  // Pricing (in cents) - required for all contracts
  hauswirtschaftRateCents: z.number().min(0, "Hauswirtschaft-Preis ist erforderlich"),
  alltagsbegleitungRateCents: z.number().min(0, "Alltagsbegleitung-Preis ist erforderlich"),
  kilometerRateCents: z.number().min(0, "Kilometer-Preis ist erforderlich"),
  status: z.enum(CONTRACT_STATUS).optional().default("active"),
  notes: z.string().max(500).optional().nullable(),
});

export type CustomerContract = typeof customerContracts.$inferSelect;
export type InsertCustomerContract = z.infer<typeof insertCustomerContractSchema>;

// Service Rate schemas
export const insertServiceRateSchema = z.object({
  serviceCategory: z.enum(SERVICE_CATEGORIES),
  hourlyRateCents: z.number().min(0), // Rate in cents
  validFrom: z.string(),
  validTo: z.string().optional().nullable(),
});

export type ServiceRate = typeof serviceRates.$inferSelect;
export type InsertServiceRate = z.infer<typeof insertServiceRateSchema>;

// Customer Contract Rate schemas
export const insertContractRateSchema = z.object({
  contractId: z.number(),
  serviceCategory: z.enum(SERVICE_CATEGORIES),
  hourlyRateCents: z.number().min(0),
  validFrom: z.string(),
  validTo: z.string().optional().nullable(),
});

export type CustomerContractRate = typeof customerContractRates.$inferSelect;
export type InsertContractRate = z.infer<typeof insertContractRateSchema>;

// ============================================
// FULL CUSTOMER CREATION SCHEMA (Admin Form)
// ============================================

// This is the comprehensive schema for creating a customer via the admin form
export const createFullCustomerSchema = z.object({
  // Personal data
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  email: z.string().email("Ungültige E-Mail-Adresse").optional().nullable(),
  festnetz: optionalGermanPhoneSchema,
  mobiltelefon: optionalGermanPhoneSchema,
  geburtsdatum: z.string().min(1, "Geburtsdatum ist erforderlich"),
  
  // Address
  strasse: z.string().min(1, "Straße ist erforderlich"),
  hausnummer: z.string().min(1, "Hausnummer ist erforderlich"),
  plz: plzSchema,
  stadt: z.string().min(1, "Stadt ist erforderlich"),
  
  // Insurance
  insuranceProviderId: z.number().min(1, "Pflegekasse ist erforderlich"),
  versichertennummer: versichertennummerSchema,
  
  // Primary emergency contact (required)
  primaryContact: z.object({
    contactType: z.enum(CONTACT_TYPES),
    vorname: z.string().min(1, "Vorname ist erforderlich"),
    nachname: z.string().min(1, "Nachname ist erforderlich"),
    telefon: germanPhoneTransformSchema,
  }),
  
  // Additional emergency contacts (optional)
  additionalContacts: z.array(z.object({
    contactType: z.enum(CONTACT_TYPES),
    vorname: z.string().min(1),
    nachname: z.string().min(1),
    telefon: germanPhoneTransformSchema,
  })).optional().default([]),
  
  // Needs assessment
  householdSize: z.number().min(1).default(1),
  pflegegrad: z.number().min(1).max(5),
  pflegegradSeit: z.string().min(1, "Pflegegrad seit ist erforderlich"),
  pflegegradBeantragt: z.number().min(1).max(5).optional().nullable(),
  pflegedienstBeauftragt: z.boolean().default(false),
  anamnese: z.string().max(2000).optional().nullable(),
  
  // Selected services
  services: z.object({
    haushaltHilfe: z.boolean().optional().default(false),
    mahlzeiten: z.boolean().optional().default(false),
    reinigung: z.boolean().optional().default(false),
    waeschePflege: z.boolean().optional().default(false),
    einkauf: z.boolean().optional().default(false),
    tagesablauf: z.boolean().optional().default(false),
    alltagsverrichtungen: z.boolean().optional().default(false),
    terminbegleitung: z.boolean().optional().default(false),
    botengaenge: z.boolean().optional().default(false),
    grundpflege: z.boolean().optional().default(false),
    freizeitbegleitung: z.boolean().optional().default(false),
    demenzbetreuung: z.boolean().optional().default(false),
    gesellschaft: z.boolean().optional().default(false),
    sozialeKontakte: z.boolean().optional().default(false),
    freizeitgestaltung: z.boolean().optional().default(false),
    kreativ: z.boolean().optional().default(false),
  }).optional().default({}),
  sonstigeLeistungen: z.string().max(250).optional().nullable(),
  
  // Budgets (in euros, will convert to cents)
  entlastungsbetrag45b: z.number().min(0).default(0),
  verhinderungspflege39: z.number().min(0).default(0),
  pflegesachleistungen36: z.number().min(0).default(0),
  
  // Contract
  contractHours: z.number().min(1),
  contractPeriod: z.enum(CONTRACT_PERIOD_TYPES),
  contractStart: z.string().optional().nullable(),
  
  // Prices (in euros, will convert to cents) - all required
  hauswirtschaftRate: z.number().min(0, "Hauswirtschaft-Preis ist erforderlich"),
  alltagsbegleitungRate: z.number().min(0, "Alltagsbegleitung-Preis ist erforderlich"),
  kilometerRate: z.number().min(0, "Kilometer-Preis ist erforderlich"),
});

export type CreateFullCustomer = z.infer<typeof createFullCustomerSchema>;

// Budget summary for customer detail view
export interface BudgetSummary {
  customerId: number;
  totalAllocatedCents: number;
  totalUsedCents: number;
  availableCents: number;
  carryoverCents: number;
  carryoverExpiresAt: string | null;
  currentYearAllocatedCents: number;
  monthlyLimitCents: number | null;
  currentMonthUsedCents: number;
}

// Customer with all related data for detail view
export type CustomerWithDetails = Customer & {
  insurance?: CustomerInsuranceHistory & { provider: InsuranceProvider };
  contacts: CustomerContact[];
  careLevelHistory: CustomerCareLevelHistory[];
  needsAssessment?: CustomerNeedsAssessment;
  budget?: CustomerBudget;
  contract?: CustomerContract & { rates: CustomerContractRate[] };
  primaryEmployee?: { id: number; displayName: string };
  backupEmployee?: { id: number; displayName: string };
  pricingHistory?: CustomerPricing[];
  currentPricing?: CustomerPricing;
  budgetSummary?: BudgetSummary;
};

// ============================================
// EMPLOYEE TIME TRACKING
// ============================================

// Time entry types for non-client work
export const TIME_ENTRY_TYPES = [
  "urlaub",        // Vacation
  "krankheit",     // Sick leave
  "pause",         // Break
  "bueroarbeit",   // Office/admin work
  "vertrieb",      // Sales
  "schulung",      // Training
  "besprechung",   // Meeting
  "sonstiges",     // Other
] as const;

export type TimeEntryType = typeof TIME_ENTRY_TYPES[number];

// Employee time entries table
export const employeeTimeEntries = pgTable("employee_time_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  entryType: text("entry_type").notNull(), // TimeEntryType
  entryDate: date("entry_date").notNull(),
  startTime: time("start_time"), // Optional for full-day entries like vacation
  endTime: time("end_time"),     // Optional for full-day entries
  isFullDay: boolean("is_full_day").notNull().default(false),
  durationMinutes: integer("duration_minutes"), // Calculated or manual for breaks
  isAutoGenerated: boolean("is_auto_generated").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("time_entries_user_id_idx").on(table.userId),
  index("time_entries_entry_date_idx").on(table.entryDate),
  index("time_entries_user_date_idx").on(table.userId, table.entryDate),
]);

// Employee vacation allowance per year
export const employeeVacationAllowance = pgTable("employee_vacation_allowance", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  year: integer("year").notNull(),
  totalDays: integer("total_days").notNull().default(30), // Standard German vacation days
  carryOverDays: integer("carry_over_days").notNull().default(0), // Days carried from previous year
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  unique("user_year_unique").on(table.userId, table.year),
]);

// Insert schemas
export const insertTimeEntrySchema = z.object({
  entryType: z.enum(TIME_ENTRY_TYPES),
  entryDate: z.string().min(1, "Datum ist erforderlich"),
  startTime: z.string().optional().nullable(),
  endTime: z.string().optional().nullable(),
  isFullDay: z.boolean().optional().default(false),
  durationMinutes: z.number().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export const updateTimeEntrySchema = insertTimeEntrySchema.partial();

export const insertVacationAllowanceSchema = z.object({
  userId: z.number(),
  year: z.number().min(2020).max(2100),
  totalDays: z.number().min(0).max(365).default(30),
  carryOverDays: z.number().min(0).max(365).default(0),
  notes: z.string().max(500).optional().nullable(),
});

export type EmployeeTimeEntry = typeof employeeTimeEntries.$inferSelect;
export type InsertTimeEntry = z.infer<typeof insertTimeEntrySchema>;
export type UpdateTimeEntry = z.infer<typeof updateTimeEntrySchema>;

export type EmployeeVacationAllowance = typeof employeeVacationAllowance.$inferSelect;
export type InsertVacationAllowance = z.infer<typeof insertVacationAllowanceSchema>;

// ============================================
// MONTHLY SERVICE RECORDS (LEISTUNGSNACHWEISE) TABLES
// ============================================

export const SERVICE_RECORD_STATUSES = [
  "pending",              // Created, awaiting employee signature
  "employee_signed",      // Employee signed, awaiting customer signature
  "completed",            // Both signatures collected, record finalized
] as const;

export type ServiceRecordStatus = typeof SERVICE_RECORD_STATUSES[number];

export const monthlyServiceRecords = pgTable("monthly_service_records", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").notNull().references(() => users.id),
  year: integer("year").notNull(),
  month: integer("month").notNull(), // 1-12
  status: text("status").notNull().default("pending"), // ServiceRecordStatus
  // Employee signature
  employeeSignatureData: text("employee_signature_data"), // Base64 PNG from react-signature-canvas
  employeeSignedAt: timestamp("employee_signed_at"),
  // Customer signature
  customerSignatureData: text("customer_signature_data"), // Base64 PNG from react-signature-canvas
  customerSignedAt: timestamp("customer_signed_at"),
  // Metadata
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  unique("service_record_unique").on(table.customerId, table.employeeId, table.year, table.month),
  index("service_records_customer_idx").on(table.customerId),
  index("service_records_employee_idx").on(table.employeeId),
  index("service_records_period_idx").on(table.year, table.month),
  index("service_records_status_idx").on(table.status),
]);

// Join table to link appointments to service records
export const serviceRecordAppointments = pgTable("service_record_appointments", {
  id: serial("id").primaryKey(),
  serviceRecordId: integer("service_record_id").notNull().references(() => monthlyServiceRecords.id, { onDelete: "cascade" }),
  appointmentId: integer("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("service_record_appointment_unique").on(table.serviceRecordId, table.appointmentId),
  index("service_record_appointments_record_idx").on(table.serviceRecordId),
  index("service_record_appointments_appointment_idx").on(table.appointmentId),
]);

// Insert schemas
export const insertServiceRecordSchema = z.object({
  customerId: z.number(),
  employeeId: z.number(),
  year: z.number().min(2020).max(2100),
  month: z.number().min(1).max(12),
});

export const signServiceRecordSchema = z.object({
  signatureData: z.string().min(1, "Unterschrift ist erforderlich"),
  signerType: z.enum(["employee", "customer"]),
});

export type MonthlyServiceRecord = typeof monthlyServiceRecords.$inferSelect;
export type InsertServiceRecord = z.infer<typeof insertServiceRecordSchema>;
export type SignServiceRecord = z.infer<typeof signServiceRecordSchema>;
export type ServiceRecordAppointment = typeof serviceRecordAppointments.$inferSelect;

// ============================================
// TASKS (AUFGABEN) TABLES
// ============================================

export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];

export const TASK_STATUSES = ["open", "in-progress", "completed"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  dueDate: date("due_date"),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("open"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id),
  assignedToUserId: integer("assigned_to_user_id").notNull().references(() => users.id),
  customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("tasks_assigned_to_idx").on(table.assignedToUserId),
  index("tasks_status_idx").on(table.status),
  index("tasks_due_date_idx").on(table.dueDate),
]);

export const insertTaskSchema = z.object({
  title: z.string().min(1, "Titel ist erforderlich").max(200, "Titel darf maximal 200 Zeichen haben"),
  description: z.string().max(2000, "Beschreibung darf maximal 2000 Zeichen haben").optional().nullable(),
  dueDate: z.string().optional().nullable(),
  priority: z.enum(TASK_PRIORITIES).optional().default("medium"),
  assignedToUserId: z.number().optional(),
  customerId: z.number().optional().nullable(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  dueDate: z.string().optional().nullable(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignedToUserId: z.number().optional(),
  customerId: z.number().optional().nullable(),
});

export type Task = typeof tasks.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type UpdateTask = z.infer<typeof updateTaskSchema>;

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

// ============================================
// SYSTEM SETTINGS
// ============================================

export const systemSettings = pgTable("system_settings", {
  id: serial("id").primaryKey(),
  autoBreaksEnabled: boolean("auto_breaks_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id),
});

export type SystemSettings = typeof systemSettings.$inferSelect;

export const updateSystemSettingsSchema = z.object({
  autoBreaksEnabled: z.boolean().optional(),
});

export type UpdateSystemSettings = z.infer<typeof updateSystemSettingsSchema>;

// ============================================
// EMPLOYEE MONTH CLOSINGS (MONATSABSCHLUSS)
// ============================================

export const employeeMonthClosings = pgTable("employee_month_closings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  closedAt: timestamp("closed_at").notNull().defaultNow(),
  closedByUserId: integer("closed_by_user_id").notNull().references(() => users.id),
  reopenedAt: timestamp("reopened_at"),
  reopenedByUserId: integer("reopened_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("month_closing_unique").on(table.userId, table.year, table.month),
  index("month_closing_user_idx").on(table.userId),
]);

export type EmployeeMonthClosing = typeof employeeMonthClosings.$inferSelect;

export const closeMonthSchema = z.object({
  year: z.number().min(2020).max(2100),
  month: z.number().min(1).max(12),
});

export type CloseMonthInput = z.infer<typeof closeMonthSchema>;

export const reopenMonthSchema = z.object({
  year: z.number().min(2020).max(2100),
  month: z.number().min(1).max(12),
  userId: z.number().int().positive(),
});

export type ReopenMonthInput = z.infer<typeof reopenMonthSchema>;
