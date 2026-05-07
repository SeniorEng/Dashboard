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

// Twilio Content SID Format: HX gefolgt von 32 Hex-Zeichen
export const TWILIO_CONTENT_SID_PATTERN = /^HX[a-fA-F0-9]{32}$/;

// Twilio WhatsApp Sender: entweder "whatsapp:+E164" / "+E164" oder eine Messaging-Service-SID (MG...)
const TWILIO_FROM_PATTERN = /^(?:MG[a-zA-Z0-9]{32}|whatsapp:\+[1-9]\d{6,14}|\+[1-9]\d{6,14})$/;

export const updateWhatsAppConfigSchema = z.object({
  // Twilio-Sender: WhatsApp-Nummer (E.164) ODER Messaging-Service-SID (MG…)
  whatsappFromOrService: z
    .string()
    .nullable()
    .optional()
    .refine(
      (v) => v == null || v === "" || TWILIO_FROM_PATTERN.test(v),
      "Ungültiger Twilio-Sender. Erwartet: +49… (E.164) oder Messaging-Service-SID (MG…)",
    ),
  // Optionaler Override für den Twilio-Auth-Token (falls leer wird process.env.TWILIO_AUTH_TOKEN genutzt)
  whatsappAccessToken: z.string().nullable().optional(),
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
    // Twilio Content SID (HX…), oder leer für „noch nicht konfiguriert".
    // Aktivierte Regeln müssen eine gültige SID haben (Cross-Field-Check unten).
    templateName: z
      .string()
      .refine(
        (v) => v === "" || TWILIO_CONTENT_SID_PATTERN.test(v),
        "Twilio Content SID muss mit HX beginnen und 34 Zeichen lang sein",
      ),
  })).superRefine((rules, ctx) => {
    rules.forEach((rule, index) => {
      if (rule.enabled && rule.templateName === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "templateName"],
          message: "Aktivierte Regeln benötigen eine Twilio Content SID (HX…)",
        });
      }
    });
  }),
});
export type UpdateWhatsAppRulesInput = z.infer<typeof updateWhatsAppRulesSchema>;
