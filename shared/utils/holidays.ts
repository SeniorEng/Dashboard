export interface Holiday {
  date: string;
  name: string;
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDaysToDate(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function bussUndBettag(year: number): Date {
  const nov23 = new Date(year, 10, 23);
  const dayOfWeek = nov23.getDay();
  const daysBack = dayOfWeek === 0 ? 4 : (dayOfWeek < 3 ? dayOfWeek + 4 : dayOfWeek - 3);
  return addDaysToDate(nov23, -daysBack);
}

export function getHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);

  const holidays: Holiday[] = [
    { date: `${year}-01-01`, name: "Neujahr" },
    { date: formatDate(addDaysToDate(easter, -2)), name: "Karfreitag" },
    { date: formatDate(easter), name: "Ostersonntag" },
    { date: formatDate(addDaysToDate(easter, 1)), name: "Ostermontag" },
    { date: `${year}-05-01`, name: "Tag der Arbeit" },
    { date: formatDate(addDaysToDate(easter, 39)), name: "Christi Himmelfahrt" },
    { date: formatDate(addDaysToDate(easter, 49)), name: "Pfingstsonntag" },
    { date: formatDate(addDaysToDate(easter, 50)), name: "Pfingstmontag" },
    { date: `${year}-10-03`, name: "Tag der Deutschen Einheit" },
    { date: `${year}-10-31`, name: "Reformationstag" },
    { date: formatDate(bussUndBettag(year)), name: "Buß- und Bettag" },
    { date: `${year}-12-25`, name: "1. Weihnachtsfeiertag" },
    { date: `${year}-12-26`, name: "2. Weihnachtsfeiertag" },
  ];

  holidays.sort((a, b) => a.date.localeCompare(b.date));
  return holidays;
}

export function getHolidayMap(year: number): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of getHolidays(year)) {
    map.set(h.date, h.name);
  }
  return map;
}

export function isHoliday(dateStr: string): string | undefined {
  const year = parseInt(dateStr.substring(0, 4));
  const map = getHolidayMap(year);
  return map.get(dateStr);
}
