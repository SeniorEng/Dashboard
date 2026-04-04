import { db } from "../lib/db";
import { whatsappNotificationRules } from "@shared/schema";
import { sql } from "drizzle-orm";

const DEFAULT_RULES = [
  { eventType: "appointment_created", description: "Neuer Termin zugewiesen", templateName: "termin_zugewiesen" },
  { eventType: "appointment_updated", description: "Termin geändert/verschoben", templateName: "termin_geaendert" },
  { eventType: "appointment_reminder", description: "Tägliche Termin-Erinnerung", templateName: "termin_erinnerung" },
  { eventType: "customer_assigned", description: "Kunde zugewiesen", templateName: "kunde_zugewiesen" },
  { eventType: "task_assigned", description: "Aufgabe zugewiesen", templateName: "aufgabe_zugewiesen" },
  { eventType: "birthday_reminder", description: "Geburtstags-Erinnerung", templateName: "geburtstag_erinnerung" },
  { eventType: "month_close_reminder", description: "Monatsabschluss-Erinnerung", templateName: "monatsabschluss_erinnerung" },
] as const;

export async function seedWhatsAppRules(): Promise<void> {
  const existing = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM whatsapp_notification_rules`);
  const count = (existing.rows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
  if (count >= DEFAULT_RULES.length) return;

  for (const rule of DEFAULT_RULES) {
    await db
      .insert(whatsappNotificationRules)
      .values({
        eventType: rule.eventType,
        description: rule.description,
        templateName: rule.templateName,
        enabled: false,
      })
      .onConflictDoNothing({ target: whatsappNotificationRules.eventType });
  }
}
