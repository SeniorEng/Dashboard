import { pgTable, text, integer, serial, date, boolean, index, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";
import { appointments } from "./appointments";

// ============================================
// BUDGET LEDGER SYSTEM (§45b, §45a, §39/§42a)
// ============================================
//
// Hinweis (Task #743): Die Legacy-Tabelle `customer_budgets` (eingefroren
// in Task #728 Phase 2.1) ist endgültig entfernt. SSoT für Topf-
// Konfiguration ist `customer_budget_type_settings`.

// Budget allocation sources
export const BUDGET_ALLOCATION_SOURCES = [
  "monthly_auto",      // Regular monthly auto-allocation
  "carryover",         // Carryover from previous year (expires June 30)
  "initial_balance",   // Initial balance when customer joins
  "manual_adjustment", // Manual correction/adjustment
  "yearly_auto",       // Yearly auto-allocation (for §39/§42a)
  "statutory_monthly", // Materialized §45b monthly statutory top-up (Task #872)
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
  source: text("source").notNull(), // monthly_auto, carryover, initial_balance, manual_adjustment, yearly_auto
  validFrom: date("valid_from").notNull(), // When this allocation becomes available
  expiresAt: date("expires_at"), // null = never expires, set for carryover (June 30)
  notes: text("notes"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("budget_allocations_customer_idx").on(table.customerId),
  index("budget_allocations_customer_year_idx").on(table.customerId, table.year),
  index("budget_allocations_expires_idx").on(table.expiresAt),
  index("budget_allocations_fifo_idx").on(table.customerId, table.budgetType, table.validFrom),
  // Partial UNIQUE (Task #440): nur lebende Zeilen (deleted_at IS NULL) dürfen
  // pro (customer, budgetType, year, month, source) eindeutig sein. So können
  // soft-gelöschte Vorgänger-Allokationen GoBD-konform erhalten bleiben, ohne
  // die Wiederanlage zu blockieren — kein "deletedAt=null"-Resurrect mehr.
  uniqueIndex("budget_allocations_auto_unique_idx")
    .on(table.customerId, table.budgetType, table.year, table.month, table.source)
    .where(sql`deleted_at IS NULL`),
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
  travelKilometers: numeric("travel_kilometers", { precision: 10, scale: 3, mode: "number" }),
  travelCents: integer("travel_cents"),
  customerKilometers: numeric("customer_kilometers", { precision: 10, scale: 3, mode: "number" }),
  customerKilometersCents: integer("customer_kilometers_cents"),
  // Reference to source
  appointmentId: integer("appointment_id").references(() => appointments.id),
  allocationId: integer("allocation_id").references(() => budgetAllocations.id),
  reversedTransactionId: integer("reversed_transaction_id"),
  importBatchId: integer("import_batch_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("budget_transactions_customer_idx").on(table.customerId),
  index("budget_transactions_customer_date_idx").on(table.customerId, table.transactionDate),
  index("budget_transactions_appointment_idx").on(table.appointmentId),
  index("budget_transactions_allocation_idx").on(table.allocationId),
  index("budget_transactions_allocation_type_idx").on(table.allocationId, table.transactionType),
  index("budget_transactions_customer_type_txtype_idx").on(table.customerId, table.budgetType, table.transactionType),
  uniqueIndex("budget_transactions_reversal_unique_idx")
    .on(table.reversedTransactionId)
    .where(sql`transaction_type = 'reversal' AND reversed_transaction_id IS NOT NULL`),
  // Verhindert doppelte Verfalls-Buchungen pro Allokation (z. B. bei
  // parallelen Reconcile-Läufen). Pendant zur ON-CONFLICT-Idempotenz.
  uniqueIndex("budget_transactions_write_off_unique_idx")
    .on(table.customerId, table.allocationId)
    .where(sql`transaction_type = 'write_off' AND allocation_id IS NOT NULL`),
]);

// Customer budget preferences (monthly limit, etc.)
export const customerBudgetPreferences = pgTable("customer_budget_preferences", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }).unique(),
  monthlyLimitCents: integer("monthly_limit_cents"), // Desired monthly usage limit (null = no limit, use full 131€)
  budgetStartDate: date("budget_start_date"), // When customer started using budget (for pro-rata calculation)
  // Task #856 — Herkunft des budgetStartDate: 'derived_pflegegrad' = automatisch
  // aus dem Pflegegrad-Beginn abgeleitet (Wizard/initial-budget) → §45b-Lesepfad
  // kappt den Anker aufs rechtliche Fenster. 'manual' = explizit vom Admin
  // gesetzt (PUT /preferences) → niemals kappen (manuell gewinnt immer). NULL =
  // Altbestand vor #856, wird wie 'manual' behandelt (kein stilles Umrechnen).
  budgetStartDateOrigin: text("budget_start_date_origin"),
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
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Partial UNIQUE (Task #440): pro Kunde+BudgetType darf nur eine offene Zeile
  // (validTo IS NULL) existieren. Historisierte (geschlossene) Zeilen behalten
  // ihre Historie ohne Unique-Konflikt — GoBD-konformer Append-only-Pfad.
  uniqueIndex("customer_budget_type_settings_unique_idx")
    .on(table.customerId, table.budgetType)
    .where(sql`valid_to IS NULL`),
  index("customer_budget_type_settings_customer_idx").on(table.customerId),
]);

// ============================================
// THREE-TABLE MODEL (Budget GF Phase 1, Task #871)
// ============================================
//
// `budget_allocations` (oben) = "was existiert" (Credits).
// `budget_ledger`            = finanzielle Buchungen (GoBD-immutable, append-only).
// `budget_reservations`      = operative Holds (NICHT GoBD, mutierbar, audit-logged).
//
// Phase 1 ist FOUNDATIONS-ONLY: die Tabellen existieren, der Ledger ist per
// Startup-Trigger append-only (server/startup/ensure-budget-ledger-immutability.ts),
// aber es schreibt noch KEIN Pfad in sie. Die Buchung läuft weiter ausschließlich
// über `budget_transactions` (Legacy-Engine), jetzt über die pure `planCascade`
// (shared/domain/budget/plan-cascade.ts) geroutet — byte-identisch. Reservations
// (Phase 5) und §45b-Materialisierung (Phase 2) sind explizit NICHT Teil von Phase 1.

// budget_ledger / budget_reservations Zustände
export const BUDGET_LEDGER_STATES = ["consumed", "reversed"] as const;
export type BudgetLedgerState = typeof BUDGET_LEDGER_STATES[number];

export const BUDGET_RESERVATION_STATES = ["hold", "captured", "released", "expired"] as const;
export type BudgetReservationState = typeof BUDGET_RESERVATION_STATES[number];

// budget_ledger — finanzielle Bookings (GoBD-immutable, append-only).
// Nur `consumed`/`reversed`-Zeilen; eine Korrektur ist eine NEUE `reversed`-Zeile
// plus eine frische `consumed`-Zeile, niemals ein In-Place-Edit.
export const budgetLedger = pgTable("budget_ledger", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  appointmentId: integer("appointment_id").references(() => appointments.id),
  occurrenceId: text("occurrence_id"), // recurring-series occurrence (null = single)
  allocationId: integer("allocation_id").references(() => budgetAllocations.id),
  budgetType: text("budget_type").notNull(),
  period: text("period"), // z.B. "2026-05" (Monat) oder "2026" (Jahr); informativ
  transactionDate: date("transaction_date").notNull(),
  state: text("state").notNull(), // consumed | reversed
  amountCents: integer("amount_cents").notNull(), // negativ für consumed
  hauswirtschaftMinutes: integer("hauswirtschaft_minutes"),
  hauswirtschaftCents: integer("hauswirtschaft_cents"),
  alltagsbegleitungMinutes: integer("alltagsbegleitung_minutes"),
  alltagsbegleitungCents: integer("alltagsbegleitung_cents"),
  travelKilometers: numeric("travel_kilometers", { precision: 10, scale: 3, mode: "number" }),
  travelCents: integer("travel_cents"),
  customerKilometers: numeric("customer_kilometers", { precision: 10, scale: 3, mode: "number" }),
  customerKilometersCents: integer("customer_kilometers_cents"),
  reversesLedgerId: integer("reverses_ledger_id"), // → budget_ledger.id der stornierten Buchung
  idempotencyKey: text("idempotency_key").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("budget_ledger_customer_idx").on(table.customerId),
  index("budget_ledger_customer_date_idx").on(table.customerId, table.transactionDate),
  index("budget_ledger_appointment_idx").on(table.appointmentId),
  index("budget_ledger_allocation_idx").on(table.allocationId),
  // Idempotenz (R5): jede Ledger-mutierende Operation trägt einen eindeutigen Key.
  uniqueIndex("budget_ledger_idempotency_key_idx").on(table.idempotencyKey),
  // Post-or-void-once: pro stornierter Buchung höchstens eine reversal-Zeile.
  uniqueIndex("budget_ledger_reverses_unique_idx")
    .on(table.reversesLedgerId)
    .where(sql`reverses_ledger_id IS NOT NULL`),
]);

// budget_reservations — operative Holds (NICHT GoBD). Mutierbar, jeder
// State-Übergang wird audit-logged. Aus GoBD-/Finanz-Exporten ausgeschlossen.
export const budgetReservations = pgTable("budget_reservations", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  appointmentId: integer("appointment_id").references(() => appointments.id),
  occurrenceId: text("occurrence_id"),
  allocationId: integer("allocation_id").references(() => budgetAllocations.id),
  budgetType: text("budget_type").notNull(),
  period: text("period"),
  amountCents: integer("amount_cents").notNull(),
  hauswirtschaftMinutes: integer("hauswirtschaft_minutes"),
  hauswirtschaftCents: integer("hauswirtschaft_cents"),
  alltagsbegleitungMinutes: integer("alltagsbegleitung_minutes"),
  alltagsbegleitungCents: integer("alltagsbegleitung_cents"),
  travelKilometers: numeric("travel_kilometers", { precision: 10, scale: 3, mode: "number" }),
  travelCents: integer("travel_cents"),
  customerKilometers: numeric("customer_kilometers", { precision: 10, scale: 3, mode: "number" }),
  customerKilometersCents: integer("customer_kilometers_cents"),
  state: text("state").notNull().default("hold"), // hold | captured | released | expired
  idempotencyKey: text("idempotency_key").notNull(),
  expiresAt: timestamp("expires_at"),
  capturedLedgerId: integer("captured_ledger_id").references(() => budgetLedger.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("budget_reservations_customer_idx").on(table.customerId),
  index("budget_reservations_appointment_idx").on(table.appointmentId),
  index("budget_reservations_allocation_idx").on(table.allocationId),
  index("budget_reservations_state_idx").on(table.customerId, table.state),
  uniqueIndex("budget_reservations_idempotency_key_idx").on(table.idempotencyKey),
]);

// budget_ledger / budget_reservations schemas + types
export const insertBudgetLedgerSchema = createInsertSchema(budgetLedger).omit({
  id: true,
  createdAt: true,
}).extend({
  state: z.enum(BUDGET_LEDGER_STATES),
});

export type BudgetLedgerRow = typeof budgetLedger.$inferSelect;
export type InsertBudgetLedger = z.infer<typeof insertBudgetLedgerSchema>;

export const insertBudgetReservationSchema = createInsertSchema(budgetReservations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  state: z.enum(BUDGET_RESERVATION_STATES).default("hold"),
});

export type BudgetReservation = typeof budgetReservations.$inferSelect;
export type InsertBudgetReservation = z.infer<typeof insertBudgetReservationSchema>;

// Budget Allocation schemas (Ledger system)
export const insertBudgetAllocationSchema = z.object({
  customerId: z.number(),
  budgetType: z.string().default("entlastungsbetrag_45b"),
  year: z.number().min(2020, "Jahr muss zwischen 2020 und 2100 liegen").max(2100, "Jahr muss zwischen 2020 und 2100 liegen"),
  month: z.number().min(1, "Monat muss zwischen 1 und 12 liegen").max(12, "Monat muss zwischen 1 und 12 liegen").nullable().optional(),
  amountCents: z.number().min(0, "Betrag darf nicht negativ sein"),
  source: z.enum(BUDGET_ALLOCATION_SOURCES),
  validFrom: z.string(),
  expiresAt: z.string().nullable().optional(),
  notes: z.string().max(500, "Maximal 500 Zeichen").nullable().optional(),
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
  notes: z.string().max(500, "Maximal 500 Zeichen").nullable().optional(),
});

export type BudgetTransaction = typeof budgetTransactions.$inferSelect;
export type InsertBudgetTransaction = z.infer<typeof insertBudgetTransactionSchema>;

// Customer Budget Preferences schemas
export const insertBudgetPreferencesSchema = z.object({
  customerId: z.number(),
  monthlyLimitCents: z.number().min(0, "Wert darf nicht negativ sein").nullable().optional(),
  budgetStartDate: z.string().nullable().optional(),
  budgetStartDateOrigin: z.enum(["derived_pflegegrad", "manual"]).nullable().optional(),
  notes: z.string().max(500, "Maximal 500 Zeichen").nullable().optional(),
});

export const updateBudgetPreferencesSchema = insertBudgetPreferencesSchema.partial().omit({ customerId: true });

export type CustomerBudgetPreferences = typeof customerBudgetPreferences.$inferSelect;
export type InsertBudgetPreferences = z.infer<typeof insertBudgetPreferencesSchema>;

// Customer Budget Type Settings schemas
export const insertBudgetTypeSettingsSchema = createInsertSchema(customerBudgetTypeSettings).omit({
  id: true,
}).extend({
  budgetType: z.enum(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"]),
  priority: z.number().min(1, "Priorität muss zwischen 1 und 3 liegen").max(3, "Priorität muss zwischen 1 und 3 liegen"),
  monthlyLimitCents: z.number().min(0, "Wert darf nicht negativ sein").nullable().optional(),
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
  /** Im laufenden Kalendermonat noch buchbar (Cap- und Topf-aware). Siehe BudgetSummary in `server/storage/budget/types.ts`. */
  currentMonthAvailableCents: number;
  isCurrentlyActive: boolean;
}
