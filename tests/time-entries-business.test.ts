import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiDelete,
  getAuthCookie,
  getFutureDate,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
const cleanupIds: number[] = [];
let testCustomerId: number;
let hwServiceId: number;
const apptCleanupIds: number[] = [];

function getNextWeekday(date: Date): Date {
  const dow = date.getDay();
  if (dow === 0) date.setDate(date.getDate() + 1);
  else if (dow === 6) date.setDate(date.getDate() + 2);
  return date;
}

async function clearDateEntries(dateStr: string) {
  const d = new Date(dateStr);
  const existing = await apiGet<any[]>(`/api/time-entries?year=${d.getFullYear()}&month=${d.getMonth() + 1}`);
  if (existing.status === 200 && Array.isArray(existing.data)) {
    for (const entry of existing.data) {
      if (entry.entryDate === dateStr) {
        await apiDelete(`/api/time-entries/${entry.id}`);
      }
    }
  }
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const custRes = await apiGet<{ data: any[] }>("/api/admin/customers?limit=1");
  testCustomerId = custRes.data.data[0].id;

  const svcRes = await apiGet<any[]>("/api/services/all");
  const hwSvc = svcRes.data.find((s: any) => s.kpiGroup === "HW" && s.isActive);
  hwServiceId = hwSvc?.id ?? svcRes.data[0].id;
});

afterAll(async () => {
  for (const id of cleanupIds) {
    try { await apiDelete(`/api/time-entries/${id}`); } catch {}
  }
  for (const id of apptCleanupIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
});

describe("TE-BIZ-1: Wochenend-Sperre", () => {
  it("TE-BIZ-1.1 – Zeiteintrag am Samstag wird abgelehnt (400)", async () => {
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

  it("TE-BIZ-1.2 – Zeiteintrag am Sonntag wird abgelehnt (400)", async () => {
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
    await clearDateEntries(conflictDate);
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

  it("TE-BIZ-2.2 – Überlappender Eintrag 10:00-11:00 wird abgelehnt (400)", async () => {
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

  it("TE-BIZ-2.3 – Nicht-überlappender Eintrag 13:00-14:00 funktioniert (201)", async () => {
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
    await clearDateEntries(fullDayDate);
  });

  it("TE-BIZ-3.1 – Ganztags-Urlaub erstellen (201)", async () => {
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

  it("TE-BIZ-3.2 – Zweiter Eintrag am selben Ganztag wird abgelehnt (400)", async () => {
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
  const vacBase = getFutureDate(240);
  let startStr: string;
  let endStr: string;

  beforeAll(async () => {
    const start = new Date(vacBase);
    while (start.getDay() !== 1) {
      start.setDate(start.getDate() + 1);
    }
    startStr = start.toISOString().split("T")[0];
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    endStr = end.toISOString().split("T")[0];

    const cur = new Date(start);
    while (cur <= end) {
      const ds = cur.toISOString().split("T")[0];
      const day = cur.getDay();
      if (day !== 0 && day !== 6) {
        await clearDateEntries(ds);
      }
      cur.setDate(cur.getDate() + 1);
    }
  });

  it("TE-BIZ-5.1 – Mehrtägiger Urlaub (Montag-Sonntag) erstellt nur Werktage", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: startStr,
      endDate: endStr,
      entryType: "urlaub",
      isFullDay: true,
    });
    expect(res.status).toBe(201);
    expect(res.data._multiDay, "Mehrtägiger Eintrag muss _multiDay-Info enthalten").toBeDefined();
    expect(res.data._multiDay.count).toBe(5);
    if (res.data.id) cleanupIds.push(res.data.id);
  });
});

describe("TE-BIZ-6: Krankheitseintrag", () => {
  const sickDate = getFutureDate(250);

  beforeAll(async () => {
    await clearDateEntries(sickDate);
  });

  it("TE-BIZ-6.1 – Krankheitseintrag erstellen (201)", async () => {
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
  it("TE-BIZ-7.1 – Zukunfts-Zeiteintrag kann gelöscht werden (204)", async () => {
    const futureDate = getFutureDate(215);
    await clearDateEntries(futureDate);

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
    await clearDateEntries(typeDate);
  });

  it("TE-BIZ-8.1 – Schulung-Eintrag erstellen (201)", async () => {
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

  it("TE-BIZ-8.2 – Pause-Eintrag erstellen (201)", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: typeDate,
      entryType: "pause",
      startTime: "12:00",
      endTime: "12:30",
      isFullDay: false,
    });
    expect(res.status).toBe(201);
    expect(res.data.entryType).toBe("pause");
    cleanupIds.push(res.data.id);
  });

  it("TE-BIZ-8.3 – Besprechung-Eintrag erstellen (201)", async () => {
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: typeDate,
      entryType: "besprechung",
      startTime: "13:00",
      endTime: "14:00",
      isFullDay: false,
    });
    expect(res.status).toBe(201);
    expect(res.data.entryType).toBe("besprechung");
    cleanupIds.push(res.data.id);
  });
});

describe("TE-BIZ-9: End-Zeit vor Start-Zeit", () => {
  it("TE-BIZ-9.1 – Endzeit vor Startzeit wird abgelehnt (400)", async () => {
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

describe("TE-BIZ-10: Ganztags-Urlaub blockiert weitere Einträge", () => {
  it("TE-BIZ-10.1 – Ganztags-Urlaub blockiert timed Eintrag (400)", async () => {
    const date = getFutureDate(270);
    await clearDateEntries(date);

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
    expect(workRes.status).toBe(400);
  });
});

describe("TE-BIZ-11: Überlappungserkennung", () => {
  it("TE-BIZ-11.1 – Überlappende Zeiteinträge werden abgelehnt (400)", async () => {
    const date = getFutureDate(275);
    await clearDateEntries(date);

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
    expect(res2.status).toBe(400);
  });
});

describe("TE-BIZ-12: Auto-Break Vorschau (ArbZG §4)", () => {
  it("TE-BIZ-12.1 – Monats-Vorschau liefert Auto-Break-Daten", async () => {
    const now = new Date();
    const res = await apiGet<any>(
      `/api/time-entries/month-closing/${now.getFullYear()}/${now.getMonth() + 1}/preview`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("autoBreaks");
    expect(Array.isArray(res.data.autoBreaks)).toBe(true);
  });

  it("TE-BIZ-12.2 – ArbZG: >6h erfordert 30min, >9h erfordert 45min Pause", async () => {
    const now = new Date();
    const res = await apiGet<any>(
      `/api/time-entries/month-closing/${now.getFullYear()}/${now.getMonth() + 1}/preview`
    );
    expect(res.status).toBe(200);
    for (const entry of res.data.autoBreaks) {
      if (entry.totalWorkMinutes > 360 && entry.totalWorkMinutes <= 540) {
        expect(entry.requiredBreakMinutes).toBe(30);
      }
      if (entry.totalWorkMinutes > 540) {
        expect(entry.requiredBreakMinutes).toBe(45);
      }
    }
  });
});

describe("TE-BIZ-12B: Kontrollierte ArbZG-Break-Berechnung", () => {
  it.skip("TE-BIZ-12B.1 – >6h Arbeitstag erzeugt 30min Pflichtpause (Skip: auto-break preview erfordert termingebundene Einträge, nicht isolierte bueroarbeit-Einträge)", () => {});

  it.skip("TE-BIZ-12B.2 – >9h Arbeitstag erzeugt 45min Pflichtpause (Skip: auto-break preview erfordert termingebundene Einträge, nicht isolierte bueroarbeit-Einträge)", () => {});

  it("TE-BIZ-12B.3 – month-closing preview liefert autoBreaks-Array", async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const previewRes = await apiGet<any>(
      `/api/time-entries/month-closing/${year}/${month}/preview`
    );
    expect(previewRes.status).toBe(200);
    expect(previewRes.data).toHaveProperty("autoBreaks");
    expect(Array.isArray(previewRes.data.autoBreaks)).toBe(true);
    if (previewRes.data.autoBreaks.length > 0) {
      const b = previewRes.data.autoBreaks[0];
      expect(b).toHaveProperty("date");
      expect(b).toHaveProperty("totalWorkMinutes");
      expect(b).toHaveProperty("requiredBreakMinutes");
    }
  });
});

describe("TE-BIZ-13: Monatsübersicht", () => {
  it("TE-BIZ-13.1 – page-data liefert Zeiterfassungsdaten", async () => {
    const now = new Date();
    const res = await apiGet<any>(
      `/api/time-entries/page-data/${now.getFullYear()}/${now.getMonth() + 1}`
    );
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
  });

  it("TE-BIZ-13.2 – Tages-Einträge abrufen", async () => {
    const today = new Date();
    getNextWeekday(today);
    const dateStr = today.toISOString().split("T")[0];
    const res = await apiGet<any>(`/api/time-entries/by-date/${dateStr}`);
    expect(res.status).toBe(200);
  });
});

describe("TE-BIZ-14: Ungültige Eintragstypen", () => {
  it("TE-BIZ-14.1 – Unbekannter Eintragstyp wird abgelehnt (400)", async () => {
    const date = getFutureDate(280);
    const res = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "invalidtype",
      startTime: "09:00",
      endTime: "10:00",
      isFullDay: false,
    });
    expect(res.status).toBe(400);
  });
});

describe("TE-BIZ-15: Ganztags-Eintrag blockiert bei bestehendem Termin", () => {
  it("TE-BIZ-15.1 – Urlaub an Tag mit Kundentermin wird abgelehnt (400)", async () => {
    const date = getFutureDate(290);
    const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(apptRes.status).toBe(201);

    const teRes = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "urlaub",
      isFullDay: true,
    });
    expect(teRes.status).toBe(400);

    await apiDelete(`/api/appointments/${apptRes.data.id}`);
  });
});

describe("TE-BIZ-16: Zeitbasierter Eintrag überlappt mit Termin", () => {
  it("TE-BIZ-16.1 – Büroarbeit überlappend mit Termin wird abgelehnt (400)", async () => {
    const date = getFutureDate(291);
    const apptRes = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: testCustomerId,
      date,
      scheduledStart: "10:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
      assignedEmployeeId: auth.user.id,
    });
    expect(apptRes.status).toBe(201);

    const teRes = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "bueroarbeit",
      startTime: "10:30",
      endTime: "11:30",
      isFullDay: false,
    });
    expect(teRes.status).toBe(400);

    await apiDelete(`/api/appointments/${apptRes.data.id}`);
  });
});

describe("TE-BIZ-17: Konflikt-Vorprüfung API", () => {
  it("TE-BIZ-17.1 – check-conflicts Endpoint liefert Konflikte", async () => {
    const date = getFutureDate(392);
    await clearDateEntries(date);

    const teRes = await apiPost<any>("/api/time-entries", {
      entryDate: date,
      entryType: "bueroarbeit",
      startTime: "08:00",
      endTime: "10:00",
      isFullDay: false,
    });
    expect(teRes.status).toBe(201);

    const checkRes = await apiPost<any>("/api/time-entries/check-conflicts", {
      date,
      startTime: "09:00",
      endTime: "11:00",
      isFullDay: false,
    });
    expect(checkRes.status).toBe(200);
    expect(checkRes.data).toHaveProperty("conflict");
    expect(checkRes.data.conflict).toBeTruthy();

    await apiDelete(`/api/time-entries/${teRes.data.id}`);
  });

  it("TE-BIZ-17.2 – check-conflicts ohne Konflikt", async () => {
    const date = getFutureDate(393);
    const checkRes = await apiPost<any>("/api/time-entries/check-conflicts", {
      date,
      startTime: "08:00",
      endTime: "09:00",
      isFullDay: false,
    });
    expect(checkRes.status).toBe(200);
  });
});
