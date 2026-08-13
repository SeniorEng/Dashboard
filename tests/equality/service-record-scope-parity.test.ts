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
 * Der Test fährt die vollständige Matrix aus Status × NULL-Kombinationen gegen
 * ECHTE Zeilen, weil dort die Fallen sitzen: `= NULL` ist in SQL nicht `false`,
 * sondern NULL, und NULL filtert im `WHERE` wie `false`. Zwei Fälle müssen auf
 * BEIDEN Seiten `false` ergeben — „kein Mitarbeiterbezug" und, seit der Weiche
 * vom 09.08.2026, „dokumentiert, aber nur zugewiesen statt geleistet".
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
/** appointmentId → erwarteter Zustand (Status entscheidet, welche Spalte zählt). */
const matrix = new Map<
  number,
  { status: string; assignedEmployeeId: number | null; performedByEmployeeId: number | null }
>();

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

  // Kalender-Anker: `heute + 30` kann auf ein Wochenende fallen, und die
  // Termin-Route lehnt Sa/So hart ab („Termine können nicht an Samstagen oder
  // Sonntagen erstellt werden"). Ohne den Roll war diese Datei an rund zwei von
  // sieben Tagen rot, ohne dass sich am Produktivcode etwas geändert hätte —
  // zuletzt am 13.08.2026 (Do), wo +30 auf Samstag, den 12.09.2026 fiel und die
  // GANZE Suite im `beforeAll` abbrach (CI-Shard 1, Required Check `tests`).
  //
  // Vorwärts rollen, nicht rückwärts: der Test braucht ein Datum in der Zukunft.
  const day = new Date();
  day.setDate(day.getDate() + 30);
  const dow = day.getDay();
  if (dow === 6) day.setDate(day.getDate() + 2);
  else if (dow === 0) day.setDate(day.getDate() + 1);
  const dateStr = ymd(day);

  // Angelegt über die Route (damit alle NOT-NULL-Spalten stimmen), Status und
  // die beiden Mitarbeiter-Spalten anschließend gezielt gesetzt: über die
  // Anwendung sind „beide NULL" und „nur performed_by" nach #1896 nicht mehr
  // herstellbar, geprüft werden müssen sie trotzdem — es gibt keinen DB-Zwang,
  // der sie ausschließt.
  //
  // Volle Matrix: sechs Spalten-Kombinationen MAL beide Status-Zweige. Der
  // Status entscheidet seit der Weiche vom 09.08.2026, welche der beiden
  // Spalten überhaupt zählt — eine Matrix ohne Status prüfte die halbe Regel.
  const combos: Array<{ status: string; assigned: number | null; performed: number | null }> = [];
  for (const status of ["completed", "scheduled"]) {
    combos.push(
      { status, assigned: null, performed: null },
      { status, assigned: null, performed: 0 },
      { status, assigned: 0, performed: null },
      { status, assigned: 0, performed: 0 },
      { status, assigned: 0, performed: 1 },
      { status, assigned: 1, performed: 1 },
    );
  }

  let slot = 0;
  for (const combo of combos) {
    const time = `${String(6 + Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 === 0 ? "00" : "30"}`;
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
      .set({ assignedEmployeeId, performedByEmployeeId, status: combo.status })
      .where(eq(appointments.id, res.data.id));
    matrix.set(res.data.id, { status: combo.status, assignedEmployeeId, performedByEmployeeId });
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
  it("liefert für jede Status-/NULL-Kombination dieselbe Menge", async () => {
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
    // Treffer für `mine`: completed(null,mine), completed(mine,mine),
    // scheduled(mine,null), scheduled(mine,mine), scheduled(mine,other).
    // NICHT dabei: completed(mine,other) — dokumentiert zählt nur der Erbringer.
    expect(fromPredicate.size).toBe(5);
  });

  it("schließt den Termin ohne jeden Mitarbeiterbezug auf BEIDEN Seiten aus", async () => {
    const orphanId = [...matrix.entries()].find(
      ([, v]) =>
        v.status === "completed" &&
        v.assignedEmployeeId === null &&
        v.performedByEmployeeId === null,
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

  it("DIVERGENZ dokumentiert: SQL rechnet den Termin dem Erbringer zu, nicht dem Zugewiesenen", async () => {
    // `assigned = mine`, `performed = other`, `completed` — vor der Weiche
    // hätte das flache `assigned OR performed` hier BEIDE geliefert und damit
    // dem bloß Zugewiesenen den Nachweis überlassen.
    const divergentId = [...matrix.entries()].find(
      ([, v]) =>
        v.status === "completed" &&
        v.assignedEmployeeId === mine.id &&
        v.performedByEmployeeId === other.id,
    )![0];

    const forMine = await appointmentsRepo
      .selectColumnsFrom({ id: appointments.id }, db)
      .where(and(eq(appointments.id, divergentId), employeeServiceRecordScopeCondition(mine.id)));
    const forOther = await appointmentsRepo
      .selectColumnsFrom({ id: appointments.id }, db)
      .where(and(eq(appointments.id, divergentId), employeeServiceRecordScopeCondition(other.id)));

    expect(forMine, "der bloß Zugewiesene darf den dokumentierten Termin NICHT bekommen").toEqual([]);
    expect(forOther.map((r) => r.id), "der Erbringer bekommt ihn").toEqual([divergentId]);
  });
});
