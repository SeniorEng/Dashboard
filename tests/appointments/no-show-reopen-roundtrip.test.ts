/**
 * Task #1757 — No-Show Korrektur-Pfad: Round-Trip über die ECHTEN Routen.
 *
 * Ein als "Kunde nicht angetroffen" (`status='customer_no_show'`) dokumentierter
 * Termin muss zur Korrektur (z. B. falsch erfasste Anfahrts-Kilometer)
 * wiedereröffnet und erneut als No-Show geschlossen werden können.
 *
 * KRITISCH — die eigentliche Absicherung dieses Tests:
 * Ein No-Show bucht KEINE Budget-Konsumzeilen (keine Hauswirtschaft, kein §45b).
 * Nach dem Reopen darf ein erneutes Schließen als No-Show ebenfalls KEINE
 * Konsumzeile anlegen und der Status muss `customer_no_show` bleiben — er darf
 * NICHT still zu einem regulären Leistungstermin (`completed`) werden, der
 * Hauswirtschaft + §45b buchen würde.
 *
 * Der Test fährt den vollen Pfad:
 *   1) document-no-show (km=12)          → customer_no_show, 0 Budget-Tx
 *   2) reopen                            → documenting
 *   3) document-no-show erneut (km=25)   → customer_no_show, km korrigiert, 0 Budget-Tx
 *
 * Würde der Reopen-/Re-Doku-Pfad je Konsum buchen oder den Status auf
 * `completed` kippen, wird dieser Test rot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments } from "@shared/schema";
import { budgetStorage } from "../../server/storage/budget-storage";
import {
  apiPost,
  createTestCustomer,
  createTestEmployee,
  getAuthCookie,
  runCleanup,
  trackCleanup,
} from "../test-utils";

// Weit in der Zukunft, damit der Datensatz kein anderes Test-/Seed-Fenster
// kreuzt. Direkter DB-Insert → Wochenend-/Cutoff-Policies spielen keine Rolle.
const YEAR = 2035;
const DATE = `${YEAR}-05-15`; // Dienstag, kein Wochenende/Feiertag.

const KM_FIRST = 12;
const KM_CORRECTED = 25;

let emp: { id: number };
let customerId: number;
let appointmentId = 0;

beforeAll(async () => {
  await getAuthCookie();
  emp = await createTestEmployee({ nachnamePrefix: "NoShowReopen" });

  const customer = await createTestCustomer();
  customerId = customer.id as number;
  trackCleanup(async () => {
    try {
      await apiPost(`/api/admin/test-cleanup/purge-customers`, { ids: [customerId] });
    } catch {
      /* best-effort */
    }
  });

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
  appointmentId = inserted.id;
});

afterAll(async () => {
  await runCleanup();
});

async function documentNoShow(km: number): Promise<{ status: number; data: any }> {
  return apiPost<any>(`/api/appointments/${appointmentId}/document-no-show`, {
    actualStart: "09:00",
    travelOriginType: "home",
    travelKilometers: km,
    noShowReason: "nicht_angetroffen",
    noShowWaitMinutes: 10,
  });
}

describe("Task #1757 — No-Show Korrektur-Pfad (Reopen → Re-Doku), Budget bleibt unberührt", () => {
  it("Erst-Dokumentation als No-Show bucht KEINE Budget-Konsumzeile", async () => {
    const res = await documentNoShow(KM_FIRST);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("customer_no_show");

    const [persisted] = await db
      .select({ status: appointments.status, noShowKilometers: appointments.noShowKilometers })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    expect(persisted.status).toBe("customer_no_show");
    expect(persisted.noShowKilometers).toBe(KM_FIRST);

    const txns = await budgetStorage.getTransactionsByAppointmentId(appointmentId);
    expect(txns.length).toBe(0);
  });

  it("Reopen setzt den No-Show zur Korrektur auf 'documenting' zurück", async () => {
    const res = await apiPost<any>(`/api/appointments/${appointmentId}/reopen`, {});
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("documenting");
  });

  it("Erneute No-Show-Doku korrigiert die km, bleibt No-Show und bucht weiterhin NICHTS", async () => {
    const res = await documentNoShow(KM_CORRECTED);
    expect(res.status).toBe(200);
    // KRITISCH: Status bleibt No-Show — kein stilles Kippen zu 'completed'.
    expect(res.data.status).toBe("customer_no_show");

    const [persisted] = await db
      .select({ status: appointments.status, noShowKilometers: appointments.noShowKilometers })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    expect(persisted.status).toBe("customer_no_show");
    // Die korrigierte Anfahrts-km ist persistiert (der eigentliche User-Fix).
    expect(persisted.noShowKilometers).toBe(KM_CORRECTED);

    // KRITISCH: Auch nach Reopen + Re-Doku existiert KEINE Budget-Konsumzeile.
    const txns = await budgetStorage.getTransactionsByAppointmentId(appointmentId);
    expect(txns.length).toBe(0);
  });
});
