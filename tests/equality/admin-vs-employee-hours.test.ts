/**
 * Task #838 — Parity: Admin-Zeitübersicht === Mitarbeiter-Eigensicht.
 *
 * Historischer Bug (#481): Die Admin-Zeitübersicht
 * (`getAdminTimeTrackingOverview`, userId=undefined) gruppierte Termine stumpf
 * nach `assignedEmployeeId` und verwarf NULL-Zuweisungen. Die Mitarbeiter-
 * Eigensicht (`getEmployeeAppointments`) rechnet abgeschlossene Termine
 * dagegen über `performedByEmployeeId` und offene, nicht zugewiesene Termine
 * über die Vertretungs-Kette des Kunden zu. Folge: Ein Admin sah für denselben
 * Mitarbeiter andere (weniger) Termine/Stunden als der Mitarbeiter selbst.
 *
 * Dieser Test legt einen kontrollierten Datensatz direkt in der DB an (volle
 * Kontrolle über `assignedEmployeeId`/`performedByEmployeeId`/`status`) und
 * prüft, dass die pro Mitarbeiter zugeordneten Termin-IDs beider Code-Pfade
 * exakt übereinstimmen — inkl. des früher verlorenen "NULL-zugewiesen, aber
 * durchgeführt"-Falls.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments } from "@shared/schema";
import {
  getEmployeeAppointments,
  getAllAppointmentsInRange,
} from "../../server/storage/time-tracking/appointments";
import { getAdminTimeTrackingOverview } from "../../server/storage/time-tracking/overview";
import {
  apiPatch,
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  runCleanup,
  trackCleanup,
} from "../test-utils";

// Weit in der Zukunft, damit der Datensatz keine andere Test-/Seed-Daten im
// selben Monatsfenster kreuzt. Direkte DB-Inserts → Wochenend-/Cutoff-Policies
// spielen keine Rolle.
const YEAR = 2031;
const MONTH = 3;
const START = `${YEAR}-0${MONTH}-01`;
const END = `${YEAR}-0${MONTH}-31`;
const DATE = `${YEAR}-0${MONTH}-10`;

let empA: { id: number };
let empB: { id: number };
let customerId: number;
const apptIds: number[] = [];
let idAssignedAOpen = 0;
let idNullPerformedA = 0;
let idNullOpenCoverage = 0;
let idAssignedBCompleted = 0;
let idAssignedAPerformedB = 0;

beforeAll(async () => {
  await getAuthCookie();
  empA = await createTestEmployee({ nachnamePrefix: "ParityA" });
  empB = await createTestEmployee({ nachnamePrefix: "ParityB" });

  const customer = await createTestCustomer();
  customerId = customer.id as number;
  trackCleanup(async () => {
    try {
      const { apiPost } = await import("../test-utils");
      await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [customerId] });
    } catch { /* best-effort */ }
  });

  // empA ist Primär-Mitarbeiter des Kunden (Coverage), empB nicht.
  await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: empA.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });

  const base = {
    customerId,
    appointmentType: "kundentermin" as const,
    date: DATE,
    scheduledStart: "09:00",
    durationPromised: 60,
  };

  const inserted = await db
    .insert(appointments)
    .values([
      // 1) offen + empA zugewiesen → A
      { ...base, status: "scheduled", assignedEmployeeId: empA.id, performedByEmployeeId: null },
      // 2) abgeschlossen, NULL zugewiesen, von A durchgeführt → A (Bug-Fall)
      { ...base, status: "completed", assignedEmployeeId: null, performedByEmployeeId: empA.id },
      // 3) offen, NULL zugewiesen → Coverage (Primär = A) → A
      { ...base, status: "scheduled", assignedEmployeeId: null, performedByEmployeeId: null },
      // 4) abgeschlossen, empB zugewiesen + durchgeführt → B
      { ...base, status: "completed", assignedEmployeeId: empB.id, performedByEmployeeId: empB.id },
      // 5) abgeschlossen, empA zugewiesen, aber von B durchgeführt → B
      { ...base, status: "completed", assignedEmployeeId: empA.id, performedByEmployeeId: empB.id },
    ])
    .returning({ id: appointments.id });

  [
    idAssignedAOpen,
    idNullPerformedA,
    idNullOpenCoverage,
    idAssignedBCompleted,
    idAssignedAPerformedB,
  ] = inserted.map((r) => r.id);
  apptIds.push(...inserted.map((r) => r.id));

  trackCleanup(async () => {
    try {
      await db.delete(appointments).where(inArray(appointments.id, apptIds));
    } catch { /* best-effort */ }
  });
});

afterAll(async () => {
  await runCleanup();
});

function mineOnly(ids: number[]): number[] {
  return ids.filter((id) => apptIds.includes(id)).sort((a, b) => a - b);
}

describe("Parity — Admin-Zeitübersicht === Mitarbeiter-Eigensicht (Task #838)", () => {
  it("pro Mitarbeiter dieselben Termin-IDs in Admin- und Eigensicht", async () => {
    const admin = await getAdminTimeTrackingOverview({ year: YEAR, month: MONTH });

    const adminA = mineOnly((admin.appointmentsByEmployeeId[empA.id] ?? []).map((a) => a.id));
    const adminB = mineOnly((admin.appointmentsByEmployeeId[empB.id] ?? []).map((a) => a.id));

    const selfA = mineOnly(
      (await getEmployeeAppointments(empA.id, START, END)).map((a) => a.id),
    );
    const selfB = mineOnly(
      (await getEmployeeAppointments(empB.id, START, END)).map((a) => a.id),
    );

    // Erwartete Zuordnung
    const expectedA = [idAssignedAOpen, idNullPerformedA, idNullOpenCoverage].sort((a, b) => a - b);
    const expectedB = [idAssignedBCompleted, idAssignedAPerformedB].sort((a, b) => a - b);

    expect(selfA).toEqual(expectedA);
    expect(selfB).toEqual(expectedB);

    // Kern der Parität: beide Code-Pfade liefern dieselbe Menge.
    expect(adminA).toEqual(selfA);
    expect(adminB).toEqual(selfB);
  });

  it("der früher verlorene 'NULL-zugewiesen, aber durchgeführt'-Termin landet beim Admin bei A", async () => {
    const admin = await getAdminTimeTrackingOverview({ year: YEAR, month: MONTH });
    const adminA = (admin.appointmentsByEmployeeId[empA.id] ?? []).map((a) => a.id);
    expect(adminA).toContain(idNullPerformedA);
    // ... und NICHT fälschlich bei B.
    const adminB = (admin.appointmentsByEmployeeId[empB.id] ?? []).map((a) => a.id);
    expect(adminB).not.toContain(idNullPerformedA);
  });

  it("sanity: getAllAppointmentsInRange enthält den vollständigen Test-Datensatz", async () => {
    const all = await getAllAppointmentsInRange(START, END);
    const found = mineOnly(all.map((a) => a.id));
    expect(found).toEqual([...apptIds].sort((a, b) => a - b));
  });
});
