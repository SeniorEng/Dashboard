import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, auditLog, employeeMonthClosings } from "@shared/schema";
import { seriesBulkFloorDate } from "@shared/domain/appointments";
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
 * Replit-#1913 — Datums-Boden für Serien-Massenoperationen + Undo-Pfad.
 *
 * ── Der Defekt, in Produktion gemessen ──────────────────────────────────
 * `this_and_future` nahm als Stichtag das Datum des ANGEKLICKTEN Termins.
 * Lag der in der Vergangenheit, traf die Operation alle Termine ab jenem Tag —
 * also auch bereits geleistete. 13 Termine aus 3 Serien (1080 Minuten, rund
 * 684,00 €) wurden so abgesagt; danach waren sie weder dokumentierbar noch
 * abrechenbar noch sichtbar.
 *
 * Beim Verkürzen ist die Folge härter: dort werden die Termine nicht abgesagt,
 * sondern gelöscht.
 *
 * ── Was hier geprüft wird ───────────────────────────────────────────────
 *  1. Boden als reine Regel (Einheitentest der SSoT)
 *  2. Absage `this_and_future` auf einem vergangenen Termin lässt die
 *     Vergangenheit stehen und sagt nur die Zukunft ab
 *  3. Änderung `this_and_future` ebenso
 *  4. Verkürzen auf ein vergangenes Enddatum löscht keine geleisteten Termine
 *  5. Undo holt eine Absage zurück, mit Audit-Eintrag
 *  6. Undo verweigert einen Termin, der gar nicht abgesagt ist — als Fehler,
 *     nicht als stiller Teilerfolg
 *
 * Gegenprobe gegen den Vorzustand: 2, 3 und 4 müssen ohne den Boden ROT sein,
 * 5 und 6 mangels Route ebenfalls. Sonst messen sie nichts.
 */

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let employeeId: number;
let hwServiceId: number;
const cleanupSeriesIds: number[] = [];

const iso = (d: Date) => d.toISOString().split("T")[0];

function tagVersetzt(tage: number): string {
  const d = new Date();
  d.setDate(d.getDate() + tage);
  return iso(d);
}

/**
 * Legt eine Serie an und schiebt anschliessend die ersten `anzahlVergangen`
 * Termine per DB-Update in die Vergangenheit.
 *
 * Warum nicht gleich mit vergangenem Startdatum anlegen: die Create-Policy
 * lehnt weit zurueckliegende Termine ab, und der genaue Rand ist nicht das,
 * was hier geprueft wird. Der Umweg macht die Ausgangslage exakt und
 * unabhaengig von der Kalenderlage.
 */
// Eigene Uhrzeit je Serie. Alle Serien dieser Datei laufen auf DERSELBEN Kraft;
// mit gleicher Startzeit lehnt die Anlage ab dem zweiten Aufruf mit
// "Mitarbeiter-Terminueberschneidung" ab (CLAUDE.md, Test-Fallen).
let naechsteStunde = 7;

async function serieMitVergangenheit(anzahlVergangen: number) {
  const stunde = String(naechsteStunde++).padStart(2, "0");
  const start = new Date();
  start.setDate(start.getDate() + 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 35);

  const res = await apiPost<{ series: { id: number } }>("/api/appointment-series", {
    customerId,
    startDate: iso(start),
    endDate: iso(end),
    weekdays: ["mo", "mi", "fr"],
    frequency: "weekly",
    scheduledStart: `${stunde}:00`,
    durationMinutes: 60,
    services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    assignedEmployeeId: auth.user.id,
  });
  expect(res.status, `Serie anlegen: ${JSON.stringify(res.data)}`).toBe(201);
  const seriesId = res.data.series.id;
  cleanupSeriesIds.push(seriesId);

  const rows = await db.select().from(appointments)
    .where(eq(appointments.seriesId, seriesId))
    .orderBy(appointments.date);
  expect(rows.length).toBeGreaterThan(anzahlVergangen + 2);

  // Die ersten N in die Vergangenheit schieben — bewusst auf aufeinander
  // folgende Tage direkt vor heute, damit sie im SELBEN Monat wie heute liegen
  // (siehe Vorbedingung unten).
  const vergangene: Array<{ id: number; date: string }> = [];
  for (let i = 0; i < anzahlVergangen; i++) {
    const datum = tagVersetzt(-(anzahlVergangen - i));
    await db.update(appointments).set({ date: datum }).where(eq(appointments.id, rows[i].id));
    vergangene.push({ id: rows[i].id, date: datum });
  }
  const kuenftige = rows.slice(anzahlVergangen).map(r => ({ id: r.id, date: r.date }));

  return { seriesId, vergangene, kuenftige };
}

async function statusVon(id: number): Promise<string> {
  const [row] = await db.select({ s: appointments.status }).from(appointments)
    .where(and(eq(appointments.id, id), isNull(appointments.deletedAt)));
  return row?.s ?? "WEG";
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
  const emp = await createTestEmployee({ nachnamePrefix: "DatumsBoden" });
  employeeId = emp.id;
  const cust = await createTestCustomer({ nachname: `DatumsBoden_${Date.now()}` });
  customerId = cust.id as number;

  const zuweisung = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: employeeId,
    backupEmployeeId2: null,
  });
  expect(zuweisung.status).toBe(200);

  // VORBEDINGUNG, laut statt still: die Tests unten belegen den Boden damit,
  // dass vergangene Termine STEHEN BLEIBEN. Waere der laufende Monat fuer
  // diese Kraft geschlossen, blieben sie auch ohne Boden stehen — der
  // Monatsabschluss-Filter griffe vorher. Der Test wuerde dann gruen sein, ohne
  // irgendetwas zu messen, und auch auf dem Vorzustand nicht rot werden.
  const heute = new Date();
  const abschluss = await db.select().from(employeeMonthClosings).where(and(
    eq(employeeMonthClosings.userId, auth.user.id),
    eq(employeeMonthClosings.year, heute.getFullYear()),
    eq(employeeMonthClosings.month, heute.getMonth() + 1),
  ));
  const offen = abschluss.filter(a => !a.reopenedAt);
  expect(
    offen.length,
    "Der laufende Monat ist fuer den Testnutzer geschlossen — dann messen die " +
    "Boden-Tests den Monatsabschluss statt den Boden. Abschluss entfernen oder " +
    "Test auf einen anderen Nutzer legen.",
  ).toBe(0);
});

afterAll(async () => {
  for (const sid of cleanupSeriesIds) {
    const rows = await db.select({ id: appointments.id }).from(appointments).where(eq(appointments.seriesId, sid));
    for (const r of rows) { try { await apiDelete(`/api/appointments/${r.id}`); } catch { /* egal */ } }
    try { await apiDelete(`/api/appointment-series/${sid}`); } catch { /* egal */ }
  }

  const reste = await db.select({ id: appointments.id })
    .from(appointments)
    .where(and(inArray(appointments.seriesId, cleanupSeriesIds), isNull(appointments.deletedAt)));
  if (reste.length > 0) {
    throw new Error(
      `Cleanup unvollstaendig: ${reste.length} Termin(e) blieben in der geteilten Shard-DB liegen ` +
        `(IDs ${reste.map(r => r.id).join(", ")}). Das erzeugt Kontaminations-Flakes in anderen Dateien.`,
    );
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("Replit-#1913 — Datums-Boden fuer Serien-Massenoperationen", () => {
  it("1 — der Boden ist eine reine Regel: nie vor heute", () => {
    expect(seriesBulkFloorDate("2026-08-10", "2026-08-17")).toBe("2026-08-17");
    expect(seriesBulkFloorDate("2026-08-24", "2026-08-17")).toBe("2026-08-24");
    // Heute selbst bleibt heute — der angeklickte Termin von HEUTE ist gemeint.
    expect(seriesBulkFloorDate("2026-08-17", "2026-08-17")).toBe("2026-08-17");
  });

  it("2 — Absage 'dieser und alle folgenden' auf einem vergangenen Termin laesst die Vergangenheit stehen", async () => {
    const { seriesId, vergangene, kuenftige } = await serieMitVergangenheit(2);
    const anker = vergangene[0];

    const res = await apiPost<{ cancelled: number }>(
      `/api/appointment-series/${seriesId}/appointments/${anker.id}/cancel`,
      { mode: "this_and_future" },
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    // Der Kern: geleistete Arbeit bleibt unberuehrt — auch der ANGEKLICKTE.
    for (const v of vergangene) {
      expect(await statusVon(v.id), `vergangener Termin ${v.id} (${v.date})`).toBe("scheduled");
    }
    // Und die Zukunft wird trotzdem abgesagt — der Boden darf die Funktion
    // nicht ausschalten, nur begrenzen.
    expect(await statusVon(kuenftige[0].id)).toBe("cancelled");
    expect(res.data.cancelled).toBe(kuenftige.length);
  });

  it("3 — Aenderung 'dieser und alle folgenden' fasst vergangene Termine nicht an", async () => {
    const { seriesId, vergangene, kuenftige } = await serieMitVergangenheit(2);
    const anker = vergangene[0];

    const res = await apiPost<{ updated: number }>(
      `/api/appointment-series/${seriesId}/appointments/${anker.id}/update`,
      { mode: "this_and_future", scheduledStart: "19:00" },
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const [angefasst] = await db.select({ start: appointments.scheduledStart })
      .from(appointments).where(eq(appointments.id, vergangene[1].id));
    expect(angefasst.start, "vergangener Termin wurde umgelegt").not.toBe("19:00:00");

    const [kuenftig] = await db.select({ start: appointments.scheduledStart })
      .from(appointments).where(eq(appointments.id, kuenftige[0].id));
    expect(kuenftig.start).toBe("19:00:00");
  });

  it("4 — Verkuerzen auf ein vergangenes Enddatum loescht keine geleisteten Termine", async () => {
    const { seriesId, vergangene, kuenftige } = await serieMitVergangenheit(3);

    const res = await apiPost(`/api/appointment-series/${seriesId}/shorten`, {
      newEndDate: vergangene[0].date,
    });
    expect([200, 400]).toContain(res.status);

    // Ohne Boden waeren die beiden spaeteren vergangenen Termine GELOESCHT —
    // geleistete Arbeit, unwiederbringlich aus dem Kalender.
    for (const v of vergangene) {
      expect(await statusVon(v.id), `vergangener Termin ${v.id} (${v.date})`).not.toBe("WEG");
    }
    // Die Zukunft raeumt das Verkuerzen weiterhin ab.
    if (res.status === 200) {
      expect(await statusVon(kuenftige[kuenftige.length - 1].id)).toBe("WEG");
    }
  });
});

describe("Replit-#1913 — Undo: eine Absage zuruecknehmen", () => {
  it("5 — holt einen abgesagten Termin zurueck und schreibt einen Audit-Eintrag", async () => {
    const { seriesId, kuenftige } = await serieMitVergangenheit(0);
    const ziel = kuenftige[0];

    const absage = await apiPost(
      `/api/appointment-series/${seriesId}/appointments/${ziel.id}/cancel`,
      { mode: "single" },
    );
    expect(absage.status, JSON.stringify(absage.data)).toBe(200);
    expect(await statusVon(ziel.id)).toBe("cancelled");

    const undo = await apiPost<{ restored: number }>(`/api/appointments/${ziel.id}/restore`, {});
    expect(undo.status, JSON.stringify(undo.data)).toBe(200);
    expect(undo.data.restored).toBe(1);
    expect(await statusVon(ziel.id)).toBe("scheduled");

    const eintraege = await db.select().from(auditLog).where(and(
      eq(auditLog.entityType, "appointment"),
      eq(auditLog.entityId, ziel.id),
      eq(auditLog.action, "appointment_restored"),
    ));
    expect(eintraege.length, "GoBD-Spur: das Zurueckholen muss im Audit stehen").toBe(1);
  });

  it("6 — verweigert einen Termin, der gar nicht abgesagt ist, als Fehler", async () => {
    const { kuenftige } = await serieMitVergangenheit(0);
    const ziel = kuenftige[0];
    expect(await statusVon(ziel.id)).toBe("scheduled");

    const undo = await apiPost<{ code?: string; message?: string }>(
      `/api/appointments/${ziel.id}/restore`, {},
    );
    // Kein 200 mit `restored: 0` — das waere die stille Rueckmeldung, die
    // PR #100 im Absage-Pfad ausdruecklich beseitigt hat.
    expect(undo.status).toBe(409);
    expect(undo.data.code).toBe("APPOINTMENT_RESTORE_BLOCKED");
    expect(await statusVon(ziel.id)).toBe("scheduled");
  });
});
