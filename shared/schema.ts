import { pgTable, text, integer, timestamp, serial, time, date, boolean, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js";

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
  hourlyRateHauswirtschaft: text("hourly_rate_hauswirtschaft"), // €/Stunde as string for decimal precision
  hourlyRateAlltagsbegleitung: text("hourly_rate_alltagsbegleitung"), // €/Stunde as string for decimal precision
  travelCostType: text("travel_cost_type"), // "kilometergeld" | "pauschale"
  kilometerRate: text("kilometer_rate"), // €/km if travelCostType is "kilometergeld"
  monthlyTravelAllowance: text("monthly_travel_allowance"), // €/Monat if travelCostType is "pauschale"
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
  hourlyRateHauswirtschaft: z.string().nullable().optional(),
  hourlyRateAlltagsbegleitung: z.string().nullable().optional(),
  travelCostType: z.enum(TRAVEL_COST_TYPES).nullable().optional(),
  kilometerRate: z.string().nullable().optional(),
  monthlyTravelAllowance: z.string().nullable().optional(),
  validFrom: z.string(), // ISO date string
}).refine((data) => {
  if (data.travelCostType === "kilometergeld") {
    return data.kilometerRate && !data.monthlyTravelAllowance;
  }
  if (data.travelCostType === "pauschale") {
    return data.monthlyTravelAllowance && !data.kilometerRate;
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
  avatar: text("avatar").notNull().default("person"),
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

// Lookup table for Pflegekassen (insurance providers)
export const insuranceProviders = pgTable("insurance_providers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  ikNummer: text("ik_nummer").notNull().unique(), // 9-digit Institutionskennzeichen
  strasse: text("strasse"),
  hausnummer: text("hausnummer"),
  plz: text("plz"),
  stadt: text("stadt"),
  telefon: text("telefon"),
  email: text("email"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
});

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
});

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
// BUDGETS (historized)
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
});

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
  // Legacy kilometers field (kept for backwards compatibility)
  kilometers: text("kilometers"),
  notes: text("notes"),
  servicesDone: text("services_done").array().default([]),
  signatureData: text("signature_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("appointments_customer_id_idx").on(table.customerId),
  index("appointments_date_idx").on(table.date),
  index("appointments_assigned_employee_id_idx").on(table.assignedEmployeeId),
  index("appointments_date_customer_id_idx").on(table.date, table.customerId),
  index("appointments_status_date_idx").on(table.status, table.date),
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
  name: z.string().min(1, "Name ist erforderlich"),
  ikNummer: ikNummerSchema,
  strasse: z.string().optional(),
  hausnummer: z.string().optional(),
  plz: plzSchema.optional(),
  stadt: z.string().optional(),
  telefon: optionalGermanPhoneSchema,
  email: z.string().email("Ungültige E-Mail-Adresse").optional().nullable(),
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

// Budget schemas
export const insertCustomerBudgetSchema = z.object({
  customerId: z.number(),
  entlastungsbetrag45b: z.number().min(0).default(0), // In cents
  verhinderungspflege39: z.number().min(0).default(0), // In cents
  pflegesachleistungen36: z.number().min(0).default(0), // In cents
  validFrom: z.string(),
  validTo: z.string().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export type CustomerBudget = typeof customerBudgets.$inferSelect;
export type InsertCustomerBudget = z.infer<typeof insertCustomerBudgetSchema>;

// Contract schemas
export const CONTRACT_PERIOD_TYPES = ["week", "month", "year"] as const;
export const CONTRACT_STATUS = ["active", "paused", "terminated"] as const;

export const insertCustomerContractSchema = z.object({
  customerId: z.number(),
  contractStart: z.string(),
  contractEnd: z.string().optional().nullable(),
  hoursPerPeriod: z.number().min(1),
  periodType: z.enum(CONTRACT_PERIOD_TYPES),
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
  
  // Prices (in euros, will convert to cents)
  hauswirtschaftRate: z.number().min(0).optional(),
  alltagsbegleitungRate: z.number().min(0).optional(),
});

export type CreateFullCustomer = z.infer<typeof createFullCustomerSchema>;

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
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  entryType: text("entry_type").notNull(), // TimeEntryType
  entryDate: date("entry_date").notNull(),
  startTime: time("start_time"), // Optional for full-day entries like vacation
  endTime: time("end_time"),     // Optional for full-day entries
  isFullDay: boolean("is_full_day").notNull().default(false),
  durationMinutes: integer("duration_minutes"), // Calculated or manual for breaks
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
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
