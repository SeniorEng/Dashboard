import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getAuthCookie,
  runCleanup,
  createTestCustomer,
  assignEmployeeToCustomer,
  apiPut,
  apiPost,
} from "./test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let serviceId: number;

beforeAll(async () => {
  auth = await getAuthCookie();
  const customer = await createTestCustomer({
    nachname: `WeekendImport_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
  });
  customerId = customer.id;
  await assignEmployeeToCustomer(customerId, auth.user.id);
  await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", priority: 1, enabled: true, monthlyLimitCents: 13100 },
    ],
  });
  await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentYearAmountCents: 200000,
    carryoverAmountCents: 0,
    budgetStartDate: `${new Date().getFullYear()}-01-01`,
  });

  const { db } = await import("../server/lib/db");
  const { services: servicesTable } = await import("@shared/schema");
  const allServices = await db.select().from(servicesTable);
  const hauswirtschaft = allServices.find((s: any) => /hauswirtschaft/i.test(s.name) || /hauswirtschaft/i.test(s.code ?? ""));
  if (!hauswirtschaft) throw new Error("Service Hauswirtschaft nicht gefunden");
  serviceId = hauswirtschaft.id;
});

afterAll(async () => {
  await runCleanup();
});

function nextSaturday(): string {
  const today = new Date();
  const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
  const sat = new Date(today);
  sat.setDate(sat.getDate() + daysUntilSat);
  return sat.toISOString().split("T")[0];
}

function nextSunday(): string {
  const today = new Date();
  const daysUntilSun = (7 - today.getDay()) % 7 || 7;
  const sun = new Date(today);
  sun.setDate(sun.getDate() + daysUntilSun);
  return sun.toISOString().split("T")[0];
}

describe("Import: Wochenend-Sperre", () => {
  it("matchRows markiert Samstag-Zeile als Fehler (Vorschau)", async () => {
    const { matchRows } = await import("../server/services/appointment-import");
    const sat = nextSaturday();
    const result = await matchRows([
      {
        rowIndex: 1,
        kundeRaw: "Test",
        kundeId: String(customerId),
        vorname: "Test",
        nachname: "Auto",
        date: sat,
        startTime: "09:00",
        endTime: "10:00",
        durationMinutes: 60,
        kilometers: 0,
        employeeName: `${auth.user.vorname} ${auth.user.nachname}`,
        serviceType: "Hauswirtschaft",
        budgetType: "Entlastungsbetrag",
        pflegekasseName: "",
        pflegekasseIK: "",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].errors.some((e) => e.includes("Samstagen oder Sonntagen"))).toBe(true);
    expect(result[0].status).toBe("error");
  });

  it("matchRows markiert Sonntag-Zeile als Fehler (Vorschau)", async () => {
    const { matchRows } = await import("../server/services/appointment-import");
    const sun = nextSunday();
    const result = await matchRows([
      {
        rowIndex: 2,
        kundeRaw: "Test",
        kundeId: String(customerId),
        vorname: "Test",
        nachname: "Auto",
        date: sun,
        startTime: "09:00",
        endTime: "10:00",
        durationMinutes: 60,
        kilometers: 0,
        employeeName: `${auth.user.vorname} ${auth.user.nachname}`,
        serviceType: "Hauswirtschaft",
        budgetType: "Entlastungsbetrag",
        pflegekasseName: "",
        pflegekasseIK: "",
      },
    ]);

    expect(result[0].errors.some((e) => e.includes("Samstagen oder Sonntagen"))).toBe(true);
    expect(result[0].status).toBe("error");
  });

  it("executeImport lehnt manipuliertes Wochenend-Payload ab (Hartvalidierung)", async () => {
    const { executeImport } = await import("../server/services/appointment-import");
    const sat = nextSaturday();

    const beforeCount = await import("../server/lib/db").then(async (m) => {
      const { appointments } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      return (await m.db.select().from(appointments).where(eq(appointments.customerId, customerId))).length;
    });

    const result = await executeImport(
      [
        {
          rowIndex: 99,
          kundeRaw: "Test",
          kundeId: String(customerId),
          vorname: "Test",
          nachname: "Auto",
          date: sat,
          startTime: "09:00",
          endTime: "10:00",
          durationMinutes: 60,
          kilometers: 0,
          employeeName: "",
          serviceType: "Hauswirtschaft",
          budgetType: "Entlastungsbetrag",
          pflegekasseName: "",
          pflegekasseIK: "",
          customerId,
          employeeId: auth.user.id,
          serviceId,
          budgetTypeKey: "entlastungsbetrag_45b",
          status: "new",
          errors: [],
          existingAppointmentId: null,
          differences: [],
          budgetTrimInfo: null,
        },
      ],
      [{ action: "import", rowIndex: 99 }],
      auth.user.id,
    );

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("Samstagen oder Sonntagen");

    const afterCount = await import("../server/lib/db").then(async (m) => {
      const { appointments } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      return (await m.db.select().from(appointments).where(eq(appointments.customerId, customerId))).length;
    });
    expect(afterCount).toBe(beforeCount);
  });
});
