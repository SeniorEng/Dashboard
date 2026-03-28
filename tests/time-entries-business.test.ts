import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiDelete,
  getFutureDate,
  getAuthCookie,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
const cleanupIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  for (const id of cleanupIds) {
    try { await apiDelete(`/api/time-entries/${id}`); } catch {}
  }
});

describe("TE-BIZ-1: Wochenend-Sperre", () => {
  it("TE-BIZ-1.1 – Zeiteintrag am Samstag wird abgelehnt", async () => {
    const today = new Date();
    const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(sat.getDate() + daysUntilSat + 7);
    const satStr = sat.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/time-entries", {
      entryDate: satStr,
      entryType: "bueroarbeit",
      startTime: "09:00",
      endTime: "12:00",
      isFullDay: false,
    });
    expect(res.status).toBe(400);
  });

  it("TE-BIZ-1.2 – Zeiteintrag am Sonntag wird abgelehnt", async () => {
    const today = new Date();
    const daysUntilSun = (7 - today.getDay()) % 7 || 7;
    const sun = new Date(today);
    sun.setDate(sun.getDate() + daysUntilSun + 7);
    const sunStr = sun.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/time-entries", {
      entryDate: sunStr,
      entryType: "bueroarbeit",
      startTime: "09:00",
      endTime: "12:00",
      isFullDay: false,
    });
    expect(res.status).toBe(400);
  });
});

describe("TE-BIZ-2: Zeitkonflikte", () => {
  const conflictDate = getFutureDate(200);
  let baseId: number;

  beforeAll(async () => {
    const d = new Date(conflictDate);
    const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
    if (existing.status === 200 && Array.isArray(existing.data)) {
      for (const entry of existing.data) {
        if (entry.entryDate === conflictDate) {
          await apiDelete(`/api/time-entries/${entry.id}`);
        }
      }
    }
  });

  it("TE-BIZ-2.1 – Erstellt Basis-Eintrag 09:00-12:00", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: conflictDate,
      entryType: "bueroarbeit",
      startTime: "09:00",
      endTime: "12:00",
      isFullDay: false,
    });
    expect(res.status).toBe(201);
    baseId = res.data.id;
    cleanupIds.push(baseId);
  });

  it("TE-BIZ-2.2 – Überlappender Eintrag 10:00-11:00 wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: conflictDate,
      entryType: "bueroarbeit",
      startTime: "10:00",
      endTime: "11:00",
      isFullDay: false,
    });
    expect(res.status).toBe(400);
  });

  it("TE-BIZ-2.3 – Nicht-überlappender Eintrag 13:00-14:00 funktioniert", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: conflictDate,
      entryType: "bueroarbeit",
      startTime: "13:00",
      endTime: "14:00",
      isFullDay: false,
    });
    expect(res.status).toBe(201);
    cleanupIds.push(res.data.id);
  });
});

describe("TE-BIZ-3: Ganztags-Konflikte", () => {
  const fullDayDate = getFutureDate(210);

  beforeAll(async () => {
    const d = new Date(fullDayDate);
    const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
    if (existing.status === 200 && Array.isArray(existing.data)) {
      for (const entry of existing.data) {
        if (entry.entryDate === fullDayDate) {
          await apiDelete(`/api/time-entries/${entry.id}`);
        }
      }
    }
  });

  it("TE-BIZ-3.1 – Ganztags-Urlaub erstellen", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: fullDayDate,
      entryType: "urlaub",
      isFullDay: true,
    });
    expect(res.status).toBe(201);
    cleanupIds.push(res.data.id);
  });

  it("TE-BIZ-3.2 – Zweiter Eintrag am selben Ganztag wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: fullDayDate,
      entryType: "bueroarbeit",
      startTime: "09:00",
      endTime: "10:00",
      isFullDay: false,
    });
    expect(res.status).toBe(400);
  });
});

describe("TE-BIZ-4: Urlaubsübersicht", () => {
  it("TE-BIZ-4.1 – Jahresübersicht enthält korrekte Felder", async () => {
    const year = new Date().getFullYear();
    const res = await apiGet<any>(`/api/time-entries/vacation-summary/${year}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("totalDays");
    expect(res.data).toHaveProperty("usedDays");
    expect(res.data).toHaveProperty("remainingDays");
    expect(res.data.totalDays).toBeGreaterThanOrEqual(0);
  });
});
