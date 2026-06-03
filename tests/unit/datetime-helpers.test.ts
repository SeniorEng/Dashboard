/**
 * Task #937 — Direkte Unit-Tests für die in Task #928 ausgelagerten reinen
 * Datums-Helfer aus `shared/utils/datetime.ts`. Diese Funktionen wurden aus
 * inline-UI-Logik in eine geteilte SSoT extrahiert; ohne dedizierte Tests
 * könnte eine künftige Änderung die Datums-/Wochen-Darstellung über mehrere
 * Bildschirme hinweg still verändern.
 *
 * Bewusst zeitzonen-/DST-agnostisch: alle Date-Objekte werden über lokale
 * Konstruktoren (`new Date(y, m, d, ...)`) erzeugt, sodass die Assertions
 * unabhängig von der TZ der Test-Maschine gelten.
 */
import { describe, it, expect } from "vitest";
import {
  formatGermanDate,
  startOfWeekMonday,
  addDaysToDate,
  addWeeksToDate,
  isSameLocalDay,
  isToday,
  isTomorrow,
  isValidDateString,
  todayISO,
  addDays,
  formatDateISO,
} from "@shared/utils/datetime";

describe("formatGermanDate", () => {
  it("formatiert ein Date-Objekt mit deutschem Locale", () => {
    const d = new Date(2025, 2, 5); // 5. März 2025
    expect(formatGermanDate(d, "d. MMMM yyyy")).toBe("5. März 2025");
  });

  it("formatiert einen ISO-String (lokal geparst)", () => {
    expect(formatGermanDate("2025-03-05", "d. MMMM yyyy")).toBe("5. März 2025");
  });

  it("liefert deutschen Monats-Header (MMMM yyyy)", () => {
    expect(formatGermanDate("2026-01-15", "MMMM yyyy")).toBe("Januar 2026");
  });

  it("liefert deutschen Wochentag", () => {
    // 2. Juni 2026 ist ein Dienstag
    expect(formatGermanDate("2026-06-02", "EEEE")).toBe("Dienstag");
  });
});

describe("startOfWeekMonday", () => {
  it("gibt für einen Mittwoch den Montag derselben Woche zurück", () => {
    const wed = new Date(2026, 5, 3); // Mi, 3. Juni 2026
    const mon = startOfWeekMonday(wed);
    expect(formatDateISO(mon)).toBe("2026-06-01");
  });

  it("gibt für einen Sonntag den Montag DERSELBEN (vorherigen) Woche zurück", () => {
    const sun = new Date(2026, 5, 7); // So, 7. Juni 2026
    const mon = startOfWeekMonday(sun);
    expect(formatDateISO(mon)).toBe("2026-06-01");
  });

  it("gibt für einen Montag denselben Tag zurück", () => {
    const monday = new Date(2026, 5, 1); // Mo, 1. Juni 2026
    expect(formatDateISO(startOfWeekMonday(monday))).toBe("2026-06-01");
  });

  it("setzt die Uhrzeit auf lokale Mitternacht", () => {
    const wed = new Date(2026, 5, 3, 14, 37, 12);
    const mon = startOfWeekMonday(wed);
    expect(mon.getHours()).toBe(0);
    expect(mon.getMinutes()).toBe(0);
    expect(mon.getSeconds()).toBe(0);
  });

  it("überschreitet eine Monatsgrenze korrekt", () => {
    const fri = new Date(2026, 4, 1); // Fr, 1. Mai 2026
    expect(formatDateISO(startOfWeekMonday(fri))).toBe("2026-04-27");
  });
});

describe("addDaysToDate", () => {
  it("addiert Tage innerhalb des Monats", () => {
    expect(formatDateISO(addDaysToDate(new Date(2026, 5, 2), 3))).toBe("2026-06-05");
  });

  it("überschreitet die Monatsgrenze", () => {
    expect(formatDateISO(addDaysToDate(new Date(2026, 5, 30), 1))).toBe("2026-07-01");
  });

  it("überschreitet die Jahresgrenze", () => {
    expect(formatDateISO(addDaysToDate(new Date(2025, 11, 31), 1))).toBe("2026-01-01");
  });

  it("rechnet Schaltjahr-Februar korrekt (29. Feb. 2024)", () => {
    expect(formatDateISO(addDaysToDate(new Date(2024, 1, 28), 1))).toBe("2024-02-29");
  });

  it("akzeptiert negative Tage", () => {
    expect(formatDateISO(addDaysToDate(new Date(2026, 0, 1), -1))).toBe("2025-12-31");
  });

  it("behält die Uhrzeit bei und mutiert das Original nicht", () => {
    const original = new Date(2026, 5, 2, 9, 30, 0);
    const result = addDaysToDate(original, 5);
    expect(result.getHours()).toBe(9);
    expect(result.getMinutes()).toBe(30);
    expect(formatDateISO(original)).toBe("2026-06-02");
  });

  it("ist DST-sicher (lokaler Kalendertag bleibt korrekt über die EU-Frühjahrsumstellung)", () => {
    // 29.03.2026 ist die EU-Sommerzeit-Umstellung; +1 Tag muss kalendarisch
    // exakt der 30.03. sein, unabhängig vom 23-Stunden-Tag.
    expect(formatDateISO(addDaysToDate(new Date(2026, 2, 29), 1))).toBe("2026-03-30");
  });
});

describe("addWeeksToDate", () => {
  it("addiert eine Woche (= 7 Tage)", () => {
    expect(formatDateISO(addWeeksToDate(new Date(2026, 5, 2), 1))).toBe("2026-06-09");
  });

  it("überschreitet Monats-/Jahresgrenzen", () => {
    expect(formatDateISO(addWeeksToDate(new Date(2025, 11, 25), 1))).toBe("2026-01-01");
  });

  it("akzeptiert negative Wochen", () => {
    expect(formatDateISO(addWeeksToDate(new Date(2026, 5, 8), -1))).toBe("2026-06-01");
  });
});

describe("isSameLocalDay", () => {
  it("ist true für denselben Kalendertag mit verschiedener Uhrzeit", () => {
    const a = new Date(2026, 5, 2, 0, 0, 1);
    const b = new Date(2026, 5, 2, 23, 59, 59);
    expect(isSameLocalDay(a, b)).toBe(true);
  });

  it("ist false für aufeinanderfolgende Tage", () => {
    const a = new Date(2026, 5, 2, 23, 59, 59);
    const b = new Date(2026, 5, 3, 0, 0, 0);
    expect(isSameLocalDay(a, b)).toBe(false);
  });

  it("ist false für gleichen Tag/Monat in verschiedenen Jahren", () => {
    expect(isSameLocalDay(new Date(2025, 5, 2), new Date(2026, 5, 2))).toBe(false);
  });
});

describe("isToday", () => {
  it("ist true für den heutigen ISO-String", () => {
    expect(isToday(todayISO())).toBe(true);
  });

  it("ist false für gestern und morgen", () => {
    expect(isToday(addDays(todayISO(), -1))).toBe(false);
    expect(isToday(addDays(todayISO(), 1))).toBe(false);
  });
});

describe("isTomorrow", () => {
  it("ist true für den morgigen ISO-String", () => {
    expect(isTomorrow(addDays(todayISO(), 1))).toBe(true);
  });

  it("ist false für heute und übermorgen", () => {
    expect(isTomorrow(todayISO())).toBe(false);
    expect(isTomorrow(addDays(todayISO(), 2))).toBe(false);
  });
});

describe("isValidDateString", () => {
  it("ist true für einen wohlgeformten Datums-String", () => {
    expect(isValidDateString("2026-06-02")).toBe(true);
  });

  it("ist false für leeren String", () => {
    expect(isValidDateString("")).toBe(false);
  });

  it("ist false für nicht-numerischen Müll", () => {
    expect(isValidDateString("not-a-date")).toBe(false);
  });
});
