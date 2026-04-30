import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { calculateNextCallTime } from "../server/services/call-scheduler";

const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  // Server steht in einer TZ weit außerhalb von Berlin. Ohne den
  // K5-Refactor (Intl.DateTimeFormat statt toLocaleString-Roundtrip)
  // berechnete der Call-Scheduler den Berlin-Wochentag falsch und
  // verschob den Anruf auf die falsche UTC-Zeit.
  process.env.TZ = "America/New_York";
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

describe("K5 — Call-Scheduler bleibt bei abweichender Server-TZ deterministisch", () => {
  it("CS-TZ-1 — TZ-Override wirkt im Test (Sanity-Check)", () => {
    // Wenn dies fehlschlägt, ist der Test wertlos.
    const offsetMinutes = new Date("2025-03-10T12:00:00Z").getTimezoneOffset();
    expect(offsetMinutes).toBe(240); // EDT = UTC-4 im März nach US-DST-Umstellung
  });

  it("CS-TZ-2 — Werktag mittags Berlin-Zeit erzeugt direkten Anruf (10 Min Verzögerung)", () => {
    // Donnerstag 2025-03-13 12:00 Berlin = 11:00 UTC.
    const now = new Date("2025-03-13T11:00:00Z");
    const result = calculateNextCallTime(now);
    expect(result.isWeekendDeferred).toBe(false);
    // 10 Minuten in der Zukunft.
    expect(result.callAt.getTime() - now.getTime()).toBe(10 * 60_000);
  });

  it("CS-TZ-3 — Sonntag 18:00 Berlin verschiebt auf Montag 09:00 Berlin (= 08:00 UTC im März/CET)", () => {
    // Sonntag 2025-03-09 18:00 Berlin = 17:00 UTC (CET, vor Berlin-DST am 30.03.).
    const sundayEvening = new Date("2025-03-09T17:00:00Z");
    const result = calculateNextCallTime(sundayEvening);
    expect(result.isWeekendDeferred).toBe(true);
    // Montag 2025-03-10 09:00 Berlin = 08:00 UTC.
    expect(result.callAt.toISOString()).toBe("2025-03-10T08:00:00.000Z");
  });

  it("CS-TZ-4 — Samstag 14:00 Berlin (nach Cutoff) verschiebt auf Montag 09:00 Berlin", () => {
    // Samstag 2025-03-08 14:00 Berlin = 13:00 UTC.
    const saturdayAfternoon = new Date("2025-03-08T13:00:00Z");
    const result = calculateNextCallTime(saturdayAfternoon);
    expect(result.isWeekendDeferred).toBe(true);
    expect(result.callAt.toISOString()).toBe("2025-03-10T08:00:00.000Z");
  });

  it("CS-TZ-5 — Sonntag während Berlin-DST (CEST): 09:00 Berlin = 07:00 UTC", () => {
    // Sonntag 2025-04-13 18:00 Berlin = 16:00 UTC (CEST = UTC+2).
    const sundayEveningDST = new Date("2025-04-13T16:00:00Z");
    const result = calculateNextCallTime(sundayEveningDST);
    expect(result.isWeekendDeferred).toBe(true);
    // Montag 2025-04-14 09:00 Berlin = 07:00 UTC.
    expect(result.callAt.toISOString()).toBe("2025-04-14T07:00:00.000Z");
  });
});
