import { describe, it, expect } from "vitest";
import {
  daysOverdue,
  getDocumentationAgeBucket,
  DOCUMENTATION_AGE_BUCKET_ORDER,
} from "@shared/domain/appointments";

const NOW = new Date(2026, 4, 15, 14, 30, 0); // 2026-05-15 14:30 local

describe("daysOverdue", () => {
  it("ist 0 für heute", () => {
    expect(daysOverdue({ date: "2026-05-15" }, NOW)).toBe(0);
  });
  it("ist 1 für gestern", () => {
    expect(daysOverdue({ date: "2026-05-14" }, NOW)).toBe(1);
  });
  it("ist 7 für genau eine Woche zurück", () => {
    expect(daysOverdue({ date: "2026-05-08" }, NOW)).toBe(7);
  });
  it("ist 21 für drei Wochen zurück", () => {
    expect(daysOverdue({ date: "2026-04-24" }, NOW)).toBe(21);
  });
});

describe("getDocumentationAgeBucket", () => {
  it("bucket 'today' für heutige Termine", () => {
    expect(getDocumentationAgeBucket({ date: "2026-05-15" }, NOW)).toBe("today");
  });

  it("bucket 'this-week' für 1–7 Tage zurück", () => {
    expect(getDocumentationAgeBucket({ date: "2026-05-14" }, NOW)).toBe("this-week");
    expect(getDocumentationAgeBucket({ date: "2026-05-08" }, NOW)).toBe("this-week");
  });

  it("bucket 'overdue' für mehr als 7 Tage zurück", () => {
    expect(getDocumentationAgeBucket({ date: "2026-05-07" }, NOW)).toBe("overdue");
    expect(getDocumentationAgeBucket({ date: "2026-04-24" }, NOW)).toBe("overdue");
  });

  it("Sortier-/Gruppen-Reihenfolge: overdue → this-week → today (dringlichste zuerst)", () => {
    expect(DOCUMENTATION_AGE_BUCKET_ORDER).toEqual(["overdue", "this-week", "today"]);
  });

  it("gruppiert eine gemischte Liste in der erwarteten Reihenfolge mit ältesten Einträgen oben", () => {
    const appointments = [
      { id: "today-a", date: "2026-05-15", scheduledStart: "16:00" },
      { id: "old-1", date: "2026-04-24", scheduledStart: "09:00" },
      { id: "week-late", date: "2026-05-13", scheduledStart: "11:00" },
      { id: "week-early", date: "2026-05-09", scheduledStart: "08:00" },
      { id: "today-b", date: "2026-05-15", scheduledStart: "08:00" },
      { id: "old-2", date: "2026-05-01", scheduledStart: "10:00" },
    ];

    const buckets: Record<string, typeof appointments> = {
      "overdue": [],
      "this-week": [],
      "today": [],
    };
    for (const apt of appointments) {
      buckets[getDocumentationAgeBucket(apt, NOW)].push(apt);
    }
    const sortByOldest = (a: { date: string; scheduledStart: string }, b: { date: string; scheduledStart: string }) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.scheduledStart.localeCompare(b.scheduledStart);
    };
    for (const key of DOCUMENTATION_AGE_BUCKET_ORDER) {
      buckets[key].sort(sortByOldest);
    }

    const flat = DOCUMENTATION_AGE_BUCKET_ORDER.flatMap((k) => buckets[k].map((a) => a.id));
    expect(flat).toEqual(["old-1", "old-2", "week-early", "week-late", "today-b", "today-a"]);
  });
});
