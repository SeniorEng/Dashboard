import { db } from "../lib/db";
import { whatsappNotificationRules } from "@shared/schema";
import { sql } from "drizzle-orm";

// templateName ist eine Twilio Content SID (HX…). Wird leer angelegt; Admin muss
// pro Event-Typ die jeweilige Content SID aus der Twilio Console eintragen.
const DEFAULT_RULES = [
  { eventType: "appointment_created", description: "Neuer Termin zugewiesen", templateName: "" },
  { eventType: "appointment_updated", description: "Termin geändert/verschoben", templateName: "" },
  { eventType: "appointment_reminder", description: "Tägliche Termin-Erinnerung", templateName: "" },
  { eventType: "customer_assigned", description: "Kunde zugewiesen", templateName: "" },
  { eventType: "task_assigned", description: "Aufgabe zugewiesen", templateName: "" },
  { eventType: "birthday_reminder", description: "Geburtstags-Erinnerung", templateName: "" },
  { eventType: "month_close_reminder", description: "Monatsabschluss-Erinnerung", templateName: "" },
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
