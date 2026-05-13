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
