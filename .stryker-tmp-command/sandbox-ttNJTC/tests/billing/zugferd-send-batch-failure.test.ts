// @ts-nocheck
import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #560 — Batch-Send-Pfad behandelt ZUGFeRD-Einbettungsfehler pro Item.
 *
 * Ergänzt Task #559 (Single-Send) um den Batch-Endpoint
 * POST /api/billing/send-batch. Der Batch verwendet dieselbe
 * `loadOrRenderSendablePdfs({ strictZugferd: true, testFaults })`-Pipeline,
 * hat aber eine eigene Pro-Item-Schleife mit Result-Format
 * `{ status: "error", error: ... }` statt HTTP 500.
 *
 * Regressionssicher abgesichert wird:
 *   1. Eine ZUGFeRD-fehlerhafte Rechnung blockiert nicht die anderen Items
 *      im Batch — die Schleife läuft weiter und liefert pro Item ein Result.
 *   2. KEINE der Rechnungen wechselt fälschlich auf "versendet".
 *   3. Für jede fehlerhafte Rechnung wird ein `invoice_zugferd_embed_failed`-
 *      Audit-Eintrag mit `batchSend=true` geschrieben.
 *   4. Es entsteht kein `document_deliveries`-Eintrag — der Send wird vor
 *      dem sendEmail-Aufruf abgebrochen.
 *
 * Fault-Injection: Der Header `x-test-inject-fault: zugferd_embed` wirkt
 * request-weit, sodass im Batch alle PV-Rechnungen im Strict-Pfad fehlschlagen.
 * Die Task-Akzeptanzkriterien erlauben explizit, dass beide Rechnungen sauber
 * abgewiesen werden — entscheidend ist, dass die Schleife pro Item korrekt
 * abbricht und Audit/Status konsistent bleiben.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray, asc } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable, auditLog, documentDeliveries } from "../../shared/schema";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
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
        notes: `T560-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("findFreeSlotAndCreate(T560): kein freier Slot");
}

async function sendBatchWithFault(invoiceIds: number[], fault: string | null): Promise<{ status: number; data: any }> {
  const a = await getAuthCookie();
  const cookieHeader = `${a.cookie}; careconnect_csrf=${a.csrfToken}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookieHeader,
    "x-csrf-token": a.csrfToken,
  };
  if (fault) headers["x-test-inject-fault"] = fault;
  const response = await fetch(`${BASE_URL}/api/billing/send-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ invoiceIds }),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function createPvInvoice(tag: string): Promise<{ customerId: number; invoiceId: number }> {
  const custPayload = {
    vorname: "T560-PV",
    nachname: `Privat-T560-${tag}-${uniqueId()}`,
    geburtsdatum: "1940-05-12",
    email: `t560-${tag}-${uniqueId()}@test.local`,
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
        nachname: "T560",
        mobilnummer: "+4917600000560",
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

  const slot = await findFreeSlotAndCreate(customerId, tag);
  const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
    actualStart: slot.time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: `T560-${tag}` }],
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

  const gen = await apiPost<any>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const generated: any[] = gen.data?.splitInvoices ? gen.data.invoices : Array.isArray(gen.data) ? gen.data : [gen.data];
  for (const inv of generated) cleanupInvoiceIds.push(inv.id);
  const pvInvoice = generated.find((i) => i.billingType === "pflegekasse_privat");
  expect(pvInvoice?.id, `PV-Kassenrechnung muss vorhanden sein (${tag})`).toBeDefined();
  return { customerId, invoiceId: pvInvoice.id as number };
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

describe("Task #560 — Batch-Send bricht pro Item bei ZUGFeRD-Fehler sauber ab", () => {
  it("Pro-Item-Error, kein Versand committet, Audit-Einträge mit batchSend=true", async () => {
    // 1. Zwei unabhängige PV-Rechnungen anlegen.
    const a = await createPvInvoice("A");
    const b = await createPvInvoice("B");
    const invoiceIds = [a.invoiceId, b.invoiceId];

    // 2. Vorab-Audit-Counts pro Rechnung festhalten.
    const beforeAuditRows = await db.select({ id: auditLog.id, entityId: auditLog.entityId })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_zugferd_embed_failed"),
        eq(auditLog.entityType, "invoice"),
        inArray(auditLog.entityId, invoiceIds),
      ))
      .orderBy(asc(auditLog.id));
    const beforeCountByInvoice = new Map<number, number>();
    for (const inv of invoiceIds) beforeCountByInvoice.set(inv, 0);
    for (const row of beforeAuditRows) {
      beforeCountByInvoice.set(row.entityId!, (beforeCountByInvoice.get(row.entityId!) || 0) + 1);
    }

    // 3. Batch-Send mit injizierter ZUGFeRD-Embedding-Fault.
    const sendRes = await sendBatchWithFault(invoiceIds, "zugferd_embed");
    expect(
      sendRes.status,
      `Batch-Send muss 200 liefern (Pro-Item-Errors im Body), got ${sendRes.status} ${JSON.stringify(sendRes.data)}`,
    ).toBe(200);

    // 4. Result-Array enthält für JEDE Rechnung ein Item, beide mit
    //    status="error" und expliziter ZUGFeRD-Fehlermeldung. Die Schleife
    //    darf nicht nach dem ersten Fault abbrechen.
    const results = Array.isArray(sendRes.data) ? sendRes.data : sendRes.data?.results;
    expect(Array.isArray(results), `Result muss Array sein: ${JSON.stringify(sendRes.data)}`).toBe(true);
    expect(results.length, `Genau ${invoiceIds.length} Results erwartet`).toBe(invoiceIds.length);
    for (const invoiceId of invoiceIds) {
      const r = results.find((x: any) => x.invoiceId === invoiceId);
      expect(r, `Result für Rechnung ${invoiceId} fehlt`).toBeDefined();
      expect(r.status, `Rechnung ${invoiceId} muss status="error" haben`).toBe("error");
      expect(
        String(r.error || ""),
        `Fehlermeldung für Rechnung ${invoiceId} muss ZUGFeRD-Bezug haben: "${r.error}"`,
      ).toMatch(/ZUGFeRD/i);
    }

    // 5. KEINE der Rechnungen darf auf "versendet" gewechselt sein.
    const invAfter = await db.select({ id: invoicesTable.id, status: invoicesTable.status })
      .from(invoicesTable)
      .where(inArray(invoicesTable.id, invoiceIds));
    for (const row of invAfter) {
      expect(
        row.status,
        `Rechnung ${row.id} darf nach ZUGFeRD-Fehler nicht auf "versendet" wechseln`,
      ).toBe("entwurf");
    }

    // 6. Pro Rechnung exakt EIN neuer invoice_zugferd_embed_failed-Audit-
    //    Eintrag mit batchSend=true und Reason-Text.
    const afterAuditRows = await db.select({
      id: auditLog.id,
      entityId: auditLog.entityId,
      metadata: auditLog.metadata,
    })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_zugferd_embed_failed"),
        eq(auditLog.entityType, "invoice"),
        inArray(auditLog.entityId, invoiceIds),
      ))
      .orderBy(asc(auditLog.id));

    for (const invoiceId of invoiceIds) {
      const before = beforeCountByInvoice.get(invoiceId) || 0;
      const afterForInvoice = afterAuditRows.filter((r) => r.entityId === invoiceId);
      expect(
        afterForInvoice.length - before,
        `Genau ein neuer invoice_zugferd_embed_failed-Audit-Eintrag für Rechnung ${invoiceId}`,
      ).toBe(1);
      const newRow = afterForInvoice[afterForInvoice.length - 1];
      const metadata = (newRow.metadata as Record<string, unknown> | null) || {};
      expect(
        metadata.batchSend,
        `Audit-Metadata für Rechnung ${invoiceId} muss batchSend=true tragen`,
      ).toBe(true);
      expect(
        String(metadata.reason || ""),
        `Audit-Metadata für Rechnung ${invoiceId} muss Reason-Text enthalten`,
      ).toMatch(/Test fault injected|zugferd_embed/i);
      expect(
        metadata.invoiceNumber,
        `Audit-Metadata für Rechnung ${invoiceId} muss invoiceNumber enthalten`,
      ).toBeTruthy();
    }

    // 7. KEIN document_deliveries-Eintrag — der Send wird vor sendEmail
    //    abgebrochen, sodass kein Postausgangs-Record entsteht.
    const customerIds = [a.customerId, b.customerId];
    const deliveryRows = await db.select({
      id: documentDeliveries.id,
      customerId: documentDeliveries.customerId,
      status: documentDeliveries.status,
    })
      .from(documentDeliveries)
      .where(inArray(documentDeliveries.customerId, customerIds));
    expect(
      deliveryRows.length,
      `Kein document_deliveries-Eintrag erlaubt — got ${JSON.stringify(deliveryRows)}`,
    ).toBe(0);
  }, 180_000);
});
