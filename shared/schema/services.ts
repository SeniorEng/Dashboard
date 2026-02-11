import { pgTable, text, integer, serial, date, boolean, index } from "drizzle-orm/pg-core";
import { z } from "zod";
import { timestamp } from "./common";
import { customers } from "./customers";
import { users } from "./users";

// ============================================
// SERVICE CATALOG (centrally managed)
// ============================================

export const SERVICE_UNIT_TYPES = ["hours", "kilometers", "flat"] as const;
export type ServiceUnitType = typeof SERVICE_UNIT_TYPES[number];

export const SERVICE_BILLING_CATEGORIES = ["hauswirtschaft", "alltagsbegleitung", "none"] as const;
export type ServiceBillingCategory = typeof SERVICE_BILLING_CATEGORIES[number];

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
  billingCategory: text("billing_category").notNull().default("none"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("services_active_sort_idx").on(table.isActive, table.sortOrder),
]);

export const customerServicePrices = pgTable("customer_service_prices", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  serviceId: integer("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  priceCents: integer("price_cents").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("customer_service_prices_customer_idx").on(table.customerId),
  index("customer_service_prices_service_idx").on(table.serviceId),
  index("customer_service_prices_valid_idx").on(table.customerId, table.serviceId, table.validFrom, table.validTo),
]);

// Service catalog schemas
export const insertServiceSchema = z.object({
  code: z.string().max(50).nullable().optional(),
  name: z.string().min(1, "Name ist erforderlich").max(100),
  description: z.string().max(250).nullable().optional(),
  unitType: z.enum(SERVICE_UNIT_TYPES),
  defaultPriceCents: z.number().int().min(0, "Preis muss positiv sein"),
  vatRate: z.number().int().min(0).max(100).default(19),
  minDurationMinutes: z.number().int().min(1).nullable().optional(),
  isActive: z.boolean().default(true),
  billingCategory: z.enum(SERVICE_BILLING_CATEGORIES).default("none"),
  sortOrder: z.number().int().default(0),
});

export const updateServiceSchema = insertServiceSchema.partial();

export type Service = typeof services.$inferSelect;
export type InsertService = z.infer<typeof insertServiceSchema>;

export const insertCustomerServicePriceSchema = z.object({
  customerId: z.number(),
  serviceId: z.number(),
  priceCents: z.number().int().min(0, "Preis muss positiv sein"),
  validFrom: z.string(),
  validTo: z.string().nullable().optional(),
});

export type CustomerServicePrice = typeof customerServicePrices.$inferSelect;
export type InsertCustomerServicePrice = z.infer<typeof insertCustomerServicePriceSchema>;
