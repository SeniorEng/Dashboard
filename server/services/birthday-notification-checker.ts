import { storage } from "../storage";
import { notificationService } from "./notification-service";
import { hasRecentNotification } from "../storage/notifications";
import { calculateDaysUntilBirthday } from "../routes/birthdays";
import { parseLocalDate, todayISO } from "@shared/utils/datetime";
import { ensureBirthdayTask } from "../storage/tasks";

const BIRTHDAY_HORIZON_DAYS = 7;

function calculateUpcomingAge(birthDate: string, daysUntil: number): number {
  const todayStr = todayISO();
  const today = parseLocalDate(todayStr);
  const birth = parseLocalDate(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return daysUntil === 0 ? age : age + 1;
}

export async function checkUpcomingBirthdays(): Promise<number> {
  let created = 0;

  const [employees, customers] = await Promise.all([
    storage.getActiveEmployeesWithBirthday(),
    storage.getActiveCustomersWithBirthday(),
  ]);

  const adminUsers = await storage.getAdminUserIds();

  for (const emp of employees) {
    if (!emp.geburtsdatum) continue;
    const daysUntil = calculateDaysUntilBirthday(emp.geburtsdatum);
    if (daysUntil !== BIRTHDAY_HORIZON_DAYS) continue;

    const age = calculateUpcomingAge(emp.geburtsdatum, daysUntil);

    const todayDate = parseLocalDate(todayISO());
    const birthdayThisYear = new Date(todayDate.getFullYear(), parseLocalDate(emp.geburtsdatum).getMonth(), parseLocalDate(emp.geburtsdatum).getDate());
    const birthdayYear = birthdayThisYear.getTime() >= todayDate.getTime() ? todayDate.getFullYear() : todayDate.getFullYear() + 1;

    for (const adminId of adminUsers) {
      if (adminId === emp.id) continue;
      const alreadyNotified = await hasRecentNotification(adminId, "birthday_reminder", emp.id, 48);
      if (!alreadyNotified) {
        await notificationService.notifyUpcomingBirthday(
          adminId, emp.displayName, "employee", emp.geburtsdatum, age, emp.id
        );
        created++;
      }

      await ensureBirthdayTask(adminId, "employee", emp.id, emp.displayName, emp.geburtsdatum, birthdayYear);
    }
  }

  for (const cust of customers) {
    if (!cust.geburtsdatum) continue;
    const daysUntil = calculateDaysUntilBirthday(cust.geburtsdatum);
    if (daysUntil !== BIRTHDAY_HORIZON_DAYS) continue;

    const age = calculateUpcomingAge(cust.geburtsdatum, daysUntil);
    const employeeIds = new Set<number>();
    if (cust.primaryEmployeeId) employeeIds.add(cust.primaryEmployeeId);
    if (cust.backupEmployeeId) employeeIds.add(cust.backupEmployeeId);
    if (cust.backupEmployeeId2) employeeIds.add(cust.backupEmployeeId2);

    const todayDateC = parseLocalDate(todayISO());
    const custBirthdayThisYear = new Date(todayDateC.getFullYear(), parseLocalDate(cust.geburtsdatum).getMonth(), parseLocalDate(cust.geburtsdatum).getDate());
    const custBirthdayYear = custBirthdayThisYear.getTime() >= todayDateC.getTime() ? todayDateC.getFullYear() : todayDateC.getFullYear() + 1;

    for (const empId of Array.from(employeeIds)) {
      const alreadyNotified = await hasRecentNotification(empId, "birthday_reminder", cust.id, 48);
      if (!alreadyNotified) {
        await notificationService.notifyUpcomingBirthday(
          empId, cust.name, "customer", cust.geburtsdatum, age, cust.id
        );
        created++;
      }
    }

    for (const adminId of adminUsers) {
      await ensureBirthdayTask(adminId, "customer", cust.id, cust.name, cust.geburtsdatum, custBirthdayYear, cust.id);
    }
  }

  return created;
}
