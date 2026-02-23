import { pgTable, text, integer, serial, date, boolean, unique, index, real } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";

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
  eintrittsdatum: date("eintrittsdatum"),
  austrittsDatum: date("austritts_datum"),
  vacationDaysPerYear: integer("vacation_days_per_year").notNull().default(30),
  employmentStatus: text("employment_status").notNull().default("aktiv"),
  isActive: boolean("is_active").notNull().default(true),
  deactivatedAt: timestamp("deactivated_at"),
  isAnonymized: boolean("is_anonymized").notNull().default(false),
  anonymizedAt: timestamp("anonymized_at"),
  isAdmin: boolean("is_admin").notNull().default(false),
  haustierAkzeptiert: boolean("haustier_akzeptiert").notNull().default(true),
  isEuRentner: boolean("is_eu_rentner").notNull().default(false),
  employmentType: text("employment_type").notNull().default("sozialversicherungspflichtig"), // "minijobber" | "sozialversicherungspflichtig"
  weeklyWorkDays: integer("weekly_work_days").notNull().default(5),
  monthlyWorkHours: real("monthly_work_hours"),
  lbnr: text("lbnr"),
  personalnummer: text("personalnummer"),
  notfallkontaktName: text("notfallkontakt_name"),
  notfallkontaktTelefon: text("notfallkontakt_telefon"),
  notfallkontaktBeziehung: text("notfallkontakt_beziehung"),
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
  index("user_roles_user_id_idx").on(table.userId),
]);

// Sessions for authentication
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("sessions_user_id_idx").on(table.userId),
  index("sessions_expires_at_idx").on(table.expiresAt),
]);

// Password reset tokens
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("password_reset_tokens_user_idx").on(table.userId),
]);

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

export const EMPLOYMENT_TYPES = ["minijobber", "sozialversicherungspflichtig"] as const;
export type EmploymentType = typeof EMPLOYMENT_TYPES[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  minijobber: "Minijobber",
  sozialversicherungspflichtig: "Sozialversicherungspflichtig",
};

export const EMPLOYMENT_STATUSES = ["in_einstellung", "aktiv", "inaktiv"] as const;
export type EmploymentStatus = typeof EMPLOYMENT_STATUSES[number];

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  in_einstellung: "In Einstellung",
  aktiv: "Aktiv",
  inaktiv: "Inaktiv",
};

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
  eintrittsdatum: z.string().optional(),
  vacationDaysPerYear: z.number().int().min(0).max(365).optional().default(30),
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional().default("aktiv"),
  isAdmin: z.boolean().optional().default(false),
  haustierAkzeptiert: z.boolean().optional().default(true),
  isEuRentner: z.boolean().optional().default(false),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional().default("sozialversicherungspflichtig"),
  weeklyWorkDays: z.number().int().min(1).max(7).optional().default(5),
  monthlyWorkHours: z.number().min(1).max(300).optional().nullable(),
  lbnr: z.string().optional().nullable(),
  personalnummer: z.string().optional().nullable(),
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
