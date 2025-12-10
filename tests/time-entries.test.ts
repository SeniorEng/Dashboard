import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  getFutureDate,
  getPastDate,
  getTodayDate,
  getAuthCookie,
} from "./test-utils";

interface TimeEntry {
  id: number;
  userId: number;
  entryDate: string;
  entryType: string;
  startTime: string | null;
  endTime: string | null;
  isFullDay: boolean;
  breakMinutes: number | null;
  notes: string | null;
}

interface VacationSummary {
  year: number;
  totalDays: number;
  usedDays: number;
  plannedDays: number;
  remainingDays: number;
}

describe("Zeiterfassung (Time Entries) CRUD", () => {
  let testEntryId: number;
  const testDate = getFutureDate(10);

  beforeAll(async () => {
    await getAuthCookie();
  });

  afterAll(async () => {
    if (testEntryId) {
      await apiDelete(`/api/time-entries/${testEntryId}`);
    }
  });

  describe("Zeiteintrag erstellen (POST /time-entries)", () => {
    it("sollte einen Büro-Zeiteintrag erstellen können", async () => {
      const { status, data } = await apiPost<TimeEntry>("/api/time-entries", {
        entryDate: testDate,
        entryType: "bueroarbeit",
        startTime: "09:00",
        endTime: "12:00",
        isFullDay: false,
        notes: "Test-Büroarbeit",
      });

      expect(status).toBe(201);
      expect(data).toHaveProperty("id");
      expect(data.entryDate).toBe(testDate);
      expect(data.entryType).toBe("bueroarbeit");
      expect(data.startTime).toBe("09:00:00");
      expect(data.endTime).toBe("12:00:00");

      testEntryId = data.id;
    });

    it("sollte Zeitkonflikte erkennen", async () => {
      const { status, data } = await apiPost<{ error: string }>("/api/time-entries", {
        entryDate: testDate,
        entryType: "bueroarbeit",
        startTime: "10:00",
        endTime: "11:00",
        isFullDay: false,
      });

      expect(status).toBe(400);
      expect(data.error).toBeTruthy();
    });

    it("sollte ganztägigen Urlaub erstellen können", async () => {
      const vacationDate = getFutureDate(30);
      const { status, data } = await apiPost<TimeEntry>("/api/time-entries", {
        entryDate: vacationDate,
        entryType: "urlaub",
        isFullDay: true,
      });

      expect(status).toBe(201);
      expect(data.entryType).toBe("urlaub");
      expect(data.isFullDay).toBe(true);

      await apiDelete(`/api/time-entries/${data.id}`);
    });

    it("sollte Mehrtages-Urlaub erstellen können", async () => {
      const startDate = getFutureDate(40);
      const endDate = getFutureDate(42);
      
      const { status, data } = await apiPost<TimeEntry & { _multiDay?: { count: number } }>("/api/time-entries", {
        entryDate: startDate,
        endDate: endDate,
        entryType: "urlaub",
        isFullDay: true,
      });

      expect(status).toBe(201);
      expect(data._multiDay?.count).toBe(3);

      const entries = await apiGet<TimeEntry[]>(`/api/time-entries?entryType=urlaub`);
      const createdEntries = (entries.data || []).filter(
        (e) => e.entryDate >= startDate && e.entryDate <= endDate
      );
      
      for (const entry of createdEntries) {
        await apiDelete(`/api/time-entries/${entry.id}`);
      }
    });
  });

  describe("Zeiteintrag abrufen (GET /time-entries)", () => {
    it("sollte Zeiteinträge abrufen können", async () => {
      const { status, data } = await apiGet<TimeEntry[]>("/api/time-entries");

      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });

    it("sollte nach Jahr/Monat filtern können", async () => {
      const year = new Date().getFullYear();
      const month = new Date().getMonth() + 1;
      
      const { status, data } = await apiGet<TimeEntry[]>(
        `/api/time-entries?year=${year}&month=${month}`
      );

      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });

    it("sollte einen einzelnen Eintrag abrufen können", async () => {
      const { status, data } = await apiGet<TimeEntry>(`/api/time-entries/${testEntryId}`);

      expect(status).toBe(200);
      expect(data.id).toBe(testEntryId);
    });
  });

  describe("Zeiteintrag bearbeiten (PUT /time-entries/:id)", () => {
    it("sollte einen Zeiteintrag bearbeiten können", async () => {
      const { status, data } = await apiPut<TimeEntry>(`/api/time-entries/${testEntryId}`, {
        notes: "Aktualisierte Notiz",
        endTime: "13:00",
      });

      expect(status).toBe(200);
      expect(data.notes).toBe("Aktualisierte Notiz");
      expect(data.endTime).toBe("13:00:00");
    });

    it("sollte Zeit-Konfliktprüfung bei Bearbeitung durchführen", async () => {
      const conflictEntry = await apiPost<TimeEntry>("/api/time-entries", {
        entryDate: testDate,
        entryType: "bueroarbeit",
        startTime: "14:00",
        endTime: "15:00",
        isFullDay: false,
      });

      const { status } = await apiPut(`/api/time-entries/${conflictEntry.data.id}`, {
        startTime: "09:30",
        endTime: "10:30",
      });

      expect(status).toBe(400);

      await apiDelete(`/api/time-entries/${conflictEntry.data.id}`);
    });
  });

  describe("Zeiteintrag löschen (DELETE /time-entries/:id)", () => {
    it("sollte einen Zeiteintrag löschen können", async () => {
      const newEntry = await apiPost<TimeEntry>("/api/time-entries", {
        entryDate: getFutureDate(50),
        entryType: "bueroarbeit",
        startTime: "08:00",
        endTime: "09:00",
        isFullDay: false,
      });

      const { status } = await apiDelete(`/api/time-entries/${newEntry.data.id}`);
      expect(status).toBe(204);

      const getRes = await apiGet(`/api/time-entries/${newEntry.data.id}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe("Urlaubsübersicht (Vacation Summary)", () => {
    it("sollte die Urlaubsübersicht abrufen können", async () => {
      const year = new Date().getFullYear();
      const { status, data } = await apiGet<VacationSummary>(`/api/time-entries/vacation-summary/${year}`);

      expect(status).toBe(200);
      expect(data.year).toBe(year);
      expect(typeof data.totalDays).toBe("number");
      expect(typeof data.usedDays).toBe("number");
      expect(typeof data.remainingDays).toBe("number");
    });
  });

  describe("Offene Aufgaben (Open Tasks)", () => {
    it("sollte offene Aufgaben abrufen können", async () => {
      const { status, data } = await apiGet<unknown[]>("/api/time-entries/open-tasks");

      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });
  });
});

describe("Pausenprüfung §4 ArbZG", () => {
  interface OpenTask {
    type: string;
    date?: string;
    entryId?: number;
    message?: string;
  }

  it("sollte Pausenwarnung bei >6h Arbeitszeit ohne Pause liefern", async () => {
    const testDate = getPastDate(1);
    
    const entry = await apiPost<TimeEntry>("/api/time-entries", {
      entryDate: testDate,
      entryType: "bueroarbeit",
      startTime: "08:00",
      endTime: "15:00",
      isFullDay: false,
      breakMinutes: 0,
    });

    expect(entry.status).toBe(201);

    const openTasks = await apiGet<OpenTask[]>("/api/time-entries/open-tasks");
    expect(openTasks.status).toBe(200);
    expect(Array.isArray(openTasks.data)).toBe(true);
    
    const breakWarning = openTasks.data.find(
      task => task.type === "missing_break" || task.type === "break_warning"
    );
    
    await apiDelete(`/api/time-entries/${entry.data.id}`);
  });

  it("sollte bei korrekter Pause keine Warnung zeigen", async () => {
    const testDate = getFutureDate(61);
    
    const entry = await apiPost<TimeEntry>("/api/time-entries", {
      entryDate: testDate,
      entryType: "bueroarbeit",
      startTime: "08:00",
      endTime: "15:00",
      isFullDay: false,
      breakMinutes: 30,
    });

    expect(entry.status).toBe(201);
    expect(entry.data.breakMinutes).toBe(30);
    
    await apiDelete(`/api/time-entries/${entry.data.id}`);
  });

  it("sollte Arbeitszeit korrekt berechnen (7h Arbeit - 30min Pause = 6.5h)", async () => {
    const testDate = getFutureDate(62);
    
    const entry = await apiPost<TimeEntry>("/api/time-entries", {
      entryDate: testDate,
      entryType: "bueroarbeit",
      startTime: "08:00",
      endTime: "15:30",
      isFullDay: false,
      breakMinutes: 30,
    });

    expect(entry.status).toBe(201);
    expect(entry.data.startTime).toBe("08:00:00");
    expect(entry.data.endTime).toBe("15:30:00");
    expect(entry.data.breakMinutes).toBe(30);
    
    await apiDelete(`/api/time-entries/${entry.data.id}`);
  });
});
