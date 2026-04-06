import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  getAuthCookie,
} from "./test-utils";

beforeAll(async () => {
  await getAuthCookie();
});

describe("NOT-1: Benachrichtigungen laden", () => {
  it("NOT-1.1 – GET /api/notifications liefert Array", async () => {
    const res = await apiGet<any[]>("/api/notifications");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("NOT-1.2 – Mit Limit-Parameter", async () => {
    const res = await apiGet<any[]>("/api/notifications?limit=5");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});

describe("NOT-2: Ungelesen-Zähler", () => {
  it("NOT-2.1 – GET unread-count liefert Zahl", async () => {
    const res = await apiGet<any>("/api/notifications/unread-count");
    expect(res.status).toBe(200);
    expect(typeof res.data.count).toBe("number");
    expect(res.data.count).toBeGreaterThanOrEqual(0);
  });
});

describe("NOT-3: Als gelesen markieren", () => {
  it("NOT-3.1 – PATCH mit ungültiger ID wird akzeptiert (idempotent)", async () => {
    const res = await apiPatch<any>("/api/notifications/999999/read", {});
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("NOT-3.2 – Alle als gelesen markieren", async () => {
    const res = await apiPost<any>("/api/notifications/mark-all-read", {});
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const countRes = await apiGet<any>("/api/notifications/unread-count");
    expect(countRes.data.count).toBe(0);
  });
});
