import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freezeTime, thawTime } from "./helpers/frozen-clock";
import { daysUntilBirthdayWithPast } from "../server/routes/birthdays";

describe("daysUntilBirthdayWithPast", () => {
  beforeEach(() => {
    freezeTime("2026-05-13T12:00:00");
  });
  afterEach(() => {
    thawTime();
  });

  it("liefert 0 wenn Geburtstag heute ist", () => {
    expect(daysUntilBirthdayWithPast("1950-05-13", 0)).toBe(0);
    expect(daysUntilBirthdayWithPast("1950-05-13", 30)).toBe(0);
  });

  it("liefert positive Tage bei Geburtstag in der Zukunft (auch ohne includePast)", () => {
    expect(daysUntilBirthdayWithPast("1950-05-20", 0)).toBe(7);
    expect(daysUntilBirthdayWithPast("1950-06-13", 0)).toBe(31);
  });

  it("includePast=0: vergangener Geburtstag rollt forwärts ins nächste Jahr (alte Semantik)", () => {
    // 12. Mai war gestern → nächster Geburtstag in ~365 Tagen
    expect(daysUntilBirthdayWithPast("1950-05-12", 0)).toBeGreaterThan(360);
    expect(daysUntilBirthdayWithPast("1950-01-01", 0)).toBeGreaterThan(200);
  });

  it("liefert negativen Wert wenn Geburtstag innerhalb des includePast-Fensters lag", () => {
    expect(daysUntilBirthdayWithPast("1950-05-12", 30)).toBe(-1);
    expect(daysUntilBirthdayWithPast("1950-05-06", 30)).toBe(-7);
    expect(daysUntilBirthdayWithPast("1950-04-13", 30)).toBe(-30);
  });

  it("ausserhalb des includePast-Fensters fällt auf Vorwärts-Semantik zurück (nächstes Jahr)", () => {
    expect(daysUntilBirthdayWithPast("1950-04-13", 29)).toBeGreaterThan(330);
    expect(daysUntilBirthdayWithPast("1950-01-01", 30)).toBeGreaterThan(200);
  });

  it("includePast=365 fängt fast alle vergangenen Geburtstage des Jahres", () => {
    expect(daysUntilBirthdayWithPast("1950-01-01", 365)).toBe(-132);
    expect(daysUntilBirthdayWithPast("1950-05-12", 365)).toBe(-1);
  });
});

describe("daysUntilBirthdayWithPast: Jahresgrenze (Dezember -> Januar)", () => {
  beforeEach(() => {
    freezeTime("2026-12-20T12:00:00");
  });
  afterEach(() => {
    thawTime();
  });

  it("Geburtstag im Januar zählt korrekt vorwärts (nicht als überfällig)", () => {
    // 5. Januar liegt 16 Tage in der Zukunft, NICHT 350 Tage zurück
    expect(daysUntilBirthdayWithPast("1950-01-05", 0)).toBe(16);
    expect(daysUntilBirthdayWithPast("1950-01-05", 30)).toBe(16);
    expect(daysUntilBirthdayWithPast("1950-01-05", 365)).toBe(16);
  });

  it("Geburtstag im Dezember (vor 5 Tagen) wird mit includePast=30 negativ", () => {
    expect(daysUntilBirthdayWithPast("1950-12-15", 30)).toBe(-5);
    // Ohne includePast: rollt ins nächste Jahr
    expect(daysUntilBirthdayWithPast("1950-12-15", 0)).toBeGreaterThan(355);
  });
});

describe("daysUntilBirthdayWithPast: Schalttag (29. Februar)", () => {
  beforeEach(() => {
    freezeTime("2026-03-15T12:00:00");
  });
  afterEach(() => {
    thawTime();
  });

  it("Schalttag-Geburtstag in Nicht-Schaltjahr behält Vorwärts-Logik (kein null)", () => {
    const result = daysUntilBirthdayWithPast("1948-02-29", 0);
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });
});

describe("daysUntilBirthdayWithPast: createdAt-Filter (Task #430)", () => {
  beforeEach(() => {
    freezeTime("2026-05-13T12:00:00");
  });
  afterEach(() => {
    thawTime();
  });

  it("(a) Geburtstag dieses Jahres lag VOR createdAt → rollt ins nächste Jahr (nicht überfällig)", () => {
    // Person am 04.04.2026 angelegt, Geburtstag 01.01. → 01.01.2026 lag vor Anlegedatum
    const createdAt = new Date(2026, 3, 4); // 04.04.2026
    const result = daysUntilBirthdayWithPast("1950-01-01", 365, createdAt);
    expect(result).toBeGreaterThan(0);
    // Forward-Wert: bis 01.01.2027
    expect(result).toBeGreaterThan(200);
  });

  it("(b) Geburtstag NACH createdAt im selben Jahr → unverändert überfällig", () => {
    // Person am 01.04.2026 angelegt, Geburtstag 12.05. → 12.05.2026 lag nach Anlegedatum
    const createdAt = new Date(2026, 3, 1);
    const result = daysUntilBirthdayWithPast("1950-05-12", 365, createdAt);
    expect(result).toBe(-1);
  });

  it("(c) createdAt liegt in einem Vorjahr → unverändert überfällig erlaubt", () => {
    const createdAt = new Date(2024, 6, 15); // 15.07.2024
    const result = daysUntilBirthdayWithPast("1950-01-01", 365, createdAt);
    expect(result).toBe(-132);
  });

  it("(c2) Ohne createdAt-Parameter → unverändert (Backwards-Compatibility)", () => {
    expect(daysUntilBirthdayWithPast("1950-01-01", 365)).toBe(-132);
  });

  it("(d) 29.02.-Geburtstag, createdAt im März (nach 28.02.) → keine Rückmeldung als überfällig", () => {
    // 2026 ist kein Schaltjahr → 29.02. fällt auf 28.02.2026
    // createdAt = 05.03.2026 → 28.02.2026 lag vor Anlegedatum
    const createdAt = new Date(2026, 2, 5); // 05.03.2026
    const result = daysUntilBirthdayWithPast("1948-02-29", 365, createdAt);
    expect(result).toBeGreaterThan(0);
  });

  it("createdAt als ISO-String wird ebenfalls korrekt verarbeitet", () => {
    const result = daysUntilBirthdayWithPast("1950-01-01", 365, "2026-04-04");
    expect(result).toBeGreaterThan(200);
  });

  it("createdAt = heute → Geburtstag, der heute war, gilt nicht als überfällig (war vor Anlegung möglich)", () => {
    // Edge-Case: Person heute (13.05.2026) angelegt, Geburtstag heute (13.05.) → diff = 0, nicht überfällig sowieso
    const createdAt = new Date(2026, 4, 13);
    expect(daysUntilBirthdayWithPast("1950-05-13", 365, createdAt)).toBe(0);
  });
});
