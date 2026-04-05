import { pgTable, text, integer, serial, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";

export const WHATSAPP_EVENT_TYPES = [
  "appointment_created",
  "appointment_updated",
  "appointment_reminder",
  "customer_assigned",
  "task_assigned",
  "birthday_reminder",
  "month_close_reminder",
] as const;
export type WhatsAppEventType = typeof WHATSAPP_EVENT_TYPES[number];

export const WHATSAPP_EVENT_LABELS: Record<WhatsAppEventType, string> = {
  appointment_created: "Neuer Termin zugewiesen",
  appointment_updated: "Termin geändert/verschoben",
  appointment_reminder: "Tägliche Termin-Erinnerung",
  customer_assigned: "Kunde zugewiesen",
  task_assigned: "Aufgabe zugewiesen",
  birthday_reminder: "Geburtstags-Erinnerung",
  month_close_reminder: "Monatsabschluss-Erinnerung",
};

export const WHATSAPP_EVENT_DEEP_LINKS: Record<WhatsAppEventType, string> = {
  appointment_created: "/appointment/{id}",
  appointment_updated: "/appointment/{id}",
  appointment_reminder: "/",
  customer_assigned: "/customers/{id}",
  task_assigned: "/tasks",
  birthday_reminder: "/admin/birthday-cards",
  month_close_reminder: "/time-entries",
};

export const whatsappNotificationRules = pgTable("whatsapp_notification_rules", {
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  templateName: text("template_name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("whatsapp_rules_event_type_unique").on(table.eventType),
]);

export const insertWhatsAppNotificationRuleSchema = createInsertSchema(whatsappNotificationRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type WhatsAppNotificationRule = typeof whatsappNotificationRules.$inferSelect;
export type InsertWhatsAppNotificationRule = z.infer<typeof insertWhatsAppNotificationRuleSchema>;

export const userWhatsappPreferences = pgTable("user_whatsapp_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  enabled: boolean("enabled").notNull().default(false),
  whatsappNumber: text("whatsapp_number"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("user_whatsapp_prefs_user_id_unique").on(table.userId),
]);

export const insertUserWhatsappPreferencesSchema = createInsertSchema(userWhatsappPreferences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type UserWhatsappPreferences = typeof userWhatsappPreferences.$inferSelect;
export type InsertUserWhatsappPreferences = z.infer<typeof insertUserWhatsappPreferencesSchema>;

export const WHATSAPP_MESSAGE_STATUSES = ["sent", "failed", "queued"] as const;
export type WhatsAppMessageStatus = typeof WHATSAPP_MESSAGE_STATUSES[number];

export const whatsappMessageLog = pgTable("whatsapp_message_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  eventType: text("event_type").notNull(),
  templateName: text("template_name").notNull(),
  phoneNumber: text("phone_number").notNull(),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  metaMessageId: text("meta_message_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("whatsapp_log_user_idx").on(table.userId),
  index("whatsapp_log_created_idx").on(table.createdAt),
]);

export const insertWhatsAppMessageLogSchema = createInsertSchema(whatsappMessageLog).omit({
  id: true,
  createdAt: true,
});
export type WhatsAppMessageLog = typeof whatsappMessageLog.$inferSelect;
export type InsertWhatsAppMessageLog = z.infer<typeof insertWhatsAppMessageLogSchema>;

export const updateWhatsAppConfigSchema = z.object({
  whatsappAccessToken: z.string().nullable().optional(),
  whatsappPhoneNumberId: z.string().nullable().optional(),
  whatsappBusinessAccountId: z.string().nullable().optional(),
  whatsappEnabled: z.boolean().optional(),
});
export type UpdateWhatsAppConfig = z.infer<typeof updateWhatsAppConfigSchema>;

export const updateUserWhatsAppPreferencesSchema = z.object({
  enabled: z.boolean(),
  whatsappNumber: z.string().nullable().optional(),
});
export type UpdateUserWhatsAppPreferencesInput = z.infer<typeof updateUserWhatsAppPreferencesSchema>;

export const updateWhatsAppRulesSchema = z.object({
  rules: z.array(z.object({
    id: z.number(),
    enabled: z.boolean(),
    templateName: z.string().min(1, "Template-Name ist erforderlich"),
  })),
});
export type UpdateWhatsAppRulesInput = z.infer<typeof updateWhatsAppRulesSchema>;
