/**
 * Task #1585 — Urlaubs-/Kranken-Stunden dürfen NIE in die gearbeiteten
 * Service-Summen leaken.
 *
 * Task #1584 hat der Mitarbeiter-„Meine Zeiten"-Stundenkachel informative
 * Urlaubs-/Kranken-Stunden hinzugefügt, abgeleitet aus der SSoT
 * `dailySollHours` (monthlyWorkHours ÷ 21,7 × Tage). Diese Zeilen sind rein
 * informativ: Sie dürfen NICHT in die dokumentierten/geplanten Service-Summen
 * (`serviceHours`/`completedServiceHours`/`plannedServiceHours`) und damit auch
 * nicht in das EU-Rentner-Monatslimit einfließen.
 *
 * Ohne Regressionstest könnte ein künftiger Refactor der Overview-Aggregation
 * stillschweigend anfangen, Abwesenheits-Stunden als gearbeitete Zeit
 * mitzuzählen. Dieser Test seedet einen Mitarbeiter mit vertraglichen
 * Monatsstunden plus Urlaubs-/Kranken-Einträgen und prüft:
 *  - urlaubHours/krankheitHours == Tage × dailySoll (SSoT-Deckungsgleichheit)
 *  - die Service-Summen bleiben durch die Abwesenheits-Einträge UNVERÄNDERT
 *  - ein Mitarbeiter mit 0 Monatsstunden bekommt urlaubHours/krankheitHours == 0
 *    (kein Crash, Tages-Soll = 0)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../server/lib/db";
import { appointments, appointmentServices, employeeTimeEntries } from "@shared/schema";
import { users } from "@shared/schema/users";
import { getTimeOverview } from "../server/storage/time-tracking/overview";
import { dailySollHours } from "../server/storage/time-tracking/payroll-hours";
import {
  apiGet,
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  runCleanup,
  trackCleanup,
} from "./test-utils";

// Weit in der Zukunft, damit der Datensatz keine Seed-/Test-Daten im selben
// Monatsfenster kreuzt. Direkte DB-Inserts ⇒ Wochenend-/Cutoff-Policies egal.
const YEAR = 2094;
const MONTH = 5;
const DATE = `${YEAR}-0${MONTH}-10`;
const URLAUB_1 = `${YEAR}-0${MONTH}-06`;
const URLAUB_2 = `${YEAR}-0${MONTH}-07`;
const KRANK_1 = `${YEAR}-0${MONTH}-08`;

// monthlyWorkHours 217 ⇒ dailySoll = 217 / 21,7 = 10,0 h.
const MONTHLY_WORK_HOURS = 217;

let empWithSoll: { id: number };
let empZeroSoll: { id: number };
let customerId: number;
let hwServiceId: number;
const WORKED_MINUTES = 90;

beforeAll(async () => {
  await getAuthCookie();

  empWithSoll = await createTestEmployee({ nachnamePrefix: "AbsenceSepSoll" });
  empZeroSoll = await createTestEmployee({ nachnamePrefix: "AbsenceSepZero" });

  // Vertragliche Monatsstunden setzen (createTestEmployee legt keine an).
  await db
    .update(users)
    .set({ monthlyWorkHours: MONTHLY_WORK_HOURS, employmentType: "sozialversicherungspflichtig" })
    .where(eq(users.id, empWithSoll.id));
  // empZeroSoll bleibt ohne Monatsstunden (null) ⇒ Tages-Soll 0.

  const customer = await createTestCustomer();
  customerId = customer.id as number;
  trackCleanup(async () => {
    try {
      const { apiPost } = await import("./test-utils");
      await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [customerId] });
    } catch { /* best-effort */ }
  });

  const servicesRes = await apiGet<any[]>("/api/services/all");
  hwServiceId = servicesRes.data.find((s: any) => s.code === "hauswirtschaft")!.id;

  // Ein abgeschlossener Termin mit Hauswirtschaft-Leistung ⇒ Baseline für die
  // gearbeiteten Service-Stunden (> 0), gegen die wir die Invarianz prüfen.
  const [appt] = await db
    .insert(appointments)
    .values({
      customerId,
      appointmentType: "kundentermin" as const,
      date: DATE,
      scheduledStart: "09:00",
      durationPromised: WORKED_MINUTES,
      status: "completed" as const,
      assignedEmployeeId: empWithSoll.id,
      performedByEmployeeId: empWithSoll.id,
    })
    .returning({ id: appointments.id });

  await db.insert(appointmentServices).values({
    appointmentId: appt.id,
    serviceId: hwServiceId,
    plannedDurationMinutes: WORKED_MINUTES,
    actualDurationMinutes: WORKED_MINUTES,
  });

  trackCleanup(async () => {
    try {
      await db.delete(appointments).where(eq(appointments.id, appt.id));
    } catch { /* best-effort, cascade räumt appointment_services */ }
  });
});

afterAll(async () => {
  try {
    await db.delete(employeeTimeEntries).where(eq(employeeTimeEntries.userId, empWithSoll.id));
    await db.delete(employeeTimeEntries).where(eq(employeeTimeEntries.userId, empZeroSoll.id));
  } catch { /* best-effort */ }
  await runCleanup();
});

describe("Urlaub/Krankheit-Stunden leaken nicht in die Arbeitsstunden (Task #1585)", () => {
  it("Service-Summen bleiben durch Abwesenheits-Einträge unverändert; urlaubHours/krankheitHours == Tage × dailySoll", async () => {
    const dailySoll = dailySollHours("sozialversicherungspflichtig", MONTHLY_WORK_HOURS);
    expect(dailySoll).toBeGreaterThan(0);

    // Baseline OHNE Abwesenheits-Einträge.
    const before = await getTimeOverview(empWithSoll.id, { year: YEAR, month: MONTH });
    expect(before.completedServiceHours!.hauswirtschaftMinutes).toBe(WORKED_MINUTES);
    expect(before.serviceHours.hauswirtschaftMinutes).toBe(WORKED_MINUTES);
    expect(before.timeEntries.urlaubHours).toBe(0);
    expect(before.timeEntries.krankheitHours).toBe(0);

    // Jetzt 2 Urlaubs- und 1 Kranken-Tag einfügen.
    await db.insert(employeeTimeEntries).values([
      { userId: empWithSoll.id, entryType: "urlaub" as const, entryDate: URLAUB_1, isFullDay: true },
      { userId: empWithSoll.id, entryType: "urlaub" as const, entryDate: URLAUB_2, isFullDay: true },
      { userId: empWithSoll.id, entryType: "krankheit" as const, entryDate: KRANK_1, isFullDay: true },
    ]);

    const after = await getTimeOverview(empWithSoll.id, { year: YEAR, month: MONTH });

    // 1) Abwesenheits-Stunden == Tage × dailySoll (SSoT-deckungsgleich).
    expect(after.timeEntries.urlaubDays).toBe(2);
    expect(after.timeEntries.krankheitDays).toBe(1);
    expect(after.timeEntries.urlaubHours).toBeCloseTo(2 * dailySoll, 2);
    expect(after.timeEntries.krankheitHours).toBeCloseTo(1 * dailySoll, 2);

    // 2) Die gearbeiteten Service-Summen sind IDENTISCH zur Baseline — die
    //    Abwesenheits-Stunden sind nirgends eingesickert.
    expect(after.serviceHours).toEqual(before.serviceHours);
    expect(after.completedServiceHours).toEqual(before.completedServiceHours);
    expect(after.plannedServiceHours).toEqual(before.plannedServiceHours);
    expect(after.completedServiceHours!.hauswirtschaftMinutes).toBe(WORKED_MINUTES);

    // Kein Service-Topf enthält die Abwesenheits-Minuten (10 h = 600 Min ≫ 90).
    const allServiceMinutes =
      after.serviceHours.hauswirtschaftMinutes +
      after.serviceHours.alltagsbegleitungMinutes +
      after.serviceHours.erstberatungMinutes;
    expect(allServiceMinutes).toBe(WORKED_MINUTES);
  });

  it("0 Monatsstunden ⇒ urlaubHours/krankheitHours == 0 (kein Crash)", async () => {
    expect(dailySollHours("sozialversicherungspflichtig", null)).toBe(0);

    await db.insert(employeeTimeEntries).values([
      { userId: empZeroSoll.id, entryType: "urlaub" as const, entryDate: URLAUB_1, isFullDay: true },
      { userId: empZeroSoll.id, entryType: "krankheit" as const, entryDate: KRANK_1, isFullDay: true },
    ]);

    const overview = await getTimeOverview(empZeroSoll.id, { year: YEAR, month: MONTH });

    // Tage werden gezählt, aber ohne Tages-Soll bleibt die Stunden-Ableitung 0.
    expect(overview.timeEntries.urlaubDays).toBe(1);
    expect(overview.timeEntries.krankheitDays).toBe(1);
    expect(overview.timeEntries.urlaubHours).toBe(0);
    expect(overview.timeEntries.krankheitHours).toBe(0);
  });
});
