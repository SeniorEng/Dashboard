import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { storage } from "../storage";
import { birthdaysCache } from "../services/cache";
import { parseLocalDate, todayISO } from "@shared/utils/datetime";
import type { BirthdayEntry } from "@shared/types";

const router = Router();

router.use(requireAuth);

const MAX_HORIZON_DAYS = 365;
const DEFAULT_HORIZON_DAYS = 30;

function buildAddress(strasse: string | null, plz: string | null, stadt: string | null): string | undefined {
  const parts = [strasse, [plz, stadt].filter(Boolean).join(" ")].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

export function calculateDaysUntilBirthday(birthDate: string): number {
  const todayStr = todayISO();
  const today = parseLocalDate(todayStr);

  const birth = parseLocalDate(birthDate);
  const birthMonth = birth.getMonth();
  const birthDay = birth.getDate();

  const originalDate = new Date(birth.getFullYear(), birthMonth, birthDay);
  const wasLeapDayBaby = birthMonth === 1 && birthDay === 29 &&
    originalDate.getMonth() === 1 && originalDate.getDate() === 29;

  let thisYearBirthday: Date;
  if (wasLeapDayBaby) {
    const candidate = new Date(today.getFullYear(), 1, 29);
    if (candidate.getMonth() === 1 && candidate.getDate() === 29) {
      thisYearBirthday = candidate;
    } else {
      thisYearBirthday = new Date(today.getFullYear(), 1, 28);
    }
  } else {
    thisYearBirthday = new Date(today.getFullYear(), birthMonth, birthDay);
  }

  if (thisYearBirthday < today) {
    if (wasLeapDayBaby) {
      let nextYear = today.getFullYear() + 1;
      let candidate = new Date(nextYear, 1, 29);
      while (!(candidate.getMonth() === 1 && candidate.getDate() === 29)) {
        nextYear++;
        candidate = new Date(nextYear, 1, 29);
      }
      thisYearBirthday = candidate;
    } else {
      thisYearBirthday.setFullYear(today.getFullYear() + 1);
    }
  }

  const diffTime = thisYearBirthday.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function calculateAge(birthDate: string): number {
  const todayStr = todayISO();
  const today = parseLocalDate(todayStr);
  const birth = parseLocalDate(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }

  return age;
}

function calculateUpcomingAge(birthDate: string, daysUntil: number): number {
  const baseAge = calculateAge(birthDate);
  return daysUntil === 0 ? baseAge : baseAge + 1;
}

router.get("/", asyncHandler("Geburtstage konnten nicht geladen werden", async (req: Request, res: Response) => {
  const user = req.user!;
  const rawDays = parseInt(req.query.days as string);
  const horizonDays = isNaN(rawDays)
    ? DEFAULT_HORIZON_DAYS
    : Math.min(Math.max(1, rawDays), MAX_HORIZON_DAYS);

  const cached = birthdaysCache.get(user.id, user.isAdmin, horizonDays);
  if (cached) {
    res.json(cached);
    return;
  }

  const birthdays: BirthdayEntry[] = [];

  if (user.isAdmin) {
    const [activeEmployees, activeCustomers] = await Promise.all([
      storage.getActiveEmployeesWithBirthday(),
      storage.getActiveCustomersWithBirthday(),
    ]);

    for (const emp of activeEmployees) {
      if (emp.geburtsdatum) {
        const daysUntil = calculateDaysUntilBirthday(emp.geburtsdatum);
        if (daysUntil <= horizonDays) {
          birthdays.push({
            id: emp.id,
            type: "employee",
            name: emp.displayName,
            geburtsdatum: emp.geburtsdatum,
            daysUntil,
            age: calculateUpcomingAge(emp.geburtsdatum, daysUntil),
            address: buildAddress(emp.strasse, emp.plz, emp.stadt),
          });
        }
      }
    }

    for (const cust of activeCustomers) {
      if (cust.geburtsdatum) {
        const daysUntil = calculateDaysUntilBirthday(cust.geburtsdatum);
        if (daysUntil <= horizonDays) {
          birthdays.push({
            id: cust.id,
            type: "customer",
            name: cust.name,
            geburtsdatum: cust.geburtsdatum,
            daysUntil,
            age: calculateUpcomingAge(cust.geburtsdatum, daysUntil),
            address: buildAddress(cust.strasse, cust.plz, cust.stadt),
          });
        }
      }
    }
  } else {
    const myBirthday = user.geburtsdatum;
    if (myBirthday) {
      const daysUntil = calculateDaysUntilBirthday(myBirthday);
      if (daysUntil <= horizonDays) {
        birthdays.push({
          id: user.id,
          type: "employee",
          name: user.displayName,
          geburtsdatum: myBirthday,
          daysUntil,
          age: calculateUpcomingAge(myBirthday, daysUntil),
        });
      }
    }

    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);

    if (assignedCustomerIds.length > 0) {
      const assignedCustomers = await storage.getCustomersByIds(assignedCustomerIds);

      for (const cust of assignedCustomers) {
        if (cust.geburtsdatum) {
          const daysUntil = calculateDaysUntilBirthday(cust.geburtsdatum);
          if (daysUntil <= horizonDays) {
            birthdays.push({
              id: cust.id,
              type: "customer",
              name: cust.name,
              geburtsdatum: cust.geburtsdatum,
              daysUntil,
              age: calculateUpcomingAge(cust.geburtsdatum, daysUntil),
              address: buildAddress(cust.strasse, cust.plz, cust.stadt),
            });
          }
        }
      }
    }
  }

  birthdays.sort((a, b) => a.daysUntil - b.daysUntil);

  birthdaysCache.set(user.id, user.isAdmin, horizonDays, birthdays);

  res.json(birthdays);
}));

export default router;
