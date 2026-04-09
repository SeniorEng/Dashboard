import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPatch,
  getAuthCookie,
} from "./test-utils";

let originalCompanySettings: Record<string, any> | null = null;
let originalSystemSettings: Record<string, any> | null = null;

beforeAll(async () => {
  await getAuthCookie();
  const csRes = await apiGet<any>("/api/company-settings");
  if (csRes.status === 200) originalCompanySettings = csRes.data;
  const ssRes = await apiGet<any>("/api/settings");
  if (ssRes.status === 200) originalSystemSettings = ssRes.data;
});

afterAll(async () => {
  if (originalCompanySettings) {
    await apiPatch("/api/company-settings", {
      companyName: originalCompanySettings.companyName,
    });
  }
  if (originalSystemSettings) {
    await apiPatch("/api/settings", {
      vacationDaysPerYear: originalSystemSettings.vacationDaysPerYear,
    });
  }
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
