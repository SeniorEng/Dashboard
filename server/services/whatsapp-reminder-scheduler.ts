import { db } from "../lib/db";
import { appointments } from "@shared/schema";
import { eq, and, ne, isNull } from "drizzle-orm";
import { todayISO, addDays } from "@shared/utils/datetime";
import { getEnabledRuleByEvent, getUsersWithWhatsAppEnabled } from "../storage/whatsapp";
import { whatsAppService } from "./whatsapp-service";
import { log } from "../lib/log";

export async function sendDailyAppointmentReminders(): Promise<number> {
  const rule = await getEnabledRuleByEvent("appointment_reminder");
  if (!rule) return 0;

  const isConfigured = await whatsAppService.isConfigured();
  if (!isConfigured) return 0;

  const tomorrow = addDays(todayISO(), 1);

  const tomorrowAppointments = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.date, tomorrow),
        ne(appointments.status, "cancelled"),
        isNull(appointments.deletedAt)
      )
    );

  if (tomorrowAppointments.length === 0) return 0;

  const groupedByEmployee = new Map<number, typeof tomorrowAppointments>();
  for (const apt of tomorrowAppointments) {
    const empId = apt.assignedEmployeeId;
    if (!empId) continue;
    const list = groupedByEmployee.get(empId) || [];
    list.push(apt);
    groupedByEmployee.set(empId, list);
  }

  if (groupedByEmployee.size === 0) return 0;

  const employeeIds = Array.from(groupedByEmployee.keys());
  const enabledPrefs = await getUsersWithWhatsAppEnabled(employeeIds);
  const enabledUserIds = new Set(enabledPrefs.map((p) => p.userId));

  const { authService } = await import("./auth");

  let sent = 0;

  for (const employeeId of employeeIds) {
    const empAppointments = groupedByEmployee.get(employeeId);
    if (!empAppointments || !enabledUserIds.has(employeeId)) continue;

    const pref = enabledPrefs.find((p) => p.userId === employeeId);
    const user = await authService.getUser(employeeId);
    if (!user) continue;

    const phoneNumber = pref?.whatsappNumber || user.telefon;
    if (!phoneNumber) continue;

    const sorted = [...empAppointments].sort(
      (a: { scheduledStart: string }, b: { scheduledStart: string }) =>
        a.scheduledStart.localeCompare(b.scheduledStart)
    );
    const firstTime = sorted[0].scheduledStart.slice(0, 5);

    const templateParams = [
      String(empAppointments.length),
      firstTime,
    ];

    const deepLink = whatsAppService.buildAppUrl("/");

    try {
      await whatsAppService.sendAndLog(employeeId, "appointment_reminder", {
        phoneNumber,
        templateName: rule.templateName,
        templateParams,
        buttonUrl: deepLink,
      });
      sent++;
    } catch (err) {
      console.error(
        `[WhatsApp-Reminder] Fehler beim Senden an Mitarbeiter ${employeeId}:`,
        err
      );
    }
  }

  return sent;
}

export function startReminderScheduler(): { timeout: NodeJS.Timeout; interval?: NodeJS.Timeout } {
  const now = new Date();
  const berlinTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Berlin" })
  );

  const target = new Date(berlinTime);
  target.setHours(18, 0, 0, 0);

  if (berlinTime >= target) {
    target.setDate(target.getDate() + 1);
  }

  const msUntilTarget = target.getTime() - berlinTime.getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;

  let interval: NodeJS.Timeout | undefined;

  const timeout = setTimeout(async () => {
    try {
      const sent = await sendDailyAppointmentReminders();
      if (sent > 0) {
        log(`${sent} Termin-Erinnerungen gesendet`, "WhatsApp-Reminder");
      }
    } catch (err) {
      console.error("[WhatsApp-Reminder] Fehler:", err);
    }

    interval = setInterval(async () => {
      try {
        const sent = await sendDailyAppointmentReminders();
        if (sent > 0) {
          log(`${sent} Termin-Erinnerungen gesendet`, "WhatsApp-Reminder");
        }
      } catch (err) {
        console.error("[WhatsApp-Reminder] Fehler:", err);
      }
    }, DAY_MS);
  }, msUntilTarget);

  return { timeout, get interval() { return interval; } };
}
