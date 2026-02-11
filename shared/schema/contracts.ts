import { pgTable, text, integer, serial, date, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";

// ============================================
// CONTRACTS & PRICING
// ============================================

// Customer service contracts
export const customerContracts = pgTable("customer_contracts", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  contractDate: date("contract_date"), // Date contract was signed
  contractStart: date("contract_start").notNull(),
  contractEnd: date("contract_end"), // null = ongoing
  // Agreed services (free text description)
  vereinbarteLeistungen: text("vereinbarte_leistungen"),
  // Service scope (legacy, kept for backwards compatibility)
  hoursPerPeriod: integer("hours_per_period").notNull().default(0), // Total hours
  periodType: text("period_type").notNull().default("month"), // "week" | "month" | "year"
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

// Contract schemas
export const CONTRACT_PERIOD_TYPES = ["week", "month", "year"] as const;
export const CONTRACT_STATUS = ["active", "paused", "terminated"] as const;

export const insertCustomerContractSchema = z.object({
  customerId: z.number(),
  contractDate: z.string().optional().nullable(),
  contractStart: z.string(),
  contractEnd: z.string().optional().nullable(),
  vereinbarteLeistungen: z.string().max(2000).optional().nullable(),
  hoursPerPeriod: z.number().min(0).optional().default(0),
  periodType: z.enum(CONTRACT_PERIOD_TYPES).optional().default("month"),
  hauswirtschaftRateCents: z.number().min(0).optional().default(0),
  alltagsbegleitungRateCents: z.number().min(0).optional().default(0),
  kilometerRateCents: z.number().min(0).optional().default(0),
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
