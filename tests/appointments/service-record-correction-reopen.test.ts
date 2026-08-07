/**
 * Korrekturweg für einen unterschriebenen Leistungsnachweis:
 * `DELETE /api/service-records/:id` gibt jeden verknüpften Termin zur
 * Re-Dokumentation zurück.
 *
 * Vorher setzte die Route nur `status = 'documenting'` und ließ zwei Reste
 * stehen. Beide werden hier scharf geprüft — jeder Fall fällt, wenn der
 * jeweilige Schritt aus `reopenAppointmentForRedocumentation` verschwindet:
 *
 *   (a) Der korrigierte Termin gilt wieder als NICHT unterschrieben. Er darf
 *       weder über den LN (soft-gelöscht) noch über eine eigene `signature_data`
 *       als „unterschrieben" durchgehen — sonst wäre eine Aufwärts-Korrektur
 *       weiterhin durch einen alten Nachweis gedeckt.
 *   (b) Die Budget-Buchung ist zurückgedreht. Ohne den Reverse bucht der
 *       erneute Abschluss ZUSÄTZLICH — der Topf trüge alt + neu.
 *   (c) Eine System-Signatur aus dem Budget-Backfill (Task #876) wird geleert.
 *       Das ist die einzige Lage, in der ein Termin nach der Korrektur ohne
 *       jedes menschliche Zutun weiter als „unterschrieben" gälte — und
 *       `SIGNATURE_LOCKED` verhindert zusätzlich, dass sie je erneuert wird.
 *   (d) Im Verlauf DES TERMINS ist der Rücksprung `completed → documenting`
 *       sichtbar. Vorher stand die Korrektur nur am Nachweis.
 *   (e) Ist ein Termin abgerechnet, bleibt der Weg gesperrt (409) — auch beim
 *       blossen Entwurf. Dann gilt Storno first.
 *   (f) Der Weg bleibt mitarbeiter-initiierbar: der Eigentümer korrigiert
 *       seinen eigenen Nachweis, ein fremder Nicht-Admin nicht.
 *
 * Dokumentationsdaten (Ist-Zeiten, km, Leistungen) bleiben dabei erhalten —
 * genau sie sind die Grundlage der Korrektur. Auch das wird geprüft.
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import { appointments, auditLog, budgetTransactions, monthlyServiceRecords } from "@shared/schema";
import { and, eq, desc, sql } from "drizzle-orm";
import { appointmentDocumentedAndSignedCondition } from "../../server/lib/appointment-signed";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiDeleteAs,
  getAuthCookie,
  loginAs,
  uniqueId,
  createTestCustomer,
  cleanupCustomer,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let year: number;
let month: number;
const workdays: string[] = [];

const cleanupCustomerIds: number[] = [];
const cleanupApptIds: number[] = [];
const cleanupEmployeeIds: number[] = [];

async function newCustomer(tag: string): Promise<number> {
  const cust = await createTestCustomer({ nachname: `LNKORR-${tag}-${uniqueId()}` });
  const id = cust.id as number;
  cleanupCustomerIds.push(id);
  await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  return id;
}

async function createAndDocument(customerId: number, dateStr: string, time: string): Promise<number> {
  const createRes = await apiPost<any>("/api/appointments/kundentermin", {
    customerId,
    date: dateStr,
    scheduledStart: time,
    services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
    assignedEmployeeId: auth.user.id,
  });
  if (createRes.status !== 201) {
    throw new Error(`Termin-Anlage fehlgeschlagen: ${createRes.status} ${JSON.stringify(createRes.data)}`);
  }
  cleanupApptIds.push(createRes.data.id);
  const docRes = await apiPost<any>(`/api/appointments/${createRes.data.id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 4,
    customerKilometers: 2,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "LN-Korrektur-Test" }],
  });
  if (docRes.status !== 200) {
    throw new Error(`Dokumentation fehlgeschlagen: ${docRes.status} ${JSON.stringify(docRes.data)}`);
  }
  return createRes.data.id;
}

async function createSignedRecord(customerId: number, appointmentIds: number[]): Promise<number> {
  const res = await apiPost<any>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
    appointmentIds,
  });
  if (res.status !== 201) {
    throw new Error(`LN-Anlage fehlgeschlagen: ${res.status} ${JSON.stringify(res.data)}`);
  }
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<any>(`/api/service-records/${res.data.id}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
      signingLocation: "Vor Ort",
    });
    if (sig.status !== 200) {
      throw new Error(`Unterschrift (${signerType}) fehlgeschlagen: ${sig.status} ${JSON.stringify(sig.data)}`);
    }
  }
  return res.data.id;
}

/** Zählt der Termin nach der SSoT als „dokumentiert & unterschrieben"? */
async function countsAsSigned(appointmentId: number): Promise<boolean> {
  const rows = await db.select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), appointmentDocumentedAndSignedCondition()));
  return rows.length > 0;
}

async function apptRow(appointmentId: number) {
  const [row] = await db.select({
    status: appointments.status,
    signatureData: appointments.signatureData,
    signatureHash: appointments.signatureHash,
    signedAt: appointments.signedAt,
    signedByUserId: appointments.signedByUserId,
    actualStart: appointments.actualStart,
    travelKilometers: appointments.travelKilometers,
    customerKilometers: appointments.customerKilometers,
  }).from(appointments).where(eq(appointments.id, appointmentId));
  return row;
}

async function reopenAuditFor(appointmentId: number) {
  const rows = await db.select({ metadata: auditLog.metadata, action: auditLog.action })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, "appointment_reopened"),
      eq(auditLog.entityType, "appointment"),
      eq(auditLog.entityId, appointmentId),
    ))
    .orderBy(desc(auditLog.id));
  return rows;
}

/**
 * Budget-Lage des Termins. Ein Reverse ist eine GEGENBUCHUNG
 * (`transaction_type = 'reversal'`, positiver Betrag), kein Flag am Original —
 * geprüft wird deshalb die Netto-Summe und die Existenz der Gegenbuchung.
 */
async function budgetState(appointmentId: number): Promise<{ netCents: number; reversals: number; consumptions: number }> {
  const rows = await db.select({
    transactionType: budgetTransactions.transactionType,
    amountCents: budgetTransactions.amountCents,
  }).from(budgetTransactions).where(eq(budgetTransactions.appointmentId, appointmentId));
  return {
    netCents: rows.reduce((sum, r) => sum + r.amountCents, 0),
    reversals: rows.filter((r) => r.transactionType === "reversal").length,
    consumptions: rows.filter((r) => r.transactionType === "consumption").length,
  };
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;

  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  year = prev.getFullYear();
  month = prev.getMonth() + 1;
  for (let day = 2; day <= 28 && workdays.length < 12; day++) {
    const cur = new Date(year, month - 1, day);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) {
      workdays.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
});

afterAll(async () => {
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* bereits weg */ }
  }
  for (const id of cleanupCustomerIds) {
    await cleanupCustomer(id);
  }
  for (const id of cleanupEmployeeIds) {
    await deactivateTestEmployee(id);
  }
});

describe("LN-Korrekturweg — Termine kommen vollständig zur Re-Dokumentation zurück", () => {
  it("(a)(b)(d) korrigierter Termin gilt als unsigniert, Budget ist zurückgedreht, Termin-Audit entsteht", async () => {
    const customerId = await newCustomer("basis");
    const apptId = await createAndDocument(customerId, workdays[0], "09:00");
    const recordId = await createSignedRecord(customerId, [apptId]);

    // Ausgangslage: über den unterschriebenen LN gilt der Termin als signiert.
    expect(await countsAsSigned(apptId)).toBe(true);
    const budgetBefore = await budgetState(apptId);
    expect(budgetBefore.consumptions).toBeGreaterThanOrEqual(1);
    expect(budgetBefore.reversals).toBe(0);
    expect(budgetBefore.netCents).toBeLessThan(0);

    const del = await apiDelete(`/api/service-records/${recordId}`);
    expect(del.status).toBe(200);

    // (a) Weder LN noch Direkt-Signatur decken ihn noch.
    expect(await countsAsSigned(apptId)).toBe(false);
    const row = await apptRow(apptId);
    expect(row.status).toBe("documenting");
    expect(row.signatureData).toBeNull();
    expect(row.signatureHash).toBeNull();
    expect(row.signedAt).toBeNull();
    expect(row.signedByUserId).toBeNull();

    // (b) Budget zurückgedreht — sonst bucht der erneute Abschluss zusätzlich.
    const budgetAfter = await budgetState(apptId);
    expect(budgetAfter.reversals).toBe(budgetBefore.consumptions);
    expect(budgetAfter.netCents).toBe(0);

    // (d) Der Rücksprung ist im Verlauf DES TERMINS sichtbar.
    const audits = await reopenAuditFor(apptId);
    expect(audits.length).toBe(1);
    const meta = audits[0].metadata as any;
    expect(meta.reason).toBe("service_record_corrected");
    expect(meta.previousStatus).toBe("completed");
    expect(meta.serviceRecordId).toBe(recordId);
    expect(meta.reversedTransactions).toBeGreaterThanOrEqual(1);

    // Der LN selbst ist soft-gelöscht, nicht hart.
    const [rec] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, recordId));
    expect(rec.deletedAt).not.toBeNull();

    // Dokumentationsdaten unangetastet — Grundlage der Korrektur.
    expect(row.actualStart).not.toBeNull();
    expect(Number(row.travelKilometers)).toBe(4);
    expect(Number(row.customerKilometers)).toBe(2);
  });

  it("(c) System-Signatur aus dem Budget-Backfill wird geleert", async () => {
    const customerId = await newCustomer("backfill");
    const apptId = await createAndDocument(customerId, workdays[1], "10:00");
    const recordId = await createSignedRecord(customerId, [apptId]);

    // Backfill-Lage nachstellen: der Termin trägt zusätzlich eine
    // System-Signatur (Task #876, `markAppointmentSystemSigned`).
    await db.update(appointments)
      .set({
        signatureData: "SYSTEM-BACKFILL",
        signatureHash: "hash-backfill",
        signedAt: new Date(),
        signedByUserId: auth.user.id,
      })
      .where(eq(appointments.id, apptId));
    expect((await apptRow(apptId)).signatureData).toBe("SYSTEM-BACKFILL");

    const del = await apiDelete(`/api/service-records/${recordId}`);
    expect(del.status).toBe(200);

    // Ohne das Leeren bliebe der Termin „unterschrieben" — ohne Menschen.
    const row = await apptRow(apptId);
    expect(row.signatureData).toBeNull();
    expect(row.signatureHash).toBeNull();
    expect(row.signedAt).toBeNull();
    expect(row.signedByUserId).toBeNull();
    expect(await countsAsSigned(apptId)).toBe(false);

    const meta = (await reopenAuditFor(apptId))[0].metadata as any;
    expect(meta.hadSignature).toBe(true);
  });

  it("(e) abgerechneter Termin bleibt gesperrt — auch beim blossen Entwurf", async () => {
    const customerId = await newCustomer("rechnung");
    const apptId = await createAndDocument(customerId, workdays[2], "11:00");
    const recordId = await createSignedRecord(customerId, [apptId]);

    const gen = await apiPost<any>("/api/billing/generate", { customerId, billingYear: year, billingMonth: month });
    expect([200, 201]).toContain(gen.status);

    const del = await apiDelete(`/api/service-records/${recordId}`);
    expect(del.status).toBe(409);
    expect((del.data as any).error).toBe("INVOICED");

    // Nichts angefasst: Termin bleibt signiert, Budget bleibt gebucht, kein Audit.
    expect(await countsAsSigned(apptId)).toBe(true);
    expect((await apptRow(apptId)).status).toBe("completed");
    const budgetUntouched = await budgetState(apptId);
    expect(budgetUntouched.consumptions).toBeGreaterThanOrEqual(1);
    expect(budgetUntouched.reversals).toBe(0);
    expect(budgetUntouched.netCents).toBeLessThan(0);
    expect((await reopenAuditFor(apptId)).length).toBe(0);
  });

  it("(f) Eigentümer darf den eigenen Nachweis korrigieren, ein fremder Nicht-Admin nicht", async () => {
    const customerId = await newCustomer("zugriff");
    const apptId = await createAndDocument(customerId, workdays[3], "12:00");
    const recordId = await createSignedRecord(customerId, [apptId]);

    const stranger = await createTestEmployee({ nachnamePrefix: `Fremd-${uniqueId()}` });
    cleanupEmployeeIds.push(stranger.id);
    const strangerAuth = await loginAs(stranger.email, stranger.password);

    const denied = await apiDeleteAs(strangerAuth, `/api/service-records/${recordId}`);
    expect([403, 404]).toContain(denied.status);
    expect((await apptRow(apptId)).status).toBe("completed");

    // Der Eigentümer (hier zugleich Ersteller des LN) darf.
    const allowed = await apiDelete(`/api/service-records/${recordId}`);
    expect(allowed.status).toBe(200);
    expect((await apptRow(apptId)).status).toBe("documenting");
  });
});
