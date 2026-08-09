/**
 * Task #1896 — Equality: SQL-Bedingung und reines TS-Prädikat entscheiden
 * dieselbe Frage identisch.
 *
 * `appointmentBelongsToEmployeeScope` (shared/domain/service-record-scope.ts)
 * ist die SSoT für „gehört dieser Termin dem Mitarbeiter?";
 * `employeeServiceRecordScopeCondition` (server/lib/service-record-scope.ts)
 * ist ihr SQL-Spiegel. Der Spiegel wird in JEDEM Leser des
 * Leistungsnachweis-Umfangs benutzt, das Prädikat im Anlege-Guard des
 * Einzel-Nachweises — drifteten sie auseinander, dürfte man einen Termin
 * anlegen, den man anschließend nicht mehr sieht (oder umgekehrt).
 *
 * Der Test fährt die vollständige NULL-Matrix gegen ECHTE Zeilen, weil genau
 * dort die Fallen sitzen: `= NULL` ist in SQL nicht `false`, sondern NULL, und
 * `NULL OR NULL` filtert wie `false`. Der Fall „beide Spalten NULL" (kein
 * Mitarbeiterbezug) muss auf BEIDEN Seiten `false` ergeben.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments } from "@shared/schema";
import { appointmentsRepo } from "../../server/repos";
import { employeeServiceRecordScopeCondition } from "../../server/lib/service-record-scope";
import { appointmentBelongsToEmployeeScope } from "@shared/domain/service-record-scope";
import {
  apiPost,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
} from "../test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let customerId: number;
let mine: { id: number };
let other: { id: number };
let hwServiceId: number;
/** appointmentId → erwarteter Zustand der beiden Spalten. */
const matrix = new Map<number, { assignedEmployeeId: number | null; performedByEmployeeId: number | null }>();

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

beforeAll(async () => {
  const admin = await getAuthCookie();
  const svcRes = await fetch(`${BASE_URL}/api/services/all`, { headers: { Cookie: admin.cookie } });
  const svcJson = (await svcRes.json()) as any[];
  hwServiceId = svcJson.find((s) => s.code === "hauswirtschaft")!.id;

  mine = await createTestEmployee({ nachnamePrefix: "T1896_Parity_Mine" });
  other = await createTestEmployee({ nachnamePrefix: "T1896_Parity_Other" });

  const cust = await createTestCustomer({ nachname: `Privat-T1896P-${uniqueId()}` });
  customerId = cust.id as number;

  const day = new Date();
  day.setDate(day.getDate() + 30);
  const dateStr = ymd(day);

  // Fünf Zeilen — die vollständige Matrix. Angelegt über die Route (damit alle
  // NOT-NULL-Spalten stimmen), die beiden Mitarbeiter-Spalten anschließend
  // gezielt gesetzt: über die Anwendung sind „beide NULL" und „nur
  // performed_by" nach #1896 nicht mehr herstellbar, geprüft werden müssen sie
  // trotzdem — es gibt keinen DB-Zwang, der sie ausschließt.
  const combos: Array<{ assigned: number | null; performed: number | null }> = [
    { assigned: null, performed: null },
    { assigned: null, performed: 0 },
    { assigned: 0, performed: null },
    { assigned: 0, performed: 0 },
    { assigned: 0, performed: 1 },
    { assigned: 1, performed: 1 },
  ];

  let slot = 0;
  for (const combo of combos) {
    const time = `${String(7 + slot).padStart(2, "0")}:00`;
    slot++;
    const res = await apiPost<any>("/api/appointments/kundentermin", {
      customerId,
      date: dateStr,
      scheduledStart: time,
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: mine.id,
      notes: `T1896-parity-${uniqueId()}`,
    });
    if (res.status !== 201) {
      throw new Error(`appointment failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
    const resolve = (v: number | null) => (v === null ? null : v === 0 ? mine.id : other.id);
    const assignedEmployeeId = resolve(combo.assigned);
    const performedByEmployeeId = resolve(combo.performed);
    await db
      .update(appointments)
      .set({ assignedEmployeeId, performedByEmployeeId })
      .where(eq(appointments.id, res.data.id));
    matrix.set(res.data.id, { assignedEmployeeId, performedByEmployeeId });
  }
});

afterAll(async () => {
  const ids = [...matrix.keys()];
  if (ids.length > 0) {
    await db.delete(appointments).where(inArray(appointments.id, ids));
  }
  await cleanupCustomer(customerId);
});

describe("Equality — Umfangs-Prädikat vs. SQL-Spiegel (Task #1896)", () => {
  it("liefert für jede NULL-Kombination dieselbe Menge", async () => {
    const ids = [...matrix.keys()];

    const sqlRows = await appointmentsRepo
      .selectColumnsFrom({ id: appointments.id }, db)
      .where(and(inArray(appointments.id, ids), employeeServiceRecordScopeCondition(mine.id)));
    const fromSql = new Set(sqlRows.map((r) => r.id));

    const fromPredicate = new Set(
      ids.filter((id) => appointmentBelongsToEmployeeScope(matrix.get(id)!, mine.id)),
    );

    expect([...fromSql].sort((a, b) => a - b)).toEqual([...fromPredicate].sort((a, b) => a - b));

    // Gegenprobe, damit ein „beide leer" nicht als Übereinstimmung durchgeht.
    expect(fromPredicate.size).toBe(4);
  });

  it("schließt den Termin ohne jeden Mitarbeiterbezug auf BEIDEN Seiten aus", async () => {
    const orphanId = [...matrix.entries()].find(
      ([, v]) => v.assignedEmployeeId === null && v.performedByEmployeeId === null,
    )![0];

    expect(appointmentBelongsToEmployeeScope(matrix.get(orphanId)!, mine.id)).toBe(false);
    expect(appointmentBelongsToEmployeeScope(matrix.get(orphanId)!, other.id)).toBe(false);

    for (const employeeId of [mine.id, other.id]) {
      const rows = await appointmentsRepo
        .selectColumnsFrom({ id: appointments.id }, db)
        .where(and(eq(appointments.id, orphanId), employeeServiceRecordScopeCondition(employeeId)));
      expect(rows, `Termin ohne Mitarbeiterbezug darf für ${employeeId} nicht sichtbar sein`).toEqual([]);
    }
  });
});
