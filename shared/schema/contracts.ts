import { pgTable, text, integer, serial, date, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { services } from "./services";
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
  // Pricing is now historized in customer_service_prices / customer_contract_rates.
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
}, (table) => [
  index("customer_contract_rates_contract_idx").on(table.contractId),
]);

// Contract schemas
export const CONTRACT_PERIOD_TYPES = ["week", "month", "year"] as const;
export const CONTRACT_STATUS = ["active", "paused", "terminated"] as const;

export const insertCustomerContractSchema = z.object({
  customerId: z.number(),
  contractDate: z.string().optional().nullable(),
  contractStart: z.string(),
  contractEnd: z.string().optional().nullable(),
  vereinbarteLeistungen: z.string().max(2000, "Maximal 2000 Zeichen").optional().nullable(),
  hoursPerPeriod: z.number().min(0, "Stunden dürfen nicht negativ sein").optional().default(0),
  periodType: z.enum(CONTRACT_PERIOD_TYPES).optional().default("month"),
  status: z.enum(CONTRACT_STATUS).optional().default("active"),
  notes: z.string().max(500, "Maximal 500 Zeichen").optional().nullable(),
});

export type CustomerContract = typeof customerContracts.$inferSelect;
export type InsertCustomerContract = z.infer<typeof insertCustomerContractSchema>;

// Service Rate schemas
export const insertServiceRateSchema = z.object({
  serviceCategory: z.enum(SERVICE_CATEGORIES),
  hourlyRateCents: z.number().min(0, "Betrag darf nicht negativ sein"), // Rate in cents
  validFrom: z.string(),
  validTo: z.string().optional().nullable(),
});

export type ServiceRate = typeof serviceRates.$inferSelect;
export type InsertServiceRate = z.infer<typeof insertServiceRateSchema>;

// Customer Contract Rate schemas
export const insertContractRateSchema = z.object({
  contractId: z.number(),
  serviceCategory: z.enum(SERVICE_CATEGORIES),
  hourlyRateCents: z.number().min(0, "Betrag darf nicht negativ sein"),
  validFrom: z.string(),
  validTo: z.string().optional().nullable(),
});

export type CustomerContractRate = typeof customerContractRates.$inferSelect;
export type InsertContractRate = z.infer<typeof insertContractRateSchema>;

// ============================================
// KONSOLIDIERTE PREIS-TABELLE (Task #1301)
// ============================================
// `prices` ist die EINE zeitversionierte Preisquelle hinter der `priceFor`-SSoT
// (`shared/domain/pricing/price-for.ts`). Sie ERSETZT mittelfristig die drei
// getrennten Alt-Tabellen:
//   - customer_service_prices  → scope="customer" (Kunden-Override pro Service)
//   - customer_contract_rates  → scope="customer" (Vertrags-/Stundensatz pro Kunde)
//   - service_rates            → scope="standard" (firmenweiter Standard)
// In dieser Phase wird sie NUR additiv aufgebaut (befüllt + hinter einem
// Default-OFF-Flag gelesen); die drei Alt-Tabellen bleiben unangetastet, bis der
// Cutover (Task #1303) durch Alrik freigegeben wird.
export const PRICE_SCOPES = ["standard", "customer"] as const;
export type PriceScopeKind = typeof PRICE_SCOPES[number];

// Herkunfts-Diskriminator für die NICHT-destruktive Parallel-Phase (Task #1301):
// `prices` spiegelt additiv alle drei Alt-Tabellen. Solange noch parallel gelesen
// wird, ersetzt diese Spalte die frühere Tabellen-IDENTITÄT als Provenienz —
// damit der Vertragssatz-Pfad NUR seine eigenen (`customer_contract_rates`)
// Zeilen anfasst und nicht versehentlich `customer_service_prices`-Zeilen
// desselben (Kunde, Service) mitschließt/liest. Beim Cutover (#1303) entfällt die
// Mehrfach-Herkunft je (Kunde, Service).
export const PRICE_ORIGINS = ["service_rates", "customer_service_prices", "customer_contract_rates"] as const;
export type PriceOriginKind = typeof PRICE_ORIGINS[number];

export const prices = pgTable("prices", {
  id: serial("id").primaryKey(),
  // "standard" = firmenweit (customerId NULL) · "customer" = Kunden-Override.
  scope: text("scope").notNull(),
  // Alt-Tabellen-Herkunft (s. PRICE_ORIGINS) — Provenienz in der Parallel-Phase.
  origin: text("origin").notNull(),
  // NULL bei scope="standard"; gesetzt bei scope="customer".
  customerId: integer("customer_id").references(() => customers.id, { onDelete: "cascade" }),
  serviceId: integer("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  // Integer-Cents (SSoT-Geldregel) — Existenz der Zeile gewinnt, auch cents=0.
  cents: integer("cents").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = offenes Ende (aktiv)
  // Soft-Delete (verlustfreier Ersatz des customer_service_prices-Modells).
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("prices_scope_service_idx").on(table.scope, table.serviceId),
  index("prices_customer_service_idx").on(table.customerId, table.serviceId),
]);

export const insertPriceSchema = z.object({
  scope: z.enum(PRICE_SCOPES),
  origin: z.enum(PRICE_ORIGINS),
  customerId: z.number().int().nullable().optional(),
  serviceId: z.number().int(),
  cents: z.number().int().min(0, "Betrag darf nicht negativ sein"),
  validFrom: z.string(),
  validTo: z.string().nullable().optional(),
});

export type Price = typeof prices.$inferSelect;
export type InsertPrice = z.infer<typeof insertPriceSchema>;
