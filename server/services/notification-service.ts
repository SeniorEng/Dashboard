import { createNotification } from "../storage/notifications";
import { whatsAppService } from "./whatsapp-service";
import { getEnabledRuleByEvent, getUserWhatsAppPreferences } from "../storage/whatsapp";
import type { WhatsAppEventType } from "@shared/schema";

function fireAndForget(fn: () => Promise<void>) {
  fn().catch((err) => {
    console.error("[NotificationService] Fehler beim Erstellen der Benachrichtigung:", err);
  });
}

interface WhatsAppContext {
  customerName?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  taskTitle?: string;
  employeeName?: string;
  appointmentId?: number;
  customerId?: number;
  appointmentCount?: number;
  firstAppointmentTime?: string;
  age?: number;
  birthdayPersonName?: string;
}

function buildDeepLink(eventType: WhatsAppEventType, context: WhatsAppContext): string {
  switch (eventType) {
    case "appointment_created":
    case "appointment_updated":
      return whatsAppService.buildAppUrl(`/appointment/${context.appointmentId || ""}`);
    case "customer_assigned":
      return whatsAppService.buildAppUrl(`/customers/${context.customerId || ""}`);
    case "task_assigned":
      return whatsAppService.buildAppUrl("/tasks");
    case "birthday_reminder":
      return whatsAppService.buildAppUrl("/admin/birthday-cards");
    case "month_close_reminder":
      return whatsAppService.buildAppUrl("/time-entries");
    case "appointment_reminder":
      return whatsAppService.buildAppUrl("/");
    default:
      return whatsAppService.buildAppUrl("/");
  }
}

function buildTemplateParams(eventType: WhatsAppEventType, context: WhatsAppContext): string[] {
  switch (eventType) {
    case "appointment_created":
      return [context.customerName || "", context.appointmentDate || ""];
    case "appointment_updated":
      return [context.customerName || "", context.appointmentDate || ""];
    case "appointment_reminder":
      return [
        String(context.appointmentCount || 0),
        context.firstAppointmentTime || "",
      ];
    case "customer_assigned":
      return [context.customerName || ""];
    case "task_assigned":
      return [context.taskTitle || ""];
    case "birthday_reminder":
      return [context.birthdayPersonName || "", String(context.age || 0)];
    case "month_close_reminder":
      return [];
    default:
      return [];
  }
}

async function dispatchWhatsApp(
  eventType: WhatsAppEventType,
  userId: number,
  context: WhatsAppContext,
  actingUserId?: number
): Promise<void> {
  try {
    if (eventType === "appointment_created" || eventType === "appointment_updated") {
      if (!actingUserId || actingUserId === userId) {
        return;
      }
    }

    const isConfigured = await whatsAppService.isConfigured();
    if (!isConfigured) return;

    const rule = await getEnabledRuleByEvent(eventType);
    if (!rule) return;

    const prefs = await getUserWhatsAppPreferences(userId);
    if (!prefs || !prefs.enabled) return;

    const { authService } = await import("./auth");
    const user = await authService.getUser(userId);
    if (!user) return;

    const phoneNumber = prefs.whatsappNumber || user.telefon;
    if (!phoneNumber) return;

    const templateParams = buildTemplateParams(eventType, context);
    const deepLink = buildDeepLink(eventType, context);

    await whatsAppService.sendAndLog(userId, eventType, {
      phoneNumber,
      templateName: rule.templateName,
      templateParams,
      buttonUrl: deepLink,
    });
  } catch (err) {
    console.error("[NotificationService] WhatsApp-Dispatch Fehler:", err);
  }
}

export const notificationService = {
  notifyCustomerAssigned(
    customerId: number,
    customerName: string,
    employeeId: number,
    role: "primary" | "backup" | "backup2"
  ) {
    const roleLabel = role === "primary" ? "Hauptmitarbeiter/in" : role === "backup2" ? "2. Vertretung" : "Vertretung";
    fireAndForget(async () => {
      await createNotification({
        userId: employeeId,
        type: "customer_assigned",
        title: "Neue Kundenzuordnung",
        message: `Dir wurde ${customerName} als ${roleLabel} zugewiesen.`,
        referenceId: customerId,
        referenceType: "customer",
      });

      await dispatchWhatsApp("customer_assigned", employeeId, {
        customerName,
        customerId,
      });
    });
  },

  notifyAppointmentCreated(
    appointmentId: number,
    customerName: string,
    date: string,
    employeeId: number,
    actingUserId?: number
  ) {
    const [year, month, day] = date.split("-");
    const formatted = `${day}.${month}.${year}`;
    fireAndForget(async () => {
      await createNotification({
        userId: employeeId,
        type: "appointment_created",
        title: "Neuer Termin",
        message: `Neuer Termin am ${formatted} für ${customerName}.`,
        referenceId: appointmentId,
        referenceType: "appointment",
      });

      await dispatchWhatsApp("appointment_created", employeeId, {
        customerName,
        appointmentDate: formatted,
        appointmentId,
      }, actingUserId);
    });
  },

  notifyAppointmentUpdated(
    appointmentId: number,
    customerName: string,
    date: string,
    employeeId: number,
    actingUserId?: number
  ) {
    const [year, month, day] = date.split("-");
    const formatted = `${day}.${month}.${year}`;
    fireAndForget(async () => {
      await createNotification({
        userId: employeeId,
        type: "appointment_updated",
        title: "Termin geändert",
        message: `Termin am ${formatted} für ${customerName} wurde geändert.`,
        referenceId: appointmentId,
        referenceType: "appointment",
      });

      await dispatchWhatsApp("appointment_updated", employeeId, {
        customerName,
        appointmentDate: formatted,
        appointmentId,
      }, actingUserId);
    });
  },

  notifyTaskAssigned(
    taskId: number,
    taskTitle: string,
    employeeId: number,
    creatorName: string
  ) {
    fireAndForget(async () => {
      await createNotification({
        userId: employeeId,
        type: "task_assigned",
        title: "Neue Aufgabe",
        message: `${creatorName} hat dir eine Aufgabe zugewiesen: ${taskTitle}`,
        referenceId: taskId,
        referenceType: "task",
      });

      await dispatchWhatsApp("task_assigned", employeeId, {
        taskTitle,
      });
    });
  },

  async notifyUpcomingBirthday(
    employeeId: number,
    birthdayPersonName: string,
    personType: "employee" | "customer",
    birthdayDate: string,
    age: number,
    referenceId: number
  ) {
    const [year, month, day] = birthdayDate.split("-");
    const formatted = `${day}.${month}.${year}`;
    const typeLabel = personType === "customer" ? "Kunde" : "Mitarbeiter/in";
    await createNotification({
      userId: employeeId,
      type: "birthday_reminder",
      title: "Geburtstag in 7 Tagen",
      message: `${typeLabel} ${birthdayPersonName} wird am ${formatted} ${age} Jahre alt.`,
      referenceId,
      referenceType: personType === "customer" ? "customer" : "employee",
    });

    dispatchWhatsApp("birthday_reminder", employeeId, {
      birthdayPersonName,
      age,
    }).catch((err) => {
      console.error("[NotificationService] WhatsApp birthday dispatch error:", err);
    });
  },

  dispatchWhatsApp,
};
