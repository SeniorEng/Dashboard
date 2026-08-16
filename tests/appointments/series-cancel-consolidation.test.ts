import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, auditLog } from "@shared/schema";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
  deactivateTestEmployee,
  getAuthCookie,
} from "../test-utils";

/**
 * Absage-Konsolidierung: `single` und Bulk laufen über EINE Routine
 * (`server/services/appointment-cancellation.ts`), und eine begonnene
 * Dokumentation wird nicht mehr still vernichtet.
 *
 * ── Der Defekt, gemessen vor dem Fix ────────────────────────────────────
 * Ein Serien-Termin im Status `documenting` — Arbeit geleistet, Dokumentation
 * begonnen — wurde vom `single`-Zweig anstandslos storniert (HTTP 200), und
 * danach verweigerte `canDocumentAppointment` dauerhaft. Die Leistung war weder
 * dokumentierbar noch abrechenbar, ohne Widerspruch, ohne Audit-Eintrag, ohne
 * Budget-Rückabwicklung.
 *
 * Der `single`-Zweig prüfte als EINZIGE Schranke `status === "completed"`. Der
 * Bulk-Zweig prüfte zusätzlich Sperre und Monatsabschluss — aber ebenfalls kein
 * `documenting`, und rückabgewickelt hat keiner von beiden.
 *
 * ── Was hier geprüft wird ───────────────────────────────────────────────
 *  1. `documenting`-Absage OHNE Flag → 409, Termin unverändert
 *  2. mit Flag → ausgeführt, Audit-Eintrag vorhanden
 *  3. `single` prüft die Sperre (unterschriebener LN) wie der Bulk-Pfad
 *  4. `single` meldet eine Ablehnung als Fehler, nicht als stillen Teilerfolg
 *
 * Gegenprobe gegen `main`: 1, 2 und 4 müssen dort ROT sein — sonst messen sie
 * nichts. (3 ist auf `main` grün, weil `completed` den Fall ohnehin abfängt;
 * die Sperr-Lücke im `single`-Zweig war real, aber über `completed`
 * unerreichbar — deshalb steht sie hier als Regressionsschutz, nicht als
 * Defekt-Nachweis.)
 */

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let employeeId: number;
let hwServiceId: number;
const cleanupSeriesIds: number[] = [];

async function serieAnlegen(offsetTage: number) {
  const start = new Date();
  start.setDate(start.getDate() + offsetTage);
  const end = new Date(start);
  end.setDate(end.getDate() + 28);

  const res = await apiPost<{ series: { id: number } }>("/api/appointment-series", {
    customerId,
    startDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
    weekdays: ["mi"],
    frequency: "weekly",
    scheduledStart: "09:00",
    durationMinutes: 60,
    services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    assignedEmployeeId: auth.user.id,
  });
  expect(res.status, `Serie anlegen: ${JSON.stringify(res.data)}`).toBe(201);
  const seriesId = res.data.series.id;
  cleanupSeriesIds.push(seriesId);

  const rows = await db.select().from(appointments).where(eq(appointments.seriesId, seriesId));
  expect(rows.length).toBeGreaterThan(0);
  return { seriesId, termine: rows };
}

function absage(seriesId: number, appointmentId: number, body: Record<string, unknown>) {
  return apiPost<{ cancelled?: number; code?: string; details?: { appointments?: unknown[] }; message?: string }>(
    `/api/appointment-series/${seriesId}/appointments/${appointmentId}/cancel`,
    body,
  );
}

async function statusVon(id: number): Promise<string> {
  const [row] = await db.select({ s: appointments.status }).from(appointments).where(eq(appointments.id, id));
  return row?.s ?? "WEG";
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
  const emp = await createTestEmployee({ nachnamePrefix: "AbsageKons" });
  employeeId = emp.id;
  const cust = await createTestCustomer({ nachname: `AbsageKons_${Date.now()}` });
  customerId = cust.id as number;

  const zuweisung = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: employeeId,
    backupEmployeeId2: null,
  });
  expect(zuweisung.status).toBe(200);
});

afterAll(async () => {
  for (const sid of cleanupSeriesIds) {
    const rows = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.seriesId, sid));
    for (const r of rows) { try { await apiDelete(`/api/appointments/${r.id}`); } catch { /* egal */ } }
    try { await apiDelete(`/api/appointment-series/${sid}`); } catch { /* egal */ }
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("Absage-Konsolidierung — begonnene Dokumentation wird nicht still vernichtet", () => {
  it("1 — documenting-Absage OHNE Bestätigung wird verweigert und weist die Termine aus", async () => {
    const { seriesId, termine } = await serieAnlegen(30);
    const ziel = termine[0];
    await db.update(appointments)
      .set({ status: "documenting", actualStart: "09:00:00", actualEnd: "10:00:00" })
      .where(and(eq(appointments.id, ziel.id), eq(appointments.seriesId, seriesId)));

    const res = await absage(seriesId, ziel.id, { mode: "single" });

    expect(
      res.status,
      "Ohne Bestätigung muss die Absage einer begonnenen Dokumentation mit 409 verweigert werden. " +
        "Ein 200 hier heißt: die Doku wird wieder still vernichtet.",
    ).toBe(409);
    expect(res.data.code).toBe("CANCEL_DISCARDS_DOCUMENTATION");
    expect(
      res.data.details?.appointments,
      "Der 409 muss AUSWEISEN, welche Termine betroffen sind — sonst kann die UI " +
        "keine sinnvolle Rückfrage stellen und der Mitarbeiter sieht nur eine Blockade.",
    ).toHaveLength(1);

    expect(await statusVon(ziel.id), "Der Termin darf unverändert bleiben").toBe("documenting");
  });

  it("2 — mit Bestätigung wird ausgeführt, mit Audit-Eintrag", async () => {
    const { seriesId, termine } = await serieAnlegen(60);
    const ziel = termine[0];
    await db.update(appointments)
      .set({ status: "documenting", actualStart: "09:00:00", actualEnd: "10:00:00" })
      .where(eq(appointments.id, ziel.id));

    const res = await absage(seriesId, ziel.id, { mode: "single", confirmDiscardDocumentation: true });
    expect(res.status).toBe(200);
    expect(res.data.cancelled).toBe(1);
    expect(await statusVon(ziel.id)).toBe("cancelled");

    const audit = await db.select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "appointment_cancelled"), eq(auditLog.entityId, ziel.id)));
    expect(
      audit.length,
      "Die Absage muss eine Spur hinterlassen. Ohne Audit-Eintrag ist der Verlust " +
        "der Dokumentation nachträglich nicht mehr nachvollziehbar (GoBD).",
    ).toBeGreaterThan(0);
  });

  it("3 — single prüft die LN-Sperre wie der Bulk-Pfad", async () => {
    const { seriesId, termine } = await serieAnlegen(90);
    const ziel = termine[0];
    await db.update(appointments).set({ status: "completed" }).where(eq(appointments.id, ziel.id));

    const res = await absage(seriesId, ziel.id, { mode: "single" });
    expect(res.status, "Storno-first: abgeschlossene Termine bleiben gesperrt").toBe(400);
    expect(await statusVon(ziel.id)).toBe("completed");
  });

  it("4 — eine abgelehnte single-Absage meldet einen Fehler, keinen stillen Teilerfolg", async () => {
    const { seriesId, termine } = await serieAnlegen(120);
    const ziel = termine[0];
    await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, ziel.id));

    const res = await absage(seriesId, ziel.id, { mode: "single" });
    expect(
      res.status,
      "Bei `single` geht es um GENAU EINEN Termin. Eine Ablehnung als 200 mit " +
        "`cancelled: 0` zu melden wäre dieselbe Klasse stiller Meldung, die dieser " +
        "PR beseitigt — der Aufrufer glaubte an Erfolg, obwohl nichts geschah.",
    ).toBe(400);
  });
});
