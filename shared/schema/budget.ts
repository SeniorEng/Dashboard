import { pgTable, text, integer, serial, date, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";
import { appointments } from "./appointments";
import { BUDGET_45B_MAX_MONTHLY_CENTS, BUDGET_39_42A_MAX_YEARLY_CENTS } from "../domain/budgets";

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
  index("customer_budgets_valid_idx").on(table.customerId, table.validTo),
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
  yearlyLimitCents: integer("yearly_limit_cents"),
  initialBalanceCents: integer("initial_balance_cents"),
  initialBalanceMonth: text("initial_balance_month"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("customer_budget_type_settings_unique_idx").on(table.customerId, table.budgetType),
  index("customer_budget_type_settings_customer_idx").on(table.customerId),
]);

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
