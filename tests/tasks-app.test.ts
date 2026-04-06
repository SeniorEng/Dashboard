import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
const cleanupIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  for (const id of cleanupIds) {
    await apiDelete(`/api/tasks/${id}`);
  }
});

describe("TASK-1: Aufgaben laden", () => {
  it("TASK-1.1 – GET /api/tasks liefert Array", async () => {
    const res = await apiGet<any[]>("/api/tasks");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("TASK-1.2 – GET mit includeCompleted", async () => {
    const res = await apiGet<any[]>("/api/tasks?includeCompleted=true");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("TASK-1.3 – Admin: GET alle Aufgaben", async () => {
    const res = await apiGet<any[]>("/api/tasks?all=true");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});

describe("TASK-2: Aufgabe erstellen", () => {
  it("TASK-2.1 – POST erstellt Aufgabe", async () => {
    const title = `Test-Aufgabe ${uniqueId()}`;
    const res = await apiPost<any>("/api/tasks", {
      title,
      description: "Automatisch erstellt",
      priority: "medium",
    });
    expect(res.status).toBe(201);
    expect(res.data).toHaveProperty("id");
    expect(res.data.title).toBe(title);
    cleanupIds.push(res.data.id);
  });

  it("TASK-2.2 – Aufgabe ohne Titel wird abgelehnt", async () => {
    const res = await apiPost<any>("/api/tasks", {
      description: "Kein Titel",
    });
    expect(res.status).toBe(400);
  });
});

describe("TASK-3: Aufgabe bearbeiten", () => {
  let taskId: number;

  beforeAll(async () => {
    const res = await apiPost<any>("/api/tasks", {
      title: `Bearbeitungs-Test ${uniqueId()}`,
      priority: "low",
    });
    taskId = res.data.id;
    cleanupIds.push(taskId);
  });

  it("TASK-3.1 – PATCH aktualisiert Status", async () => {
    const res = await apiPatch<any>(`/api/tasks/${taskId}`, {
      status: "completed",
    });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("completed");
  });

  it("TASK-3.2 – PATCH aktualisiert Priorität", async () => {
    const res = await apiPatch<any>(`/api/tasks/${taskId}`, {
      priority: "high",
    });
    expect(res.status).toBe(200);
    expect(res.data.priority).toBe("high");
  });

  it("TASK-3.3 – Nicht-existierende Aufgabe liefert 404", async () => {
    const res = await apiPatch<any>("/api/tasks/999999", {
      status: "completed",
    });
    expect(res.status).toBe(404);
  });
});

describe("TASK-4: Aufgabe löschen", () => {
  it("TASK-4.1 – DELETE entfernt Aufgabe", async () => {
    const createRes = await apiPost<any>("/api/tasks", {
      title: `Lösch-Test ${uniqueId()}`,
      priority: "low",
    });
    const id = createRes.data.id;

    const res = await apiDelete(`/api/tasks/${id}`);
    expect(res.status).toBe(204);

    const getRes = await apiGet(`/api/tasks/${id}`);
    expect(getRes.status).toBe(404);
  });

  it("TASK-4.2 – Nicht-existierende Aufgabe liefert 404", async () => {
    const res = await apiDelete("/api/tasks/999999");
    expect(res.status).toBe(404);
  });
});

describe("TASK-5: Zähler und Badge", () => {
  it("TASK-5.1 – GET count liefert Zahl", async () => {
    const res = await apiGet<any>("/api/tasks/count");
    expect(res.status).toBe(200);
    expect(typeof res.data.count).toBe("number");
    expect(res.data.count).toBeGreaterThanOrEqual(0);
  });

  it("TASK-5.2 – GET badge-count liefert Gesamtzahl", async () => {
    const res = await apiGet<any>("/api/tasks/badge-count");
    expect(res.status).toBe(200);
    expect(typeof res.data.count).toBe("number");
    expect(res.data.count).toBeGreaterThanOrEqual(0);
  });
});

describe("TASK-6: Monatsabschluss-Erinnerung", () => {
  it("TASK-6.1 – GET month-closing-reminder liefert Erinnerung", async () => {
    const res = await apiGet<any>("/api/tasks/month-closing-reminder");
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("needed");
    expect(typeof res.data.needed).toBe("boolean");
    if (res.data.needed) {
      expect(res.data).toHaveProperty("month");
      expect(res.data).toHaveProperty("year");
      expect(res.data).toHaveProperty("monthName");
    }
  });
});

describe("TASK-7: Einzelne Aufgabe laden", () => {
  it("TASK-7.1 – GET /:id liefert Aufgabe", async () => {
    const createRes = await apiPost<any>("/api/tasks", {
      title: `Einzeltest ${uniqueId()}`,
      priority: "medium",
    });
    cleanupIds.push(createRes.data.id);

    const res = await apiGet<any>(`/api/tasks/${createRes.data.id}`);
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(createRes.data.id);
  });

  it("TASK-7.2 – Nicht-existierende Aufgabe liefert 404", async () => {
    const res = await apiGet<any>("/api/tasks/999999");
    expect(res.status).toBe(404);
  });
});
