import { pgTable, text, integer, serial, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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

// Task #1325 — Die Tabellen `service_rates` (firmenweiter Standardsatz) und
// `customer_contract_rates` (Vertrags-/Stundensatz pro Kunde) sind nach dem
// Konsolidierungs-Cutover (Task #1324) entfernt. Beide leben jetzt in der
// `prices`-SSoT: service_rates → scope="standard" (origin="service_rates"),
// customer_contract_rates → scope="customer" (origin="customer_contract_rates").
// Die Zod-Schemas + Domain-Typen bleiben als API-Contract erhalten.

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

// Task #1325 — explizite Domain-Form (früher `serviceRates.$inferSelect`),
// rekonstruiert aus der `prices`-SSoT (scope="standard").
export interface ServiceRate {
  id: number;
  serviceCategory: string;
  hourlyRateCents: number;
  validFrom: string;
  validTo: string | null;
  createdAt: Date;
  createdByUserId: number | null;
}
export type InsertServiceRate = z.infer<typeof insertServiceRateSchema>;

// Customer Contract Rate schemas
export const insertContractRateSchema = z.object({
  contractId: z.number(),
  serviceCategory: z.enum(SERVICE_CATEGORIES),
  hourlyRateCents: z.number().min(0, "Betrag darf nicht negativ sein"),
  validFrom: z.string(),
  validTo: z.string().optional().nullable(),
});

// Task #1325 — explizite Domain-Form (früher `customerContractRates.$inferSelect`),
// rekonstruiert aus der `prices`-SSoT (scope="customer", origin="customer_contract_rates").
export interface CustomerContractRate {
  id: number;
  contractId: number;
  serviceCategory: string;
  hourlyRateCents: number;
  validFrom: string;
  validTo: string | null;
  createdAt: Date;
  createdByUserId: number | null;
}
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
  // Verhindert zwei aktive Preise mit identischem validFrom je (scope, origin,
  // Kunde, Service) — Nachfolger des alten csp_customer_service_validfrom_active_idx.
  // scope+origin verhindern Fehl-Kollisionen zwischen verschiedenen Preis-Herkünften.
  uniqueIndex("prices_active_validfrom_uniq")
    .on(table.scope, table.origin, table.customerId, table.serviceId, table.validFrom)
    .where(sql`deleted_at IS NULL`),
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

// ============================================
// ROLLENBASIERTE VERGÜTUNG (Task #1503)
// ============================================
// `role_wage_rates` ist die EINE zeitversionierte Lohnsatz-Quelle hinter der
// `wageFor`-SSoT (`shared/domain/pricing/wage-for.ts`) — analog zur `prices`-SSoT
// hinter `priceFor`. Sie ERSETZT den flachen Katalogwert
// (`services.employee_rate_cents`) als Override-Quelle UND die schlafende
// `employee_compensation_history` (datierte, nie befüllte Mitarbeiter-Sätze).
//
// Auflösung (Mitarbeiter × Leistung × Datum):
//   1. Rollen-Satz (Rolle × Leistung, datiert) — diese Tabelle
//   2. Katalog-Standardvergütung (`services.employee_rate_cents`) — Fallback
//
// Rolle = die des LEISTENDEN Mitarbeiters (admin > teamLead > employee), nicht
// des Anfragenden — abgeleitet über `wageRoleForUserFlags`.
//
// Append-only/GoBD: bestehende Zeilen werden NIE in-place überschrieben; eine
// Änderung ist immer eine neue versionierte Zeile (Phasen-Append + Soft-Delete
// bei identischem validFrom). Partieller Unique-Index verhindert zwei aktive
// Sätze mit identischem validFrom je (Rolle, Service).
export const WAGE_ROLES = ["admin", "teamLead", "employee"] as const;
export type WageRole = typeof WAGE_ROLES[number];

export const roleWageRates = pgTable("role_wage_rates", {
  id: serial("id").primaryKey(),
  // Rolle des leistenden Mitarbeiters (s. WAGE_ROLES).
  role: text("role").notNull(),
  serviceId: integer("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  // Absoluter Stundensatz in Integer-Cents (SSoT-Geldregel) — Existenz der Zeile
  // gewinnt, auch cents=0.
  cents: integer("cents").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"), // null = offenes Ende (aktiv)
  // Soft-Delete (verlustfreier Ersatz bei identischem validFrom).
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("role_wage_rates_role_service_idx").on(table.role, table.serviceId),
  // Verhindert zwei aktive Sätze mit identischem validFrom je (Rolle, Service).
  uniqueIndex("role_wage_rates_active_validfrom_uniq")
    .on(table.role, table.serviceId, table.validFrom)
    .where(sql`deleted_at IS NULL`),
]);

export const insertRoleWageRateSchema = z.object({
  role: z.enum(WAGE_ROLES),
  serviceId: z.number().int(),
  cents: z.number().int().min(0, "Betrag darf nicht negativ sein"),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format YYYY-MM-DD sein").optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum muss im Format YYYY-MM-DD sein").nullable().optional(),
});

export type RoleWageRate = typeof roleWageRates.$inferSelect;
export type InsertRoleWageRate = z.infer<typeof insertRoleWageRateSchema>;
