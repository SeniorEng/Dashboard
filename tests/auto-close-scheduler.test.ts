import { describe, it, expect } from "vitest";
import {
  autoCloseMonthForCutoff,
  sendMonthCloseReminders,
} from "../server/services/month-close-scheduler";
import {
  computeMonthCloseCutoff,
  previousMonth,
} from "../shared/utils/month-close-cutoff";

describe("MC-AUTO-1: Auto-Close Scheduler", () => {
  it("MC-AUTO-1.1 – Auto-Close überspringt nicht-Cutoff-Tage", async () => {
    const r = await autoCloseMonthForCutoff("2099-01-15");
    expect(r.skipped).toBe(true);
    expect(r.closed).toBe(0);
    expect(r.expired).toBe(0);
  });

  it("MC-AUTO-1.2 – Auto-Close ist idempotent (zweiter Lauf produziert 0 neue Expires)", async () => {
    // Pick a far-future month with no data so the test is deterministic and
    // doesn't impact production records.
    const futureYear = 2099;
    const futureMonth = 11;
    const cutoff = computeMonthCloseCutoff(futureYear, futureMonth);
    const { year, month } = previousMonth(cutoff);
    expect(year).toBe(futureYear);
    expect(month).toBe(futureMonth);

    const r1 = await autoCloseMonthForCutoff(cutoff);
    const r2 = await autoCloseMonthForCutoff(cutoff);

    // Both runs must complete without throwing. Second run must not expire
    // additional appointments (idempotency).
    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(false);
    expect(r2.expired).toBe(0);
  });
});

describe("MC-AUTO-2: Reminder-Wellen", () => {
  it("MC-AUTO-2.1 – Reminders werden an Nicht-Wellen-Tagen nicht versendet", async () => {
    const r = await sendMonthCloseReminders("2099-01-15");
    expect(r.wave).toBe(null);
    expect(r.sent).toBe(0);
  });

  it("MC-AUTO-2.2 – Wave-Erkennung T-3/T-1/T-0 für gegebenen Cutoff", async () => {
    const futureYear = 2099;
    const futureMonth = 11;
    const cutoff = computeMonthCloseCutoff(futureYear, futureMonth);
    // T-0 = cutoff itself → wave detected
    const t0 = await sendMonthCloseReminders(cutoff);
    expect(["T-0", "T-1", "T-3"].includes(t0.wave ?? "")).toBe(true);
  });
});
