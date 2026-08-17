/**
 * Kundendeaktivierung: das Dokumentations-Gate ist übergehbar — mit Ausweis.
 *
 * ── Der Zustand vorher ──────────────────────────────────────────────────
 * `complete-deactivation` kannte vier Prüfungen. Drei davon konnte die
 * Geschäftsführung mit Begründung übergehen (Leistungsnachweis, Rechnung), eine
 * NICHT: „alle Termine dokumentiert" war hart, auch für den Superadmin.
 *
 * Das war die härteste Schranke im System — härter als „Rechnung fehlt",
 * obwohl das fachlich schwerer wiegt. Blieb ein undokumentierter Termin stehen
 * (verstorbene Kundin, ausgeschiedene Mitarbeiterin), liess sich der Kunde
 * dauerhaft nicht deaktivieren. Der einzige Ausweg wäre gewesen, den Termin
 * rückwirkend zu dokumentieren oder abzusagen — also die Akte hübsch zu machen,
 * damit ein Knopf funktioniert.
 *
 * ── Was hier geprüft wird ───────────────────────────────────────────────
 *  1. ohne Override bleibt das Gate hart (400, mit Zahl im Payload)
 *  2. die Readiness weist die Termine aus, die ein Override liegen liesse
 *  3. mit Override + Begründung geht die Deaktivierung durch
 *  4. der Audit-Eintrag nennt die konkreten Termin-IDs, nicht nur eine Zahl
 *  5. DIE ZUSAGE DES WARNTEXTS: der undokumentierte Termin bleibt danach
 *     bestehen und dokumentierbar — er verschwindet nicht
 *  6. … und er ist wirklich abrechenbar, nicht nur bündelbar
 *  7. ein No-Show blockiert gar nicht erst — er IST dokumentiert
 *
 * Punkt 5 ist der eigentliche Grund für diese Datei. Der Dialog verspricht
 * „bleiben bestehen und können weiterhin dokumentiert und abgerechnet werden".
 * Wäre das falsch, wäre die Warnung eine Beschwichtigung statt einer Auskunft.
 *
 * ── Gegenprobe, gefahren ────────────────────────────────────────────────
 * Gegen den Vorzustand sind 1 bis 4 ROT.
 *
 * Test 5 ist dort GRÜN, aber wertlos: weil Test 3 scheitert, wird der Kunde nie
 * deaktiviert, und 5 misst dann einen noch aktiven Kunden. Er trägt seine
 * Aussage also nur in dieser Reihenfolge und nur auf dem geänderten Stand —
 * das ist bewusst so, nur soll niemand seine grüne Farbe auf `main` für einen
 * Beleg halten.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { auditLog } from "@shared/schema";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
  deactivateTestEmployee,
} from "../test-utils";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Vergangener Werktag, bevorzugt im LAUFENDEN Monat (haelt das
 * Monatsabschluss-Gate draussen).
 *
 * Die erste Fassung suchte NUR im laufenden Monat und fiel sonst auf `heute`
 * zurueck. Am 1./2. eines Monats gibt es dort keinen Kandidaten, und faellt
 * dieser Tag selbst aufs Wochenende, lieferte der Fallback ein Wochenenddatum —
 * `canCreateAppointment` lehnt Wochenenden rollenunabhaengig ab, `beforeAll`
 * waere gestorben und ALLE Tests der Datei rot. Betroffen waeren rund sechs
 * Kalendertage in achtzehn Monaten; genau die Sorte Falle, vor der CLAUDE.md
 * unter „Test-Fallen" warnt.
 *
 * Jetzt: erst im laufenden Monat suchen, sonst weiter zurueckgehen. Ein
 * Werktag im Vormonat ist fuer diesen Test unproblematisch — er prueft das
 * Vertragsende-Gate, nicht den Monatsabschluss, und der Termin wird nie
 * dokumentiert.
 */
function pastWeekday(): Date {
  const now = new Date();
  const werktag = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;
  for (let i = 1; i <= 10; i++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - i);
    if (werktag(cand) && cand.getMonth() === now.getMonth()) return cand;
  }
  for (let i = 1; i <= 30; i++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - i);
    if (werktag(cand)) return cand;
  }
  throw new Error("Kein vergangener Werktag in 30 Tagen gefunden — unmoeglich.");
}

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let employeeId: number;
let hwServiceId: number;
let offenerTerminId: number;
let terminDatum: string;
const cleanupApptIds: number[] = [];

beforeAll(async () => {
  auth = await getAuthCookie();
  expect(auth.user.isSuperAdmin, "Der Test braucht einen Superadmin — nur er darf uebergehen").toBe(true);

  const services = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "Gate1" });
  employeeId = emp.id;
  const cust = await createTestCustomer({ nachname: `Gate1_${uniqueId()}` });
  customerId = cust.id as number;

  await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: employeeId,
    backupEmployeeId2: null,
  });

  const tag = pastWeekday();
  terminDatum = ymd(tag);

  const appt = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: terminDatum,
    scheduledStart: "11:00",
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId: auth.user.id,
    notes: `gate1-${uniqueId()}`,
  });
  expect(appt.status, JSON.stringify(appt.data)).toBe(201);
  offenerTerminId = appt.data.id;
  cleanupApptIds.push(offenerTerminId);

  // Vertragsende auf den Termintag: das Vertragsende-Gate ist damit erfuellt
  // (erreicht), der Termin liegt davor und bleibt undokumentiert.
  const start = new Date(terminDatum);
  start.setMonth(start.getMonth() - 2);
  const vertrag = await apiPost<any>(`/api/admin/customers/${customerId}/contract`, {
    contractStart: ymd(start),
    contractEnd: terminDatum,
  });
  if (vertrag.status === 409) {
    const patch = await apiPatch<any>(`/api/admin/customers/${customerId}/contract`, {
      contractEnd: terminDatum,
    });
    expect(patch.status, JSON.stringify(patch.data)).toBe(200);
  } else {
    expect([200, 201], JSON.stringify(vertrag.data)).toContain(vertrag.status);
  }
});

afterAll(async () => {
  for (const id of cleanupApptIds) { try { await apiDelete(`/api/appointments/${id}`); } catch { /* egal */ } }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("Kundendeaktivierung — Dokumentations-Gate uebergehbar mit Ausweis", () => {
  it("1 — ohne Override bleibt das Gate hart", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${customerId}/complete-deactivation`, {
      deactivationReason: "verstorben",
    });
    expect(res.status).toBe(400);
    expect(res.data.message).toContain("nicht dokumentiert");
    expect(res.data.undocumentedCount, "die Zahl gehoert in die Antwort, nicht nur in den Text").toBe(1);
  });

  it("2 — die Readiness weist aus, was ein Override liegen liesse", async () => {
    const res = await apiGet<any>(`/api/admin/customers/${customerId}/deactivation-readiness`);
    expect(res.status).toBe(200);
    expect(res.data.undocumentedCount).toBe(1);
    expect(res.data.undocumentedAppointments.map((a: any) => a.id)).toEqual([offenerTerminId]);

    const doku = res.data.checks.find((c: any) => c.key === "allDocumented");
    expect(doku.met).toBe(false);
    expect(doku.overridable, "genau das ist die Aenderung").toBe(true);

    // Das Vertragsende bleibt hart — sonst waere die Lockerung zu weit gegangen.
    const vertrag = res.data.checks.find((c: any) => c.key === "contractEndReached");
    expect(vertrag.overridable).toBe(false);
  });

  it("3 — mit Override und Begruendung geht die Deaktivierung durch", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${customerId}/complete-deactivation`, {
      deactivationReason: "verstorben",
      overrideBillingGates: true,
      overrideReason: "Kundin verstorben, Dokumentation nicht mehr nachzuholen.",
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.status).toBe("inaktiv");
  });

  it("4 — der Audit-Eintrag nennt die konkreten Termine", async () => {
    const eintraege = await db.select().from(auditLog).where(and(
      eq(auditLog.entityType, "customer"),
      eq(auditLog.entityId, customerId),
    ));
    const deakt = eintraege.find((e) => (e.metadata as any)?.action === "complete_deactivation");
    expect(deakt, "Deaktivierung muss im Audit stehen").toBeDefined();
    const meta = deakt!.metadata as any;
    expect(meta.override).toBe(true);
    expect(meta.skippedGates).toContain("allDocumented");
    // Die IDs, nicht nur die Zahl: die Spur soll sagen, WELCHE Leistung
    // unabgerechnet stehen blieb.
    expect(meta.undocumentedAppointmentIds).toEqual([offenerTerminId]);
    expect(meta.overrideReason).toContain("verstorben");
  });

  it("5 — der Termin bleibt bestehen und dokumentierbar (die Zusage des Warntexts)", async () => {
    const appt = await apiGet<any>(`/api/appointments/${offenerTerminId}`);
    expect(appt.status, "der Termin ist nach der Deaktivierung noch da").toBe(200);
    expect(appt.data.status).toBe("scheduled");

    // Und er laesst sich tatsaechlich noch dokumentieren — nicht nur lesen.
    // Waere das falsch, muesste der Dialog von Verlust sprechen statt von
    // „bleibt bestehen".
    const doku = await apiPost<any>(`/api/appointments/${offenerTerminId}/document`, {
      actualStart: "11:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "nachtraeglich" }],
      performedByEmployeeId: auth.user.id,
    });
    expect(doku.status, JSON.stringify(doku.data)).toBe(200);

    // Und er ist danach buendelbar — der Kundenstatus filtert ihn nicht weg.
    const d = new Date(terminDatum);
    const check = await apiGet<any>(
      `/api/service-records/check-period?customerId=${customerId}&year=${d.getFullYear()}&month=${d.getMonth() + 1}`,
    );
    expect(check.status).toBe(200);
    expect(check.data.uncoveredDocumentedCount, "buendelbar trotz inaktivem Kunden").toBeGreaterThan(0);
  });

  it("6 — und er ist wirklich ABRECHENBAR, nicht nur buendelbar", async () => {
    // Der Dialog verspricht „dokumentiert UND abgerechnet werden". Test 5
    // endete bei „buendelbar" — die zweite Haelfte der Zusage blieb ungeprueft.
    // Ein Regress an `eligible-customers` wuerde den Warntext falsch machen,
    // ohne dass ein Test rot wird.
    const d = new Date(terminDatum);
    const jahr = d.getFullYear();
    const monat = d.getMonth() + 1;

    const ln = await apiPost<any>("/api/service-records", {
      customerId, year: jahr, month: monat, employeeId: auth.user.id,
    });
    expect(ln.status, JSON.stringify(ln.data)).toBe(201);

    const eligible = await apiGet<any>(
      `/api/billing/eligible-customers?year=${jahr}&month=${monat}`,
    );
    expect(eligible.status).toBe(200);
    const liste = Array.isArray(eligible.data) ? eligible.data : (eligible.data.customers ?? []);
    expect(
      liste.map((c: any) => c.customerId ?? c.id),
      "der inaktive Kunde muss in der Abrechnungs-Kandidatenliste stehen",
    ).toContain(customerId);
  });

  it("7 — ein No-Show blockiert die Deaktivierung NICHT (er ist dokumentiert)", async () => {
    // Der eigentliche Defekt hinter dem Ticket: `status !== "completed"` zaehlte
    // `customer_no_show` als „noch nicht dokumentiert". Das ist ein TERMINALER,
    // vollstaendig dokumentierter Termin — beim Selbstzahler erzeugt er sogar
    // eine Ausfallrechnung.
    //
    // Gemessen an der Referenz-Kopie: von sieben Kunden mit erreichtem
    // Vertragsende und blockierender Pruefung waren ZWEI allein dadurch
    // blockiert, ohne einen einzigen echt offenen Termin. Fuer die braucht es
    // keinen Override, sondern das richtige Praedikat — sonst behauptete der
    // Audit-Eintrag liegengebliebene Leistung, die es nicht gibt.
    const cust2 = await createTestCustomer({ nachname: `Gate1NoShow_${uniqueId()}` });
    const id2 = cust2.id as number;
    await apiPatch(`/api/admin/customers/${id2}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: employeeId,
      backupEmployeeId2: null,
    });

    const appt = await apiPost<any>("/api/appointments/kundentermin", {
      customerId: id2,
      date: terminDatum,
      scheduledStart: "16:00",
      services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      assignedEmployeeId: auth.user.id,
      notes: `gate1-noshow-${uniqueId()}`,
    });
    expect(appt.status, JSON.stringify(appt.data)).toBe(201);
    cleanupApptIds.push(appt.data.id);

    const noShow = await apiPost<any>(`/api/appointments/${appt.data.id}/document-no-show`, {
      actualStart: "16:00",
      travelOriginType: "home",
      travelKilometers: 0,
      noShowReason: "nicht_angetroffen",
      noShowWaitMinutes: 10,
      performedByEmployeeId: auth.user.id,
    });
    expect(noShow.status, JSON.stringify(noShow.data)).toBe(200);

    const start = new Date(terminDatum);
    start.setMonth(start.getMonth() - 2);
    await apiPost(`/api/admin/customers/${id2}/contract`, {
      contractStart: ymd(start),
      contractEnd: terminDatum,
    });

    const readiness = await apiGet<any>(`/api/admin/customers/${id2}/deactivation-readiness`);
    const doku = readiness.data.checks.find((c: any) => c.key === "allDocumented");
    expect(doku.met, "ein No-Show IST dokumentiert").toBe(true);
    expect(readiness.data.undocumentedCount).toBe(0);

    // Und der Schreibpfad blockt nicht mehr wegen DOKUMENTATION. Er blockt
    // weiterhin am Leistungsnachweis — richtig so, ein No-Show erzeugt keinen,
    // und dieses Gate ist unveraendert (und uebergehbar). Geprueft wird
    // deshalb der GRUND, nicht der Statuscode: die Meldung darf nicht mehr
    // von undokumentierten Terminen sprechen.
    const deakt = await apiPost<any>(`/api/admin/customers/${id2}/complete-deactivation`, {
      deactivationReason: "verstorben",
    });
    expect(deakt.data.message ?? "").not.toContain("nicht dokumentiert");
    expect(deakt.data.undocumentedCount ?? 0).toBe(0);

    // Mit Override geht sie durch — und der Audit darf `allDocumented` NICHT
    // als uebersprungen fuehren, sonst behauptete die Spur liegengebliebene
    // Leistung, die es nicht gibt.
    const mitOverride = await apiPost<any>(`/api/admin/customers/${id2}/complete-deactivation`, {
      deactivationReason: "verstorben",
      overrideBillingGates: true,
      overrideReason: "Kundin verstorben, kein Leistungsnachweis mehr noetig.",
    });
    expect(mitOverride.status, JSON.stringify(mitOverride.data)).toBe(200);

    const spur = await db.select().from(auditLog).where(and(
      eq(auditLog.entityType, "customer"),
      eq(auditLog.entityId, id2),
    ));
    const eintrag = spur.find((e) => (e.metadata as any)?.action === "complete_deactivation");
    expect((eintrag!.metadata as any).skippedGates).not.toContain("allDocumented");
    expect((eintrag!.metadata as any).undocumentedAppointmentIds ?? []).toEqual([]);

    await cleanupCustomer(id2);
  });
});
