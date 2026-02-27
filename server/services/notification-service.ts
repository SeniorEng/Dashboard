import { createNotification } from "../storage/notifications";

function fireAndForget(fn: () => Promise<void>) {
  fn().catch((err) => {
    console.error("[NotificationService] Fehler beim Erstellen der Benachrichtigung:", err);
  });
}

export const notificationService = {
  notifyCustomerAssigned(
    customerId: number,
    customerName: string,
    employeeId: number,
    role: "primary" | "backup"
  ) {
    const roleLabel = role === "primary" ? "Hauptmitarbeiter/in" : "Vertretung";
    fireAndForget(async () => {
      await createNotification({
        userId: employeeId,
        type: "customer_assigned",
        title: "Neue Kundenzuordnung",
        message: `Dir wurde ${customerName} als ${roleLabel} zugewiesen.`,
        referenceId: customerId,
        referenceType: "customer",
      });
    });
  },

  notifyAppointmentCreated(
    appointmentId: number,
    customerName: string,
    date: string,
    employeeId: number
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
  },
};
