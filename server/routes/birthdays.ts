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
const MAX_INCLUDE_PAST_DAYS = 365;

/**
 * Liefert die Anzahl Tage bis zum Geburtstag — kann negativ sein, wenn der
 * Geburtstag innerhalb der letzten `includePastDays` Tage war.
 *
 * - Liegt der Geburtstag dieses Jahres in den letzten `includePastDays` Tagen,
 *   wird ein negativer Wert (z.B. -3 für „vor 3 Tagen") zurückgegeben.
 * - Sonst wird die normale Vorwärts-Semantik von `calculateDaysUntilBirthday`
 *   genutzt, inkl. Jahresrollover und Schalttag-Behandlung. So bleiben
 *   Geburtstage am Jahresende/-anfang korrekt sichtbar.
 */
export function daysUntilBirthdayWithPast(birthDate: string, includePastDays: number): number {
  const forward = calculateDaysUntilBirthday(birthDate);
  if (includePastDays > 0) {
    const today = parseLocalDate(todayISO());
    // Schalttag-konforme Berechnung des Geburtstags in diesem Kalenderjahr
    const thisYearBirthday = getBirthdayOccurrenceInYear(birthDate, today.getFullYear());
    const diffThisYear = Math.round(
      (thisYearBirthday.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );
    // Nur als überfällig melden, wenn der diesjährige Geburtstag bereits
    // vorbei ist UND näher zurückliegt als der nächste Geburtstag in der
    // Zukunft. So bleiben Geburtstage am Jahreswechsel (z.B. Jan 5 am
    // 20. Dez = +16) korrekt vorwärts gerichtet.
    if (diffThisYear < 0 && -diffThisYear <= includePastDays && -diffThisYear < forward) {
      return diffThisYear;
    }
  }
  return forward;
}

function buildAddress(strasse: string | null, hausnummer: string | null, plz: string | null, stadt: string | null): string | undefined {
  const streetPart = [strasse, hausnummer].filter(Boolean).join(" ");
  const cityPart = [plz, stadt].filter(Boolean).join(" ");
  const parts = [streetPart, cityPart].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Liefert den tatsächlichen Geburtstag in einem konkreten Kalenderjahr.
 * Schalttag-Babys (29.02.) feiern in Nicht-Schaltjahren am 28.02.
 */
function getBirthdayOccurrenceInYear(birthDate: string, year: number): Date {
  const birth = parseLocalDate(birthDate);
  const birthMonth = birth.getMonth();
  const birthDay = birth.getDate();
  const isLeapDayBaby = birthMonth === 1 && birthDay === 29;

  if (isLeapDayBaby) {
    const candidate = new Date(year, 1, 29);
    if (candidate.getMonth() === 1 && candidate.getDate() === 29) {
      return candidate;
    }
    return new Date(year, 1, 28);
  }
  return new Date(year, birthMonth, birthDay);
}

export function calculateDaysUntilBirthday(birthDate: string): number {
  const today = parseLocalDate(todayISO());
  const birth = parseLocalDate(birthDate);
  const isLeapDayBaby = birth.getMonth() === 1 && birth.getDate() === 29;

  let occurrence = getBirthdayOccurrenceInYear(birthDate, today.getFullYear());

  if (occurrence < today) {
    if (isLeapDayBaby) {
      let year = today.getFullYear() + 1;
      let candidate = new Date(year, 1, 29);
      while (!(candidate.getMonth() === 1 && candidate.getDate() === 29)) {
        year++;
        candidate = new Date(year, 1, 29);
      }
      occurrence = candidate;
    } else {
      occurrence = getBirthdayOccurrenceInYear(birthDate, today.getFullYear() + 1);
    }
  }

  const diffTime = occurrence.getTime() - today.getTime();
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
  // Überfällig (negativ) oder heute: aktueller Lebensjahr-Stand.
  // In der Zukunft: nächstes Lebensjahr.
  return daysUntil <= 0 ? baseAge : baseAge + 1;
}

router.get("/", asyncHandler("Geburtstage konnten nicht geladen werden", async (req: Request, res: Response) => {
  const user = req.user!;
  const rawDays = parseInt(req.query.days as string);
  const horizonDays = isNaN(rawDays)
    ? DEFAULT_HORIZON_DAYS
    : Math.min(Math.max(1, rawDays), MAX_HORIZON_DAYS);

  const rawPast = parseInt(req.query.includePast as string);
  const includePastDays = isNaN(rawPast)
    ? 0
    : Math.min(Math.max(0, rawPast), MAX_INCLUDE_PAST_DAYS);

  const cached = birthdaysCache.get(user.id, user.isAdmin, horizonDays, includePastDays);
  if (cached) {
    res.json(cached);
    return;
  }

  const birthdays: BirthdayEntry[] = [];

  const pushIfInWindow = (
    daysUntil: number,
    entry: () => BirthdayEntry,
  ) => {
    if (daysUntil > horizonDays) return;
    if (daysUntil < -includePastDays) return;
    birthdays.push(entry());
  };

  if (user.isAdmin) {
    const [activeEmployees, activeCustomers] = await Promise.all([
      storage.getActiveEmployeesWithBirthday(),
      storage.getActiveCustomersWithBirthday(),
    ]);

    for (const emp of activeEmployees) {
      if (!emp.geburtsdatum) continue;
      const daysUntil = daysUntilBirthdayWithPast(emp.geburtsdatum, includePastDays);
      pushIfInWindow(daysUntil, () => ({
        id: emp.id,
        type: "employee",
        name: emp.displayName,
        geburtsdatum: emp.geburtsdatum!,
        daysUntil: daysUntil!,
        age: calculateUpcomingAge(emp.geburtsdatum!, daysUntil!),
        address: buildAddress(emp.strasse, emp.hausnummer, emp.plz, emp.stadt),
      }));
    }

    for (const cust of activeCustomers) {
      if (!cust.geburtsdatum) continue;
      const daysUntil = daysUntilBirthdayWithPast(cust.geburtsdatum, includePastDays);
      pushIfInWindow(daysUntil, () => ({
        id: cust.id,
        type: "customer",
        name: cust.name,
        geburtsdatum: cust.geburtsdatum!,
        daysUntil: daysUntil!,
        age: calculateUpcomingAge(cust.geburtsdatum!, daysUntil!),
        address: buildAddress(cust.strasse, cust.hausnummer, cust.plz, cust.stadt),
      }));
    }
  } else {
    const myBirthday = user.geburtsdatum;
    if (myBirthday) {
      const daysUntil = daysUntilBirthdayWithPast(myBirthday, includePastDays);
      pushIfInWindow(daysUntil, () => ({
        id: user.id,
        type: "employee",
        name: user.displayName,
        geburtsdatum: myBirthday,
        daysUntil: daysUntil!,
        age: calculateUpcomingAge(myBirthday, daysUntil!),
      }));
    }

    const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);

    if (assignedCustomerIds.length > 0) {
      const assignedCustomers = await storage.getCustomersByIds(assignedCustomerIds);

      for (const cust of assignedCustomers) {
        if (!cust.geburtsdatum) continue;
        const daysUntil = daysUntilBirthdayWithPast(cust.geburtsdatum, includePastDays);
        pushIfInWindow(daysUntil, () => ({
          id: cust.id,
          type: "customer",
          name: cust.name,
          geburtsdatum: cust.geburtsdatum!,
          daysUntil: daysUntil!,
          age: calculateUpcomingAge(cust.geburtsdatum!, daysUntil!),
          address: buildAddress(cust.strasse, cust.nr, cust.plz, cust.stadt),
        }));
      }
    }
  }

  birthdays.sort((a, b) => a.daysUntil - b.daysUntil);

  birthdaysCache.set(user.id, user.isAdmin, horizonDays, birthdays, includePastDays);

  res.json(birthdays);
}));

export default router;
