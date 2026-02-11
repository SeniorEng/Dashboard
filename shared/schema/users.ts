import { pgTable, text, integer, serial, date, boolean, unique, index } from "drizzle-orm/pg-core";
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
  index("user_roles_user_id_idx").on(table.userId),
]);

// Sessions for authentication
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
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
