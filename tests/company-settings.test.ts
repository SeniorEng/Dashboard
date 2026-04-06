import { describe, it, expect, beforeAll } from "vitest";
import {
  apiGet,
  apiPatch,
  getAuthCookie,
  loginAs,
  apiGetAs,
  apiPatchAs,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;

beforeAll(async () => {
  auth = await getAuthCookie();
});

describe("CS-1: Firmendaten laden", () => {
  it("CS-1.1 – GET /api/company-settings liefert Firmendaten", async () => {
    const res = await apiGet<any>("/api/company-settings");
    expect(res.status).toBe(200);
    if (res.data) {
      expect(res.data).toHaveProperty("id");
    }
  });
});

describe("CS-2: Firmendaten bearbeiten (Admin)", () => {
  it("CS-2.1 – PATCH aktualisiert Firmendaten", async () => {
    const res = await apiPatch<any>("/api/company-settings", {
      companyName: "SeniorenEngel Alltagsbegleitung",
    });
    expect(res.status).toBe(200);
  });
});

describe("CS-4: Systemeinstellungen laden", () => {
  it("CS-4.1 – GET /api/settings liefert Einstellungen", async () => {
    const res = await apiGet<any>("/api/settings");
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("id");
  });
});

describe("CS-5: Systemeinstellungen bearbeiten (Admin)", () => {
  it("CS-5.1 – PATCH aktualisiert Systemeinstellungen", async () => {
    const currentSettings = await apiGet<any>("/api/settings");
    const res = await apiPatch<any>("/api/settings", {
      vacationDaysPerYear: currentSettings.data.vacationDaysPerYear || 30,
    });
    expect(res.status).toBe(200);
  });
});
