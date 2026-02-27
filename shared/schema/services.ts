import { pgTable, text, integer, serial, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";

export const SERVICE_UNIT_TYPES = ["hours", "kilometers", "flat"] as const;
export type ServiceUnitType = typeof SERVICE_UNIT_TYPES[number];

export const SYSTEM_SERVICE_CODES = ["travel_km", "customer_km"] as const;
export type SystemServiceCode = typeof SYSTEM_SERVICE_CODES[number];

export const services = pgTable("services", {
  id: serial("id").primaryKey(),
  code: text("code").unique(),
  name: text("name").notNull(),
  description: text("description"),
  unitType: text("unit_type").notNull(),
  defaultPriceCents: integer("default_price_cents").notNull().default(0),
  vatRate: integer("vat_rate").notNull().default(19),
  minDurationMinutes: integer("min_duration_minutes"),
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  isSystem: boolean("is_system").notNull().default(false),
  isBillable: boolean("is_billable").notNull().default(true),
  employeeRateCents: integer("employee_rate_cents").notNull().default(0),
  lohnartKategorie: text("lohnart_kategorie").notNull().default("hauswirtschaft"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("services_active_sort_idx").on(table.isActive, table.sortOrder),
]);

export const serviceBudgetPots = pgTable("service_budget_pots", {
  id: serial("id").primaryKey(),
  serviceId: integer("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  budgetType: text("budget_type").notNull(),
}, (table) => [
  index("service_budget_pots_service_idx").on(table.serviceId),
  uniqueIndex("service_budget_pots_unique_idx").on(table.serviceId, table.budgetType),
]);

export const customerServicePrices = pgTable("customer_service_prices", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),
  serviceId: integer("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  priceCents: integer("price_cents").notNull(),
  validFrom: timestamp("valid_from").notNull().defaultNow(),
  validTo: timestamp("valid_to"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("csp_customer_service_idx").on(table.customerId, table.serviceId),
  uniqueIndex("csp_customer_service_active_idx").on(table.customerId, table.serviceId, table.validTo),
]);

export const insertCustomerServicePriceSchema = z.object({
  customerId: z.number().int(),
  serviceId: z.number().int(),
  priceCents: z.number().int().min(0, "Preis muss positiv sein"),
});

export type CustomerServicePrice = typeof customerServicePrices.$inferSelect;
export type InsertCustomerServicePrice = z.infer<typeof insertCustomerServicePriceSchema>;

export const insertServiceSchema = z.object({
  code: z.string().max(50, "Maximal 50 Zeichen").nullable().optional(),
  name: z.string().min(1, "Name ist erforderlich").max(100, "Maximal 100 Zeichen"),
  description: z.string().max(250, "Maximal 250 Zeichen").nullable().optional(),
  unitType: z.enum(SERVICE_UNIT_TYPES),
  defaultPriceCents: z.number().int().min(0, "Preis muss positiv sein"),
  vatRate: z.number().int().min(0, "MwSt-Satz darf nicht negativ sein").max(100, "MwSt-Satz darf maximal 100% sein").default(19),
  minDurationMinutes: z.number().int().min(1, "Mindestdauer muss mindestens 1 Minute sein").nullable().optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  isBillable: z.boolean().default(true),
  employeeRateCents: z.number().int().min(0, "Betrag darf nicht negativ sein").default(0),
  lohnartKategorie: z.enum(["alltagsbegleitung", "hauswirtschaft"]).default("hauswirtschaft"),
  sortOrder: z.number().int().default(0),
  budgetPots: z.array(z.enum(["entlastungsbetrag_45b", "umwandlung_45a", "ersatzpflege_39_42a"])).default([]),
});

export const updateServiceSchema = insertServiceSchema.partial();

export type Service = typeof services.$inferSelect;
export type InsertService = z.infer<typeof insertServiceSchema>;
export type ServiceBudgetPot = typeof serviceBudgetPots.$inferSelect;
