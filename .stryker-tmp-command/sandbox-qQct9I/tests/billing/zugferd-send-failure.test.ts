// @ts-nocheck
import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #559 — Send-Pfad bricht bei ZUGFeRD-Einbettungsfehler sauber ab.
 *
 * Verifiziert end-to-end gegen POST /api/billing/:id/send, dass ein
 * ZUGFeRD-Embedding-Fehler (im Strict-Mode) zu einem sauberen Abbruch führt:
 *   1. HTTP 500
 *   2. Rechnungs-Status bleibt "entwurf" (kein "versendet")
 *   3. Audit-Log-Eintrag `invoice_zugferd_embed_failed` mit Reason-Text wird
 *      geschrieben
 *
 * Fault-Injection: Der Header `x-test-inject-fault: zugferd_embed` wird über
 * `readTestFaults(req)` an `embedZugferdXml` durchgereicht und löst dort
 * im Strict-Mode einen `ZugferdEmbedError` aus (nur in NODE_ENV=test aktiv).
 * Damit testen wir den vollen Send-Pfad inkl. Audit-Wrapper und Status-Update,
 * ohne echte Library-Internals zu mocken.
 *
 * Task #554 sichert die Library-Ebene (embedZugferdXml) ab; dieser Test
 * deckt die fehlende Lücke zwischen Library und HTTP-Endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable, auditLog, documentDeliveries } from "../../shared/schema";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  apiPut,
  getAuthCookie,
  uniqueId,
} from "../test-utils";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let insuranceProviderId: number;
const cleanupCustomerIds: number[] = [];
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shiftToWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}
const SEED_TIMES = ["00:00", "00:30", "01:00", "01:30", "02:00", "02:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30"];

async function findFreeSlotAndCreate(customerId: number, tag: string): Promise<{ id: number; date: string; time: string }> {
  for (let offset = 1; offset <= 60; offset++) {
    const cand = new Date();
    cand.setDate(cand.getDate() - offset);
    shiftToWeekday(cand);
    const dateStr = ymd(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `T559-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("findFreeSlotAndCreate(T559): kein freier Slot");
}

async function sendWithFault(invoiceId: number, fault: string | null): Promise<{ status: number; data: any }> {
  const a = await getAuthCookie();
  const cookieHeader = `${a.cookie}; careconnect_csrf=${a.csrfToken}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookieHeader,
    "x-csrf-token": a.csrfToken,
  };
  if (fault) headers["x-test-inject-fault"] = fault;
  const response = await fetch(`${BASE_URL}/api/billing/${invoiceId}/send`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
  const provRes = await apiGet<any[]>("/api/admin/insurance-providers");
  if (provRes.status !== 200 || provRes.data.length === 0) {
    throw new Error("Keine Versicherer in der Test-DB vorhanden");
  }
  insuranceProviderId = provRes.data[0].id;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch {}
  }
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  for (const id of cleanupCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch {}
  }
});

describe("Task #559 — Send-Pfad bricht bei ZUGFeRD-Fehler sauber ab", () => {
  it("HTTP 500, Status bleibt entwurf, Audit-Eintrag wird geschrieben", async () => {
    // 1. PV-Kunden anlegen (pflegekasse_privat → sendet an Kunde via E-Mail,
    //    daher braucht der Kunde eine E-Mail-Adresse).
    const custPayload = {
      vorname: "T559-PV",
      nachname: `Privat-T559-${uniqueId()}`,
      geburtsdatum: "1940-05-12",
      email: `t559-${uniqueId()}@test.local`,
      strasse: "Teststraße",
      nr: "5",
      plz: "10117",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_privat",
      acceptsPrivatePayment: true,
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
      contacts: [
        {
          contactType: "familie",
          isPrimary: true,
          vorname: "Kontakt",
          nachname: "T559",
          mobilnummer: "+4917600000559",
        },
      ],
      budgets: {
        entlastungsbetrag45b: 13100,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2024-01-01",
      },
    };
    const createRes = await apiPost<any>("/api/admin/customers", custPayload);
    expect(createRes.status, `customer create: ${JSON.stringify(createRes.data)}`).toBe(201);
    const customerId = createRes.data.id as number;
    cleanupCustomerIds.push(customerId);
    await apiPatch<any>(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: auth.user.id,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });

    // 2. Termin anlegen + dokumentieren + LN signieren.
    const slot = await findFreeSlotAndCreate(customerId, "ZFS");
    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "T559" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const d = new Date(slot.date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const srRes = await apiPost<any>("/api/service-records", {
      customerId,
      employeeId: auth.user.id,
      year,
      month,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost<any>(`/api/service-records/${srRes.data.id}/sign`, {
        signerType,
        signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    // 3. Rechnung erzeugen → PV-Kassenrechnung (billingType=pflegekasse_privat).
    const gen = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
    const invoices: any[] = gen.data?.splitInvoices ? gen.data.invoices : Array.isArray(gen.data) ? gen.data : [gen.data];
    for (const inv of invoices) cleanupInvoiceIds.push(inv.id);
    const pvInvoice = invoices.find((i) => i.billingType === "pflegekasse_privat");
    expect(pvInvoice?.id, "PV-Kassenrechnung muss vorhanden sein").toBeDefined();
    const invoiceId = pvInvoice.id as number;

    // 4. Vorab-Audit-Count festhalten — der Send-Aufruf soll danach genau
    //    einen neuen `invoice_zugferd_embed_failed`-Eintrag hinzufügen.
    const beforeAuditRows = await db.select({ id: auditLog.id })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_zugferd_embed_failed"),
        eq(auditLog.entityType, "invoice"),
        eq(auditLog.entityId, invoiceId),
      ));
    const beforeAuditCount = beforeAuditRows.length;

    // 5. Send mit Fault → muss 500 liefern und KEINE Statusänderung
    //    auf "versendet" durchführen.
    const sendRes = await sendWithFault(invoiceId, "zugferd_embed");
    expect(
      sendRes.status,
      `Send mit ZUGFeRD-Fault muss 500 liefern, got ${sendRes.status} ${JSON.stringify(sendRes.data)}`,
    ).toBe(500);

    // Fehlermeldung muss explizit auf ZUGFeRD-Einbettung hinweisen, damit
    // der Admin im UI weiß, warum die Rechnung NICHT versendet wurde.
    const errMsg = String(sendRes.data?.message || sendRes.data?.error || "");
    expect(errMsg, `Fehlermeldung muss ZUGFeRD-Bezug haben: "${errMsg}"`)
      .toMatch(/ZUGFeRD/i);

    // 6. Rechnungs-Status muss weiterhin "entwurf" sein (kein Versand committet).
    const [invAfter] = await db.select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    expect(
      invAfter?.status,
      `Rechnungs-Status darf nach ZUGFeRD-Fehler nicht auf "versendet" wechseln`,
    ).toBe("entwurf");

    // 7. Audit-Log enthält exakt einen neuen Eintrag mit Reason-Text.
    const afterAuditRows = await db.select({
      id: auditLog.id,
      metadata: auditLog.metadata,
    })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_zugferd_embed_failed"),
        eq(auditLog.entityType, "invoice"),
        eq(auditLog.entityId, invoiceId),
      ));
    expect(
      afterAuditRows.length - beforeAuditCount,
      "Genau ein neuer invoice_zugferd_embed_failed-Audit-Eintrag muss geschrieben sein",
    ).toBe(1);
    const newRow = afterAuditRows[afterAuditRows.length - 1];
    const metadata = (newRow.metadata as Record<string, unknown> | null) || {};
    expect(
      String(metadata.reason || ""),
      "Audit-Metadata muss Reason-Text der ZUGFeRD-Fehlermeldung enthalten",
    ).toMatch(/Test fault injected|zugferd_embed/i);
    expect(metadata.invoiceNumber, "Audit-Metadata muss invoiceNumber enthalten").toBeTruthy();

    // 8. KEIN document_deliveries-Eintrag darf für diesen Kunden existieren —
    //    der fehlgeschlagene Send wird vor dem sendEmail-Aufruf abgebrochen,
    //    sodass weder ein "sent"- noch ein "error"-Delivery-Record entsteht.
    //    Damit ist regressionssicher, dass eine ZUGFeRD-fehlerhafte Rechnung
    //    nicht versehentlich als "versendet" im Postausgang protokolliert wird.
    const deliveryRows = await db.select({ id: documentDeliveries.id, status: documentDeliveries.status })
      .from(documentDeliveries)
      .where(eq(documentDeliveries.customerId, customerId));
    expect(
      deliveryRows.length,
      `Kein document_deliveries-Eintrag erlaubt — got ${JSON.stringify(deliveryRows)}`,
    ).toBe(0);
  }, 90_000);
});
