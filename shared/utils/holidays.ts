interface Holiday {
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

/**
 * Bundeseinheitliche (in ALLEN Bundesländern gesetzliche) Feiertage.
 * `getHolidays` liefert die Sachsen-Liste inkl. landesspezifischer Tage
 * (Reformationstag, Buß- und Bettag); diese Menge grenzt davon die
 * bundesweit gültigen Tage ab. Die Klassifikation ist Feiertags-Domänenwissen
 * und gehört daher hierher (nicht in konsumierende Utilities wie den
 * Monatsabschluss-Cutoff).
 */
const BUNDESEINHEITLICHE_FEIERTAGE = new Set<string>([
  "Neujahr",
  "Karfreitag",
  "Ostermontag",
  "Tag der Arbeit",
  "Christi Himmelfahrt",
  "Pfingstmontag",
  "Tag der Deutschen Einheit",
  "1. Weihnachtsfeiertag",
  "2. Weihnachtsfeiertag",
]);

/**
 * Liefert für ein Jahr die Menge aller ISO-Daten (YYYY-MM-DD), die in GANZ
 * Deutschland gesetzlicher Feiertag sind (ohne landesspezifische Tage).
 */
export function getNationalHolidayDates(year: number): Set<string> {
  const dates = new Set<string>();
  for (const h of getHolidays(year)) {
    if (BUNDESEINHEITLICHE_FEIERTAGE.has(h.name)) {
      dates.add(h.date);
    }
  }
  return dates;
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

/**
 * Unterstützte Bundesländer für die Urlaubsberechnung. Aktuell ist nur
 * Sachsen relevant — die Liste ist offen erweiterbar, sobald CareConnect
 * in weiteren Bundesländern eingesetzt wird (siehe Task #602, Step 1).
 *
 * Sachsen hat alle bundesweit gültigen Feiertage plus Reformationstag
 * und Buß- und Bettag — also exakt die Liste, die `getHolidays` bereits
 * liefert. Andere Bundesländer würden eine kuratierte Untermenge bzw.
 * landesspezifische Tage (Mariä Himmelfahrt, Fronleichnam, …) benötigen.
 */
export type Bundesland = "SN";

export const DEFAULT_BUNDESLAND: Bundesland = "SN";

/**
 * Liefert für ein Jahr die Menge aller Feiertagsdaten (ISO YYYY-MM-DD),
 * die in `bundesland` als gesetzlicher Feiertag gelten und damit
 * **nicht** als Urlaubstag abgezogen werden dürfen.
 */
export function getVacationHolidayDates(
  year: number,
  bundesland: Bundesland = DEFAULT_BUNDESLAND,
): Set<string> {
  if (bundesland !== "SN") {
    throw new Error(`Bundesland ${bundesland} wird noch nicht unterstützt`);
  }
  const result = new Set<string>();
  for (const h of getHolidays(year)) {
    result.add(h.date);
  }
  return result;
}

/**
 * Liefert für ein ISO-Datum den Feiertagsnamen, sofern es im angegebenen
 * Bundesland (Default: Sachsen) ein gesetzlicher Feiertag ist und damit
 * Urlaubs-Buchungen blockiert.
 */
export function getVacationHolidayName(
  dateStr: string,
  bundesland: Bundesland = DEFAULT_BUNDESLAND,
): string | undefined {
  if (bundesland !== "SN") {
    throw new Error(`Bundesland ${bundesland} wird noch nicht unterstützt`);
  }
  const year = parseInt(dateStr.substring(0, 4));
  const map = getHolidayMap(year);
  return map.get(dateStr);
}
