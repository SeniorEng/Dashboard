import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiDelete,
  apiPatch,
  getAuthCookie,
  createTestEmployee,
  createTestCustomer,
  cleanupCustomer,
  deactivateTestEmployee,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let nonAdminId: number;
let customerId: number;
let hwServiceId: number;
const createdApptIds: number[] = [];

function nextWeekday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() + 1);
  else if (dow === 6) d.setDate(d.getDate() + 2);
  return d.toISOString().split("T")[0];
}

async function tryCreate(date: string, time: string, employeeId: number, duration = 30): Promise<number | null> {
  const res = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: duration }],
    assignedEmployeeId: employeeId,
  });
  if (res.status === 201) {
    createdApptIds.push(res.data.id);
    return res.data.id;
  }
  return null;
}

describe("Travel-Suggestion Scoping (Task #379)", () => {
  let adminApptId: number;
  let foreignApptId: number;
  let appointmentDate: string;

  beforeAll(async () => {
    auth = await getAuthCookie();
    if (!auth.user.isAdmin) throw new Error("Default test user must be admin for this test.");

    const services = await apiGet<any[]>("/api/services/all");
    hwServiceId = services.data.find((s: any) => s.code === "hauswirtschaft")!.id;

    const emp = await createTestEmployee({ nachnamePrefix: "TravelScope" });
    nonAdminId = emp.id;

    const cust = await createTestCustomer({ nachname: `TravelScope_${Date.now()}` });
    customerId = cust.id as number;

    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: nonAdminId,
      backupEmployeeId2: null,
    });
    expect(assignRes.status).toBe(200);

    let foreign: number | null = null;
    let admin: number | null = null;
    for (let off = 30; off <= 120 && (!foreign || !admin); off++) {
      const d = nextWeekday(off);
      const f = await tryCreate(d, "09:00", nonAdminId);
      if (!f) continue;
      const a = await tryCreate(d, "10:00", auth.user.id);
      if (!a) {
        await apiDelete(`/api/appointments/${f}`);
        continue;
      }
      foreign = f;
      admin = a;
      appointmentDate = d;
    }
    if (!foreign || !admin) throw new Error("Konnte keinen passenden Slot finden");
    foreignApptId = foreign;
    adminApptId = admin;
  });

  afterAll(async () => {
    for (const id of createdApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch {}
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(nonAdminId);
  });

  it("schlägt für eigenen Admin-Termin keinen fremden Termin als Vorgänger vor", async () => {
    const res = await apiGet<any>(`/api/appointments/${adminApptId}/travel-suggestion`);
    expect(res.status).toBe(200);
    expect(res.data.suggestedOrigin).toBe("home");
    expect(res.data.previousAppointmentId).toBeNull();
  });

  it("route-calculation lehnt fremde fromAppointmentId ab", async () => {
    const res = await apiGet<any>(
      `/api/appointments/${adminApptId}/route-calculation?originType=appointment&fromAppointmentId=${foreignApptId}`
    );
    expect(res.status).toBe(400);
  });

  it("Admin, der Termin einer anderen Mitarbeiterin dokumentiert, sieht nur deren Termine als Vorgänger-Pool", async () => {
    const res = await apiGet<any>(`/api/appointments/${foreignApptId}/travel-suggestion`);
    expect(res.status).toBe(200);
    expect(res.data.suggestedOrigin).toBe("home");
    expect(res.data.previousAppointmentId).toBeNull();
  });

  it("route-calculation akzeptiert eine fromAppointmentId derselben Mitarbeiterin", async () => {
    let secondId: number | null = null;
    for (const time of ["11:00", "11:30", "12:00", "12:30"]) {
      secondId = await tryCreate(appointmentDate, time, nonAdminId);
      if (secondId) break;
    }
    if (!secondId) throw new Error("Konnte keinen zweiten Termin für nonAdmin anlegen");
    const res = await apiGet<any>(
      `/api/appointments/${secondId}/route-calculation?originType=appointment&fromAppointmentId=${foreignApptId}`
    );
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty("suggestedKilometers");
    expect(res.data).toHaveProperty("suggestedMinutes");
  });
});
