/**
 * Task #1758 — Leerfahrt-Anzeige: Wartezeit & Anfahrt-km müssen über den
 * normalen Lese-/API-Pfad zurückkommen.
 *
 * Regression gegen den Anzeige-Bug: Die Projektion
 * `appointmentWithCustomerSelectFields` (Basis von `getAppointmentWithCustomer`
 * → GET /api/appointments/:id, die Quelle der Termin-Detailkachel) selektierte
 * KEINE der `no_show_*`-Spalten. Der Mapper las `row.noShow*` → `undefined` →
 * `?? null`/`?? false`, sodass die API `noShowWaitMinutes: null` /
 * `noShowKilometers: null` lieferte und die Kachel „Wartezeit 0 / Anfahrt-km 0,00"
 * zeigte, obwohl die Werte korrekt gespeichert waren.
 *
 * Der Reopen-Round-Trip-Test (Task #1757) liest ausschließlich per direktem
 * DB-Select und hätte diesen reinen LESE-Projektions-Bug nie gesehen. Dieser
 * Test schließt die Lücke: dokumentieren → über die ECHTE Route laden → alle 7
 * `no_show_*`-Felder müssen ankommen.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import { appointments } from "@shared/schema";
import {
  apiGet,
  apiPost,
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  runCleanup,
  trackCleanup,
} from "../test-utils";

// Weit in der Zukunft, damit der Datensatz kein anderes Test-/Seed-Fenster
// kreuzt. Direkter DB-Insert → Wochenend-/Cutoff-Policies spielen keine Rolle.
const DATE = "2035-06-19"; // Dienstag, kein Wochenende/Feiertag.

let emp: { id: number };
let customerId: number;

beforeAll(async () => {
  await getAuthCookie();
  emp = await createTestEmployee({ nachnamePrefix: "NoShowRead" });

  const customer = await createTestCustomer();
  customerId = customer.id as number;
  trackCleanup(async () => {
    try {
      await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [customerId] });
    } catch {
      /* best-effort */
    }
  });
});

afterAll(async () => {
  await runCleanup();
});

async function insertScheduledAppointment(): Promise<number> {
  const [inserted] = await db
    .insert(appointments)
    .values({
      customerId,
      appointmentType: "kundentermin",
      date: DATE,
      scheduledStart: "09:00",
      scheduledEnd: "10:00",
      durationPromised: 60,
      status: "scheduled",
      assignedEmployeeId: emp.id,
    })
    .returning({ id: appointments.id });
  return inserted.id;
}

describe("Task #1758 — No-Show-Felder kommen über den Lese-/API-Pfad zurück", () => {
  it("GET /api/appointments/:id liefert Wartezeit, Anfahrt-km, Grund & Notizen (keine Suppression)", async () => {
    const appointmentId = await insertScheduledAppointment();

    const doc = await apiPost<any>(`/api/appointments/${appointmentId}/document-no-show`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 8,
      noShowReason: "sonstiges",
      noShowReasonText: "Tür nicht geöffnet",
      noShowWaitMinutes: 10,
      noShowNotes: "Nachbarin wusste nichts",
    });
    expect(doc.status).toBe(200);
    expect(doc.data.status).toBe("customer_no_show");

    // KRITISCH: der Lesepfad der Detailkachel, nicht ein roher DB-Select.
    const res = await apiGet<any>(`/api/appointments/${appointmentId}`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("customer_no_show");
    // Vor dem Fix waren diese beiden null → Kachel zeigte 0 / 0,00.
    expect(res.data.noShowWaitMinutes).toBe(10);
    expect(res.data.noShowKilometers).toBe(8);
    expect(res.data.noShowReason).toBe("sonstiges");
    expect(res.data.noShowReasonText).toBe("Tür nicht geöffnet");
    expect(res.data.noShowNotes).toBe("Nachbarin wusste nichts");
    expect(res.data.noShowChargeSuppressed).toBe(false);
    expect(res.data.noShowChargeSuppressionReason).toBeNull();
  });

  it("GET /api/appointments/:id liefert das Kulanz-/Suppression-Flag inkl. Begründung", async () => {
    const appointmentId = await insertScheduledAppointment();

    const doc = await apiPost<any>(`/api/appointments/${appointmentId}/document-no-show`, {
      actualStart: "09:00",
      travelOriginType: "home",
      travelKilometers: 3,
      noShowReason: "nicht_angetroffen",
      noShowWaitMinutes: 5,
      noShowChargeSuppressed: true,
      noShowChargeSuppressionReason: "Stammkunde, einmalige Kulanz",
    });
    expect(doc.status).toBe(200);

    const res = await apiGet<any>(`/api/appointments/${appointmentId}`);
    expect(res.status).toBe(200);
    expect(res.data.noShowWaitMinutes).toBe(5);
    expect(res.data.noShowKilometers).toBe(3);
    expect(res.data.noShowChargeSuppressed).toBe(true);
    expect(res.data.noShowChargeSuppressionReason).toBe("Stammkunde, einmalige Kulanz");
  });
});
