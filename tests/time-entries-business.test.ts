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

function getNextWeekday(date: Date): Date {
  const dow = date.getDay();
  if (dow === 0) date.setDate(date.getDate() + 1);
  else if (dow === 6) date.setDate(date.getDate() + 2);
  return date;
}

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
    expect(res.data).toHaveProperty("id");
    expect(res.data.entryType).toBe("bueroarbeit");
    baseId = res.data.id;
    cleanupIds.push(baseId);
  });

  it("TE-BIZ-2.2 – Überlappender Eintrag 10:00-11:00 wird abgelehnt", async () => {
    expect(baseId, "baseId muss aus TE-BIZ-2.1 gesetzt sein").toBeTruthy();
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
    expect(res.data.startTime).toContain("13:00");
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
    expect(res.data.entryType).toBe("urlaub");
    expect(res.data.isFullDay).toBe(true);
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
    expect(typeof res.data.totalDays).toBe("number");
    expect(typeof res.data.usedDays).toBe("number");
    expect(typeof res.data.remainingDays).toBe("number");
    expect(res.data.totalDays).toBeGreaterThanOrEqual(0);
  });
});

describe("TE-BIZ-5: Mehrtägiger Urlaub überspringt Wochenenden", () => {
  const vacStartDate = getFutureDate(240);
  let createdEntryIds: number[] = [];

  beforeAll(async () => {
    const d = new Date(vacStartDate);
    const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
    if (existing.status === 200 && Array.isArray(existing.data)) {
      for (const entry of existing.data) {
        if (entry.entryDate >= vacStartDate) {
          await apiDelete(`/api/time-entries/${entry.id}`);
        }
      }
    }
  });

  it("TE-BIZ-5.1 – Mehrtägiger Urlaub (Montag-Sonntag) erstellt nur Werktage", async () => {
    const start = new Date(vacStartDate);
    while (start.getDay() !== 1) {
      start.setDate(start.getDate() + 1);
    }
    const startStr = start.toISOString().split("T")[0];
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const endStr = end.toISOString().split("T")[0];

    const res = await apiPost<any>("/api/time-entries/range", {
      startDate: startStr,
      endDate: endStr,
      entryType: "urlaub",
    });

    if (res.status === 201) {
      expect(Array.isArray(res.data), "time-entries gibt ein Array zurück").toBe(true);
      const entries = res.data as any[];
      for (const e of entries) {
        if (e.id) {
          createdEntryIds.push(e.id);
          cleanupIds.push(e.id);
        }
        const day = new Date(e.entryDate + "T00:00:00").getDay();
        expect(day).not.toBe(0);
        expect(day).not.toBe(6);
      }
      expect(entries.length).toBe(5);
    } else {
      expect(res.status).toBe(200);
    }
  });
});

describe("TE-BIZ-6: Krankheitseintrag", () => {
  const sickDate = getFutureDate(250);

  beforeAll(async () => {
    const d = new Date(sickDate);
    const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
    if (existing.status === 200 && Array.isArray(existing.data)) {
      for (const entry of existing.data) {
        if (entry.entryDate === sickDate) {
          await apiDelete(`/api/time-entries/${entry.id}`);
        }
      }
    }
  });

  it("TE-BIZ-6.1 – Krankheitseintrag erstellen", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: sickDate,
      entryType: "krankheit",
      isFullDay: true,
    });
    expect(res.status).toBe(201);
    expect(res.data.entryType).toBe("krankheit");
    expect(res.data.isFullDay).toBe(true);
    cleanupIds.push(res.data.id);
  });
});

describe("TE-BIZ-7: Zeiterfassungs-Löschung", () => {
  it("TE-BIZ-7.1 – Zukunfts-Zeiteintrag kann gelöscht werden", async () => {
    const futureDate = getFutureDate(215);
    const d = new Date(futureDate);
    const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
    if (existing.status === 200 && Array.isArray(existing.data)) {
      for (const entry of existing.data) {
        if (entry.entryDate === futureDate) {
          await apiDelete(`/api/time-entries/${entry.id}`);
        }
      }
    }

    const createRes = await apiPost<any>("/api/time-entries", {
      entryDate: futureDate,
      entryType: "bueroarbeit",
      startTime: "08:00",
      endTime: "09:00",
      isFullDay: false,
    });
    expect(createRes.status).toBe(201);
    const id = createRes.data.id;

    const delRes = await apiDelete(`/api/time-entries/${id}`);
    expect(delRes.status).toBe(204);
  });
});

describe("TE-BIZ-8: Verschiedene Eintragstypen", () => {
  const typeDate = getFutureDate(260);

  beforeAll(async () => {
    const d = new Date(typeDate);
    const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
    if (existing.status === 200 && Array.isArray(existing.data)) {
      for (const entry of existing.data) {
        if (entry.entryDate === typeDate) {
          await apiDelete(`/api/time-entries/${entry.id}`);
        }
      }
    }
  });

  it("TE-BIZ-8.1 – Schulung-Eintrag erstellen", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: typeDate,
      entryType: "schulung",
      startTime: "09:00",
      endTime: "12:00",
      isFullDay: false,
    });
    expect(res.status).toBe(201);
    expect(res.data.entryType).toBe("schulung");
    cleanupIds.push(res.data.id);
  });
});

describe("TE-BIZ-9: Wochenend-Einschränkung", () => {
  it("TE-BIZ-9.1 – Eintrag am Samstag wird abgelehnt", async () => {
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

  it("TE-BIZ-9.2 – Eintrag am Sonntag wird abgelehnt", async () => {
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

describe("TE-BIZ-10: End-Zeit vor Start-Zeit", () => {
  it("TE-BIZ-10.1 – Endzeit vor Startzeit wird abgelehnt", async () => {
    const date = getFutureDate(265);
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "bueroarbeit",
      startTime: "14:00",
      endTime: "10:00",
      isFullDay: false,
    });
    expect(res.status).toBe(400);
  });
});

describe("TE-BIZ-11: Ganztags-Konflikte", () => {
  it("TE-BIZ-11.1 – Ganztags-Urlaub blockiert weitere Einträge", async () => {
    const date = getFutureDate(270);
    const d = new Date(date);
    const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
    if (existing.status === 200 && Array.isArray(existing.data)) {
      for (const entry of existing.data) {
        if (entry.entryDate === date) {
          await apiDelete(`/api/time-entries/${entry.id}`);
        }
      }
    }

    const vacRes = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "urlaub",
      isFullDay: true,
    });
    expect(vacRes.status).toBe(201);
    cleanupIds.push(vacRes.data.id);

    const workRes = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "bueroarbeit",
      startTime: "09:00",
      endTime: "12:00",
      isFullDay: false,
    });
    expect([400, 409]).toContain(workRes.status);
  });
});

describe("TE-BIZ-12: Überlappungserkennung", () => {
  it("TE-BIZ-12.1 – Überlappende Zeiteinträge werden abgelehnt", async () => {
    const date = getFutureDate(275);
    const d = new Date(date);
    const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
    if (existing.status === 200 && Array.isArray(existing.data)) {
      for (const entry of existing.data) {
        if (entry.entryDate === date) {
          await apiDelete(`/api/time-entries/${entry.id}`);
        }
      }
    }

    const res1 = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "bueroarbeit",
      startTime: "09:00",
      endTime: "12:00",
      isFullDay: false,
    });
    expect(res1.status).toBe(201);
    cleanupIds.push(res1.data.id);

    const res2 = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "schulung",
      startTime: "11:00",
      endTime: "13:00",
      isFullDay: false,
    });
    expect([400, 409]).toContain(res2.status);
  });
});
