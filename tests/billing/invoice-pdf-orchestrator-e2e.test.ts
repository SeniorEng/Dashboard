import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1001 — End-to-End-Absicherung der Rechnungs- + Leistungsnachweis-PDF-
 * Erzeugung gegen einen ECHTEN Abrechnungslauf (nicht synthetische pdfData).
 *
 * Zwei Garantien aus `server/services/invoice-pdf-orchestrator.ts`:
 *
 *  (1) Multi-Topf-Split (Variant C, Task #759): ein Lauf mit Anteilen aus
 *      mehreren Budget-Töpfen erzeugt N Rechnungen, verbunden über
 *      `billing_run_id`. Jede Rechnung trägt im Leistungsnachweis NUR die
 *      Termine, die TATSÄCHLICH auf DIESER Rechnung abgerechnet wurden
 *      (`enrichPdfDataWithSignatures` schränkt die Signatur-Sektionen auf
 *      `invoiceAppointmentIds` ein). Ein Termin, der nur auf der
 *      Geschwister-Rechnung liegt, darf NICHT auf den fremden LN lecken.
 *      Zusätzlich greift der Fail-Closed-Guard
 *      (`assertServiceRecordsScopedToInvoice`): ein fremder Service-Record
 *      wirft sofort.
 *
 *  (2) Storno-Beihilfe-Duplikat (Task #997 #4): Eine Beihilfe-Kundenrechnung
 *      erzeugt im Merge-Pfad eine Zweitausfertigung (Rechnung + LN doppelt) —
 *      eine Stornorechnung NICHT. Ein Storno-Dokument hat damit exakt EINE
 *      LN-Seite (kein Beihilfe-Duplikat).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { db } from "../../server/lib/db";
import {
  invoices as invoicesTable,
  customers as customersTable,
  documentDeliveries,
} from "@shared/schema";
import type { UserWithRoles } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import {
  getTestOutbox as getLocalOutbox,
  clearTestOutbox as clearLocalOutbox,
} from "../../server/services/email-service";
import { storage } from "../../server/storage";
import {
  buildPdfData,
  enrichPdfDataWithSignatures,
  assertServiceRecordsScopedToInvoice,
  buildInvoicePdfBytes,
  buildInvoicePdfData,
  persistInvoicePdf,
  renderLeistungsnachweisOnTheFly,
  loadLeistungsnachweisPdfFromStorage,
} from "../../server/services/invoice-pdf-orchestrator";
import { generateLeistungsnachweisHtml } from "../../server/lib/pdf-generator";
import { formatCustomerMasterAddress } from "../../server/lib/customer-address-format";
import type { InvoiceRenderSnapshot } from "@shared/schema";
import { getCachedCompanySettings, companySettingsCache } from "../../server/services/cache";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  getTestOutbox,
  clearTestOutbox,
  runCleanup,
  uniqueId,
} from "../test-utils";

async function pageCount(buf: Buffer): Promise<number> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(buf);
  return doc.getPageCount();
}

// Leichtgewichtiger PDF-Text-Extraktor (nur Tests, devDependency `pdf-parse`).
// Subpfad-Import vermeidet den Demo-Code in `pdf-parse/index.js`.
//
// `pdf-parse` bündelt ein altes pdf.js (v1.10.100), das die Object-Streams
// moderner PDFs (pdf-lib-Merge in bundle/bulk-print) nicht lesen kann
// ("Invalid PDF structure"). Wir normalisieren die Bytes daher über pdf-lib
// auf eine klassische Xref-Tabelle (useObjectStreams:false), bevor wir den
// Text extrahieren — die Text-Streams bleiben dabei unverändert.
type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;
async function extractPdfText(buf: Buffer): Promise<string> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(buf);
  const normalized = Buffer.from(await doc.save({ useObjectStreams: false }));
  const ns = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as { default: PdfParseFn };
  const parsed = await ns.default(normalized);
  return parsed.text;
}

const RAW_BASE = process.env.TEST_BASE_URL || "http://localhost:5000";

// Roh-Fetch-Helfer für binäre PDF-/ZIP-Antworten (apiGet/apiPost lesen JSON).
async function fetchBinaryGet(path: string): Promise<{ status: number; contentType: string; buf: Buffer }> {
  const auth = await getAuthCookie();
  const res = await fetch(`${RAW_BASE}${path}`, { headers: { Cookie: auth.cookie } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", buf };
}

async function fetchBinaryPost(path: string, body: unknown): Promise<{ status: number; contentType: string; buf: Buffer }> {
  const auth = await getAuthCookie();
  const cookieHeader = `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`;
  const res = await fetch(`${RAW_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", buf };
}

// ---------------------------------------------------------------------------
// (1) Multi-Topf-Lauf (§45b-Rest → §45a-Überlauf), 2 Rechnungen, gemeinsame
//     billingRunId. LN je Rechnung exakt auf seine Termine eingegrenzt.
// ---------------------------------------------------------------------------
describe("Task #1001 — Multi-Topf-Rechnungslauf: LN-Scoping je Rechnung", () => {
  const YEAR = 2026;
  const MONTH = 4;
  let customerId: number;
  let employeeId: number;
  let abServiceId: number;
  let hwServiceId: number;
  let appt1Id: number; // 02.04 — Alltagsbegleitung: §45b-Rest + §45a-Überlauf
  let appt2Id: number; // 09.04 — Hauswirtschaft: vollständig §45a
  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();

    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    const providers = await apiGet<Array<{ id: number; name: string }>>("/api/admin/insurance-providers");
    const aok = providers.data.find((p) => /AOK PLUS/i.test(p.name)) ?? providers.data[0];
    expect(aok, "Mindestens eine Pflegekasse muss geseedet sein").toBeTruthy();

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Topf",
      nachname: `Split-${uniqueId()}`,
      geburtsdatum: "1942-05-10",
      email: `split-${uniqueId()}@test.local`,
      strasse: "Musterweg",
      nr: "12",
      plz: "01067",
      stadt: "Dresden",
      telefon: "+4917600000001",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      insurance: {
        providerId: aok!.id,
        versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ nachnamePrefix: "Split_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);
  });

  afterAll(async () => {
    for (const id of cleanupInvoiceIds) {
      try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch { /* best-effort */ }
    }
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  async function createAndDocument(
    date: string,
    serviceId: number,
    durationMinutes: number,
  ): Promise<number> {
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date,
      scheduledStart: "13:00",
      scheduledEnd: "14:30",
      notes: `Split-Repro-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId, durationMinutes }],
    });
    expect(apptRes.status, `appt ${date}: ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "13:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId, actualDurationMinutes: durationMinutes, details: "Repro" }],
    });
    expect(docRes.status, `document ${date}: ${JSON.stringify(docRes.data)}`).toBe(200);
    return apptRes.data.id;
  }

  it("erzeugt 2 Rechnungen mit gemeinsamer billingRunId; jeder LN nur seine Termine", async () => {
    // §45b: nur ein kleiner Rest frei (Priorität 1, FIFO) → erzwingt Cascade.
    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 1181,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const init45a = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a",
      currentMonthAmountCents: 59880,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201]).toContain(init45a.status);

    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 1181, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 59880, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // Termine in Dokumentations-Reihenfolge: 02.04 konsumiert §45b-Rest zuerst.
    appt1Id = await createAndDocument(`${YEAR}-0${MONTH}-02`, abServiceId, 30);
    appt2Id = await createAndDocument(`${YEAR}-0${MONTH}-09`, hwServiceId, 75);

    // Leistungsnachweis erstellen + signieren (ein monatlicher SR für beide Termine).
    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    // Rechnungslauf → Topf-Gruppe.
    const genRes = await apiPost<{ splitInvoices?: boolean; invoices?: Array<{ id: number; billingRunId: string | null; budgetType: string | null }> }>(
      "/api/billing/generate",
      { customerId, billingMonth: MONTH, billingYear: YEAR },
    );
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    expect(genRes.data.splitInvoices, "Mehr-Topf-Lauf muss splitInvoices=true liefern").toBe(true);
    const invoices = genRes.data.invoices ?? [];
    for (const inv of invoices) cleanupInvoiceIds.push(inv.id);

    expect(invoices.length, "Es müssen genau 2 Rechnungen entstehen").toBe(2);
    const billingRunIds = new Set(invoices.map((i) => i.billingRunId));
    expect(billingRunIds.size, "Beide Rechnungen teilen dieselbe billingRunId").toBe(1);
    expect([...billingRunIds][0], "billingRunId darf nicht null sein").toBeTruthy();

    const companySettings = await getCachedCompanySettings();
    expect(companySettings, "company_settings müssen konfiguriert sein").toBeTruthy();

    // Pro Rechnung: pdfData bauen, Signaturen anreichern, LN-Scope prüfen.
    const scoped = new Map<string, { lnApptIds: Set<number>; lineItemApptIds: Set<number> }>();
    for (const inv of invoices) {
      const fullInvoice = await storage.getInvoice(inv.id);
      expect(fullInvoice, `getInvoice(${inv.id})`).toBeTruthy();
      const lineItems = await storage.getInvoiceLineItems(inv.id);
      const pdfData = buildPdfData(fullInvoice!, lineItems, companySettings!);
      await enrichPdfDataWithSignatures(pdfData, fullInvoice!);

      const lnApptIds = new Set(
        (pdfData.signatures ?? []).flatMap((s) => s.appointmentIds),
      );
      const lineItemApptIds = new Set(
        lineItems.map((li) => li.appointmentId).filter((x): x is number => x != null),
      );

      // KERN-INVARIANTE: Der LN enthält AUSSCHLIESSLICH die Termine DIESER
      // Rechnung — keine Termine der Geschwister-Rechnung.
      expect(
        [...lnApptIds].sort(),
        `LN von Rechnung ${inv.id} (${inv.budgetType}) muss exakt seine Line-Item-Termine spiegeln`,
      ).toEqual([...lineItemApptIds].sort());

      scoped.set(inv.budgetType ?? "?", { lnApptIds, lineItemApptIds });
    }

    const pot45b = scoped.get("entlastungsbetrag_45b");
    const pot45a = scoped.get("umwandlung_45a");
    expect(pot45b, "§45b-Rechnung muss existieren").toBeTruthy();
    expect(pot45a, "§45a-Rechnung muss existieren").toBeTruthy();

    // §45b-Rechnung trägt NUR den 02.04-Termin (appt1) — NICHT den 09.04 (appt2).
    expect(pot45b!.lnApptIds.has(appt1Id), "§45b-LN enthält appt1").toBe(true);
    expect(pot45b!.lnApptIds.has(appt2Id), "§45b-LN darf appt2 (nur §45a) NICHT enthalten").toBe(false);

    // §45a-Rechnung trägt appt2 (vollständig §45a) und ebenfalls appt1 (Überlauf).
    expect(pot45a!.lnApptIds.has(appt2Id), "§45a-LN enthält appt2").toBe(true);
    expect(pot45a!.lnApptIds.has(appt1Id), "§45a-LN enthält appt1 (Überlauf)").toBe(true);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// (2) Fail-Closed-Guard: ein fremder Service-Record wirft sofort.
// ---------------------------------------------------------------------------
describe("Task #1001 — assertServiceRecordsScopedToInvoice (Fail-Closed)", () => {
  it("akzeptiert ausschließlich Records des Rechnungs-Kunden", () => {
    expect(() =>
      assertServiceRecordsScopedToInvoice(
        [{ id: 1, customerId: 42 }, { id: 2, customerId: 42 }],
        42,
        "RE-2026-0001",
      ),
    ).not.toThrow();
  });

  it("wirft, sobald ein Record einem FREMDEN Kunden gehört", () => {
    expect(() =>
      assertServiceRecordsScopedToInvoice(
        [{ id: 1, customerId: 42 }, { id: 99, customerId: 7 }],
        42,
        "RE-2026-0001",
      ),
    ).toThrowError(/Leistungsnachweis-Scope verletzt.*#99.*Kunde 7.*Kunde 42/s);
  });
});

// ---------------------------------------------------------------------------
// (3) Storno erzeugt KEIN Beihilfe-Duplikat → genau eine LN-Seite.
// ---------------------------------------------------------------------------
describe("Task #1001 — Storno-Rechnung ohne Beihilfe-Duplikat", () => {
  const YEAR = 2026;
  const MONTH = 5;
  let customerId: number;
  let employeeId: number;
  let hwServiceId: number;
  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();
    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    const providers = await apiGet<Array<{ id: number; name: string }>>("/api/admin/insurance-providers");
    const provider = providers.data.find((p) => /AOK PLUS/i.test(p.name)) ?? providers.data[0];
    expect(provider, "Mindestens eine Pflegekasse muss geseedet sein").toBeTruthy();

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Beihilfe",
      nachname: `Storno-${uniqueId()}`,
      geburtsdatum: "1940-03-03",
      email: `beihilfe-${uniqueId()}@test.local`,
      strasse: "Beihilfeweg",
      nr: "3",
      plz: "10115",
      stadt: "Berlin",
      telefon: "+4917600000002",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_privat",
      acceptsPrivatePayment: true,
      beihilfeBerechtigt: true,
      insurance: {
        providerId: provider!.id,
        versichertennummer: "B" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ nachnamePrefix: "Storno_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);
  });

  afterAll(async () => {
    for (const id of cleanupInvoiceIds) {
      try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch { /* best-effort */ }
    }
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  it("Original = Beihilfe-Duplikat (doppelte Seiten); Storno = genau eine LN-Seite", async () => {
    // §45b mit reichlich Budget → der Termin wird vollständig aus EINEM
    // Pflegekassen-Topf gedeckt (kein Privat-/Selbstzahler-Überlauf). Nur so
    // bleibt die generierte Rechnung billingType=pflegekasse_privat (statt nach
    // selbstzahler reklassifiziert zu werden) und erhält damit einen LN.
    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-0${MONTH}-05`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `Beihilfe-Storno-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Repro" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: MONTH, billingYear: YEAR,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    const origData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    const origId: number = origData.id;
    expect(origId, "Original-Rechnung muss eine id haben").toBeTruthy();
    cleanupInvoiceIds.push(origId);

    const companySettings = await getCachedCompanySettings();
    expect(companySettings, "company_settings müssen konfiguriert sein").toBeTruthy();

    // Original-PDF rendern (Beihilfe-Kundenrechnung → Merge-Pfad mit Duplikat).
    const origInvoice = await storage.getInvoice(origId);
    expect(origInvoice!.invoiceType, "Original ist eine reguläre Rechnung").toBe("rechnung");
    const origBytes = await buildInvoicePdfBytes(origInvoice!, companySettings!);
    const pOrig = await pageCount(origBytes.pdf);

    // Storno auslösen.
    const stornoRes = await apiPatch(`/api/billing/${origId}/status`, { status: "storniert" });
    expect(stornoRes.status, `storno: ${JSON.stringify(stornoRes.data)}`).toBe(200);

    const stornoRows = await db.select().from(invoicesTable).where(eq(invoicesTable.stornierteRechnungId, origId));
    expect(stornoRows.length, "Es muss genau eine Stornorechnung existieren").toBe(1);
    cleanupInvoiceIds.push(stornoRows[0].id);

    const stornoInvoice = await storage.getInvoice(stornoRows[0].id);
    expect(stornoInvoice!.invoiceType, "Storno hat invoiceType=stornorechnung").toBe("stornorechnung");
    const stornoBytes = await buildInvoicePdfBytes(stornoInvoice!, companySettings!);
    const pStorno = await pageCount(stornoBytes.pdf);

    // Storno-Standalone-LN = genau EINE Seite (ein Termin, kein Duplikat).
    expect(stornoBytes.leistungsnachweisPdf, "Storno muss einen LN erzeugen").toBeTruthy();
    const lnPages = await pageCount(stornoBytes.leistungsnachweisPdf!);
    expect(lnPages, "Storno-Leistungsnachweis hat genau eine Seite").toBe(1);

    // Das Original verdoppelt (Beihilfe-Zweitausfertigung), das Storno NICHT.
    expect(pStorno, "Storno-Dokument: Rechnung + 1 LN-Seite").toBeGreaterThanOrEqual(2);
    expect(pOrig, "Original-Dokument muss durch Beihilfe-Duplikat genau doppelt so viele Seiten haben").toBe(pStorno * 2);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// (4) Task #1032 — Render-Level-Absicherung: Der Leistungsnachweis
//     ("Leistungsempfänger/in") trägt die KUNDEN-STAMMADRESSE, NICHT die
//     Pflegekassen-Anschrift. Für eine gesetzliche Kasse OHNE Kostenerstattung
//     (`rechnungAnKunde=false`) ist `invoice.recipientAddress` die Kassen-
//     Anschrift; `buildPdfData` bindet `customerAddress` daran. Die Korrektur
//     in `buildInvoicePdfData` überschreibt `customerAddress` mit der aus dem
//     customerSnapshot abgeleiteten Stammadresse (live für Entwürfe, eingefroren
//     via renderSnapshot für versendete/stornierte Rechnungen). Dieser Test
//     verriegelt beide Pfade auf Render-Ebene (pdfData + gerendertes LN-HTML +
//     erzeugte LN-PDF-Bytes), damit die emailten/gebündelten Kopien dieselbe
//     korrekte Adresse zeigen.
// ---------------------------------------------------------------------------
describe("Task #1032 — LN-Adresse = Kunden-Stammadresse (Render-Ebene)", () => {
  const YEAR = 2026;
  const MONTH = 6;
  // Eindeutige Stammadresse, die NICHT mit einer geseedeten Kassen-Anschrift
  // kollidieren kann.
  const MASTER_STRASSE = "Patientenweg";
  const MASTER_NR = "7";
  const MASTER_PLZ = "01069";
  const MASTER_STADT = "Dresden-Patientort";
  let customerId: number;
  let employeeId: number;
  let hwServiceId: number;
  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();
    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    const providers = await apiGet<Array<{ id: number; name: string }>>("/api/admin/insurance-providers");
    const aok = providers.data.find((p) => /AOK PLUS/i.test(p.name)) ?? providers.data[0];
    expect(aok, "Mindestens eine Pflegekasse muss geseedet sein").toBeTruthy();

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Adress",
      nachname: `LN-${uniqueId()}`,
      geburtsdatum: "1941-07-07",
      email: `ln-addr-${uniqueId()}@test.local`,
      strasse: MASTER_STRASSE,
      nr: MASTER_NR,
      plz: MASTER_PLZ,
      stadt: MASTER_STADT,
      telefon: "+4917600000003",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: aok!.id,
        versichertennummer: "C" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ nachnamePrefix: "LNAddr_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);
  });

  afterAll(async () => {
    for (const id of cleanupInvoiceIds) {
      try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch { /* best-effort */ }
    }
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  it("LN zeigt die Stammadresse — live-draft UND eingefrorener renderSnapshot", async () => {
    // §45b mit reichlich Budget → der Termin wird vollständig aus dem
    // Pflegekassen-Topf gedeckt (kein Selbstzahler-Reklassifizieren) und die
    // Rechnung bleibt pflegekasse_gesetzlich → erzeugt einen LN.
    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-0${MONTH}-05`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `LN-Addr-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Repro" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: MONTH, billingYear: YEAR,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    const invoiceId: number = invData.id;
    expect(invoiceId, "Rechnung muss eine id haben").toBeTruthy();
    cleanupInvoiceIds.push(invoiceId);

    const companySettings = await getCachedCompanySettings();
    expect(companySettings, "company_settings müssen konfiguriert sein").toBeTruthy();

    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice, `getInvoice(${invoiceId})`).toBeTruthy();
    // Voraussetzung des Bugs: gesetzliche Kasse OHNE Kostenerstattung →
    // recipientAddress ist NICHT die Stammadresse (sondern Kasse bzw. leer).
    expect(invoice!.billingType, "Rechnung bleibt pflegekasse_gesetzlich").toBe("pflegekasse_gesetzlich");

    const expectedMaster = formatCustomerMasterAddress({
      strasse: MASTER_STRASSE, nr: MASTER_NR, plz: MASTER_PLZ, stadt: MASTER_STADT,
    });
    expect(expectedMaster, "Stammadresse darf nicht leer sein").toBeTruthy();

    // --- (A) LIVE-DRAFT-PFAD (kein Snapshot): Stammadresse wird live gelesen.
    const live = await buildInvoicePdfData(invoice!, companySettings!);
    expect(live.isPflegekasseInvoice, "Pflegekassen-Rechnung → erhält einen LN").toBe(true);
    expect(
      live.pdfData.customerAddress,
      "LN-customerAddress (live) = Kunden-Stammadresse, NICHT die Kassen-Anschrift",
    ).toBe(expectedMaster);
    // Die Stammadresse weicht von der Rechnungsempfänger-Anschrift (Kasse) ab —
    // genau das war der Regressions-Kern (LN zeigte zuvor recipientAddress).
    expect(
      live.pdfData.customerAddress,
      "customerAddress darf NICHT der Rechnungsempfänger-Anschrift (Kasse) entsprechen",
    ).not.toBe(invoice!.recipientAddress ?? null);

    // Render-Ebene: das gerenderte LN-HTML enthält die Stammadresse im
    // "Leistungsempfänger/in"-Block und NICHT die Kassen-Anschrift.
    await enrichPdfDataWithSignatures(live.pdfData, invoice!);
    const liveHtml = generateLeistungsnachweisHtml(live.pdfData);
    expect(liveHtml).toContain(MASTER_STRASSE);
    expect(liveHtml).toContain(MASTER_STADT);

    // Erzeugte LN-PDF-Bytes (= emailten/gebündelten Kopien) entstehen ohne
    // Fehler und sind nicht leer.
    const liveBytes = await buildInvoicePdfBytes(invoice!, companySettings!);
    expect(liveBytes.leistungsnachweisPdf, "Pflegekassen-Rechnung erzeugt LN-Bytes").toBeTruthy();
    expect(liveBytes.leistungsnachweisPdf!.length).toBeGreaterThan(0);

    // --- (B) EINGEFRORENER SNAPSHOT-PFAD (versendet/storniert): Die LN-Adresse
    //     wird aus dem renderSnapshot abgeleitet — auch wenn dieser eine ANDERE
    //     (zum Versendezeitpunkt eingefrorene) Stammadresse trägt als die Live-
    //     Tabelle. Das beweist, dass der Snapshot-Pfad die Stammadresse aus dem
    //     customerSnapshot und NICHT die Kassen-Anschrift verwendet.
    const FROZEN_STRASSE = "Altweg";
    const FROZEN_NR = "99";
    const FROZEN_PLZ = "04109";
    const FROZEN_STADT = "Leipzig-Altort";
    const frozenMaster = formatCustomerMasterAddress({
      strasse: FROZEN_STRASSE, nr: FROZEN_NR, plz: FROZEN_PLZ, stadt: FROZEN_STADT,
    })!;
    const snapshot: InvoiceRenderSnapshot = {
      companySettings: {
        companyName: companySettings!.companyName ?? null,
        logoUrl: null,
        strasse: companySettings!.strasse ?? null,
        hausnummer: companySettings!.hausnummer ?? null,
        plz: companySettings!.plz ?? null,
        stadt: companySettings!.stadt ?? null,
        telefon: companySettings!.telefon ?? null,
        email: companySettings!.email ?? null,
        website: companySettings!.website ?? null,
        steuernummer: companySettings!.steuernummer ?? null,
        ustId: companySettings!.ustId ?? null,
        iban: companySettings!.iban ?? null,
        bic: companySettings!.bic ?? null,
        bankName: companySettings!.bankName ?? null,
        bankAccountHolder: companySettings!.bankAccountHolder ?? null,
        ikNummer: companySettings!.ikNummer ?? null,
        geschaeftsfuehrer: companySettings!.geschaeftsfuehrer ?? null,
      },
      customer: {
        geburtsdatum: "1941-07-07",
        beihilfeBerechtigt: false,
        rechnungAnKunde: false,
        name: null,
        vorname: "Adress",
        nachname: "LN",
        strasse: FROZEN_STRASSE,
        nr: FROZEN_NR,
        plz: FROZEN_PLZ,
        stadt: FROZEN_STADT,
      },
    };

    const frozen = await buildInvoicePdfData(invoice!, companySettings!, { snapshot });
    expect(
      frozen.pdfData.customerAddress,
      "LN-customerAddress (snapshot) = eingefrorene Stamm-Anschrift, NICHT die Kasse",
    ).toBe(frozenMaster);
    expect(
      frozen.pdfData.customerAddress,
      "Snapshot-Pfad darf NICHT die live-Stammadresse verwenden",
    ).not.toBe(expectedMaster);

    await enrichPdfDataWithSignatures(frozen.pdfData, invoice!);
    const frozenHtml = generateLeistungsnachweisHtml(frozen.pdfData);
    expect(frozenHtml).toContain(FROZEN_STRASSE);
    expect(frozenHtml).toContain(FROZEN_STADT);
    // Die LIVE-Stammadresse darf im eingefrorenen Render NICHT auftauchen.
    expect(frozenHtml).not.toContain(MASTER_STRASSE);

    const frozenBytes = await buildInvoicePdfBytes(invoice!, companySettings!, { snapshot });
    expect(frozenBytes.leistungsnachweisPdf, "Snapshot-Render erzeugt LN-Bytes").toBeTruthy();
    expect(frozenBytes.leistungsnachweisPdf!.length).toBeGreaterThan(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Task #1034 — LN-Adresse = Kunden-Stammadresse über die ECHTEN HTTP-Routen.
//
// Task #1032 bewies die Stammadresse auf Orchestrator-/Render-Ebene. Diese
// Suite schließt die Lücke und treibt die tatsächlichen Versand- und Druck-
// Routen für einen gesetzlich versicherten Kunden (rechnungAnKunde=false):
//
//   - POST /api/billing/:id/send  → die E-Mail an die PFLEGEKASSE hängt einen
//     Leistungsnachweis (LN-<Nr>.pdf) an. Der ausgelieferte LN muss die
//     Kunden-STAMMADRESSE tragen, NICHT die Kassen-Anschrift.
//   - GET  /api/billing/:id/bundle → zusammengeführtes Druck-PDF (Rechnung +
//     LN). Die LN-Seite trägt die Stammadresse.
//   - POST /api/billing/bulk-print → monatliches Sammeldruck-PDF. Auch hier
//     trägt die LN-Seite die Stammadresse.
//
// Eine DEDIZIERTE Pflegekasse mit unverwechselbarer Anschrift wird angelegt,
// damit wir im freistehenden LN positiv die Stammadresse UND negativ die
// Abwesenheit der Kassen-Anschrift prüfen können. Der gelieferte LN-Text wird
// aus den finalen PDF-Bytes extrahiert (`pdf-parse`).
// ---------------------------------------------------------------------------
describe("Task #1034 — LN-Stammadresse über Versand-/Druck-Routen (HTTP)", () => {
  const YEAR = 2026;
  const SEND_MONTH = 3; // send + bundle
  const BULK_MONTH = 2; // bulk-print (eigener Entwurf, gleicher Kunde)

  // Unverwechselbare Stammadresse (kollidiert nicht mit Kasse oder #1032).
  const MASTER_STRASSE = "Behandlungspfad";
  const MASTER_NR = "3";
  const MASTER_PLZ = "01097";
  const MASTER_STADT = "Dresden-Stammort";

  // Unverwechselbare Kassen-Anschrift — diese DARF im freistehenden LN nicht
  // auftauchen (recipientAddress wird in invoice-calc.ts aus diesen Feldern
  // gebaut, wenn gesetzlich + !rechnungAnKunde).
  const KASSE_STRASSE = "Kassenallee";
  const KASSE_NR = "9";
  const KASSE_PLZ = "99998";
  const KASSE_STADT = "Kassenstadt-Fernort";

  let customerId: number;
  let employeeId: number;
  let hwServiceId: number;
  let insuranceProviderId: number;
  let kasseEmail: string;
  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();
    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    // Dedizierte gesetzliche Pflegekasse mit E-Mail-Versand + eindeutiger
    // Anschrift. Eigene Kasse → wir mutieren keine geseedete AOK und
    // isolieren bulk-print sauber über insuranceProviderId.
    kasseEmail = `kasse-route-${uniqueId()}@test.local`;
    const ik = String(Math.floor(100000000 + Math.random() * 900000000));
    const provRes = await apiPost<{ id: number }>("/api/admin/insurance-providers", {
      name: `Route-Kasse ${uniqueId()}`,
      isPrivate: false,
      ikNummer: ik,
      strasse: KASSE_STRASSE,
      hausnummer: KASSE_NR,
      plz: KASSE_PLZ,
      stadt: KASSE_STADT,
      email: kasseEmail,
      emailInvoiceEnabled: true,
    });
    expect(provRes.status, `create provider: ${JSON.stringify(provRes.data)}`).toBe(201);
    insuranceProviderId = provRes.data.id;

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Route",
      nachname: `LN-${uniqueId()}`,
      geburtsdatum: "1940-03-03",
      email: `route-ln-${uniqueId()}@test.local`,
      strasse: MASTER_STRASSE,
      nr: MASTER_NR,
      plz: MASTER_PLZ,
      stadt: MASTER_STADT,
      telefon: "+4917600000004",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "R" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ nachnamePrefix: "RouteLN_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

    // §45b mit reichlich Budget ab dem früheren Monat → beide Termine
    // (Februar + März) werden vollständig aus der Kasse gedeckt, die
    // Rechnung bleibt pflegekasse_gesetzlich und erzeugt einen LN.
    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${BULK_MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // SMTP-Dummy-Konfig: Der Versand-Pfad ruft `ensureSmtpConfigured` VOR der
    // Stub-Weiche auf — ohne gesetzte SMTP-Felder schlägt POST /send auch im
    // Test-Stub mit "SMTP-Konfiguration unvollständig" fehl. Unter NODE_ENV=test
    // verbindet sich nichts; die Mail landet im In-Memory-Outbox-Stub.
    const smtpRes = await apiPatch(`/api/company-settings`, {
      smtpHost: "smtp.test.local",
      smtpPort: "587",
      smtpUser: "outbox@test.local",
      smtpPass: "stub-secret",
      smtpFromEmail: "absender@test.local",
      smtpFromName: "CareConnect Test",
    });
    expect(smtpRes.status, `smtp-config: ${JSON.stringify(smtpRes.data)}`).toBe(200);
  });

  afterAll(async () => {
    for (const id of cleanupInvoiceIds) {
      try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch { /* best-effort */ }
    }
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    // Keine Delete-Route für Pflegekassen — die dedizierte Kasse bleibt in der
    // pro Lauf verworfenen Ephemeral-Test-DB zurück (kein Cross-Test-Leak,
    // da IK/E-Mail eindeutig pro Lauf sind).
    await runCleanup();
  });

  // Erzeugt für einen Monat einen signierten, gesetzlich gedeckten
  // Entwurf (Termin → Dokumentation → SR → 2 Unterschriften → Rechnung).
  async function generateSignedInvoice(month: number): Promise<number> {
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-0${month}-05`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `RouteLN-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt ${month}: ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Repro" }],
    });
    expect(docRes.status, `document ${month}: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month,
    });
    expect(srRes.status, `SR create ${month}: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}) ${month}: ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: month, billingYear: YEAR,
    });
    expect(genRes.status, `generate ${month}: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    const invoiceId: number = invData.id;
    expect(invoiceId, `Rechnung ${month} muss eine id haben`).toBeTruthy();
    cleanupInvoiceIds.push(invoiceId);
    return invoiceId;
  }

  it("Bündel- UND Versand-Route liefern den LN mit der Kunden-Stammadresse", async () => {
    const invoiceId = await generateSignedInvoice(SEND_MONTH);

    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice, `getInvoice(${invoiceId})`).toBeTruthy();
    // Voraussetzung des geschlossenen Bugs: gesetzliche Kasse OHNE
    // Kostenerstattung → recipientAddress ist die Kassen-Anschrift.
    expect(invoice!.billingType, "Rechnung bleibt pflegekasse_gesetzlich").toBe("pflegekasse_gesetzlich");
    const invoiceNumber = invoice!.invoiceNumber;

    const expectedMaster = formatCustomerMasterAddress({
      strasse: MASTER_STRASSE, nr: MASTER_NR, plz: MASTER_PLZ, stadt: MASTER_STADT,
    });
    expect(expectedMaster, "Stammadresse darf nicht leer sein").toBeTruthy();
    // Die Kassen-Anschrift (recipientAddress) muss von der Stammadresse
    // abweichen — sonst wäre der Negativ-Test wertlos.
    expect(invoice!.recipientAddress ?? "", "recipientAddress = Kassen-Anschrift").toContain(KASSE_STADT);
    expect(invoice!.recipientAddress ?? "").not.toContain(MASTER_STRASSE);

    // --- (A) BÜNDEL-ROUTE: Rechnung + LN als ein PDF. Wärmt zugleich den
    //     PDF-Cache (persistInvoicePdf), den der Versand-Pfad danach liest.
    const bundle = await fetchBinaryGet(`/api/billing/${invoiceId}/bundle`);
    expect(bundle.status, "bundle HTTP 200").toBe(200);
    expect(bundle.contentType).toContain("application/pdf");
    expect(await pageCount(bundle.buf), "Bündel = Rechnung + LN (≥2 Seiten)").toBeGreaterThanOrEqual(2);
    const bundleText = await extractPdfText(bundle.buf);
    expect(bundleText, "Bündel-PDF enthält die Stamm-Straße (LN-Seite)").toContain(MASTER_STRASSE);
    expect(bundleText, "Bündel-PDF enthält den Stamm-Ort (LN-Seite)").toContain(MASTER_STADT);

    // --- (B) VERSAND-ROUTE: E-Mail an die Pflegekasse mit LN-Anhang.
    await clearTestOutbox();
    const sendRes = await apiPost<any>(`/api/billing/${invoiceId}/send`, {});
    expect(sendRes.status, `send: ${JSON.stringify(sendRes.data)}`).toBe(200);

    const outbox = await getTestOutbox();
    const lnAttachment = `LN-${invoiceNumber}.pdf`;
    const msg = outbox.find((m) => m.attachmentNames.includes(lnAttachment));
    expect(msg, `Versand-Mail mit Anhang ${lnAttachment} muss im Postausgang liegen`).toBeTruthy();
    // Empfänger ist die PFLEGEKASSE (nicht der Kunde), da gesetzlich +
    // !rechnungAnKunde → sendToCustomer=false.
    expect(msg!.to, "Empfänger = Pflegekassen-E-Mail").toBe(kasseEmail);
    expect(msg!.attachmentNames, "auch die Rechnung hängt an").toContain(`${invoiceNumber}.pdf`);

    // Der versendete LN entspricht dem im Send-Pfad angehängten gecachten
    // LN (loadLeistungsnachweisPdfFromStorage). GET /:id/leistungsnachweis
    // liefert exakt diese Bytes → wir extrahieren den Text und prüfen, dass
    // der an die KASSE versandte LN die Kunden-STAMMADRESSE trägt und NICHT
    // die Kassen-Anschrift.
    const lnRes = await fetchBinaryGet(`/api/billing/${invoiceId}/leistungsnachweis`);
    expect(lnRes.status, "leistungsnachweis HTTP 200").toBe(200);
    expect(lnRes.contentType).toContain("application/pdf");
    const lnText = await extractPdfText(lnRes.buf);
    expect(lnText, "versandter LN enthält die Stamm-Straße").toContain(MASTER_STRASSE);
    expect(lnText, "versandter LN enthält den Stamm-Ort").toContain(MASTER_STADT);
    // Negativ: die Kassen-Anschrift darf im freistehenden LN nicht auftauchen.
    expect(lnText, "LN zeigt NICHT die Kassen-Straße").not.toContain(KASSE_STRASSE);
    expect(lnText, "LN zeigt NICHT den Kassen-Ort").not.toContain(KASSE_STADT);

    // Versand setzt den Status auf versendet.
    const afterSend = await storage.getInvoice(invoiceId);
    expect(afterSend!.status, "nach Versand: Status versendet").toBe("versendet");
  }, 240_000);

  it("Sammeldruck-Route (bulk-print) liefert den LN mit der Kunden-Stammadresse", async () => {
    const invoiceId = await generateSignedInvoice(BULK_MONTH);
    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice!.billingType, "Rechnung bleibt pflegekasse_gesetzlich").toBe("pflegekasse_gesetzlich");

    // Auf die dedizierte Kasse gefiltert → genau dieser eine Entwurf.
    const bulk = await fetchBinaryPost("/api/billing/bulk-print", {
      billingMonth: BULK_MONTH,
      billingYear: YEAR,
      insuranceProviderId,
    });
    expect(bulk.status, `bulk-print HTTP 200 (ct=${bulk.contentType})`).toBe(200);
    expect(bulk.contentType, "Sammeldruck = ein zusammengeführtes PDF").toContain("application/pdf");
    expect(await pageCount(bulk.buf), "Sammeldruck = Rechnung + LN (≥2 Seiten)").toBeGreaterThanOrEqual(2);
    const bulkText = await extractPdfText(bulk.buf);
    expect(bulkText, "Sammeldruck-PDF enthält die Stamm-Straße (LN-Seite)").toContain(MASTER_STRASSE);
    expect(bulkText, "Sammeldruck-PDF enthält den Stamm-Ort (LN-Seite)").toContain(MASTER_STADT);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// (Task #1038) — GoBD: Firmen-/Bankstammdaten einer bereits AUSGESTELLTEN
//     Rechnung sind EINGEFROREN. Ändert sich nach dem Versand die Live-
//     `company_settings`-Tabelle (IBAN/BIC/Bank/Kontoinhaber, Anschrift,
//     Steuernummer, USt-ID, IK-Nr, Geschäftsführer), MUSS jedes Re-Render der
//     versendeten/stornierten Rechnung weiterhin die zum Ausstellungszeitpunkt
//     gültigen Werte aus `invoice.renderSnapshot` zeigen — ENTWÜRFE (ohne
//     Snapshot) übernehmen dagegen die NEUEN Live-Werte.
//
//     Verriegelt alle drei von Task #1033 berührten Render-Pfade:
//       (1) `buildInvoicePdfData`            — Rechnungs-/ZUGFeRD-Datenobjekt
//       (2) `renderLeistungsnachweisOnTheFly`— On-the-fly-LN (Cache-Miss-Abruf)
//       (3) `renderLeistungsnachweisOnly`    — LN-Backfill via `persistInvoicePdf`
//                                              (privat, nur über den Persist-Pfad
//                                              erreichbar)
// ---------------------------------------------------------------------------
describe("Task #1038 — Firmen-/Bankstammdaten GoBD-eingefroren (3 Render-Pfade)", () => {
  const YEAR = 2026;
  const MONTH = 8;
  const uid = uniqueId();

  // Kunden-Stammadresse (im OLD-Snapshot eingefroren — der LN braucht einen
  // Leistungsempfänger; nicht Gegenstand der Firmen-Freeze-Assertions).
  const CUST_STRASSE = "Frozenweg";
  const CUST_NR = "3";
  const CUST_PLZ = "01097";
  const CUST_STADT = "Frozenstadt";

  // Die 16 Company-Felder, die der Snapshot/`buildPdfData`/ZUGFeRD-XML liest.
  const MUT_KEYS = [
    "companyName", "geschaeftsfuehrer", "strasse", "hausnummer", "plz", "stadt",
    "telefon", "email", "website", "steuernummer", "ustId", "iban", "bic",
    "bankName", "bankAccountHolder", "ikNummer",
  ] as const;

  // EINGEFRORENE Werte (= Ausstellungszeitpunkt, leben im renderSnapshot).
  const OLD = {
    companyName: `FirmaAltOLD${uid}`,
    geschaeftsfuehrer: `GFAltOLD${uid}`,
    strasse: "Altstrasse",
    hausnummer: "11",
    plz: "01001",
    stadt: `AltstadtOLD${uid}`,
    telefon: "+4935100000001",
    email: `alt-${uid}@firma.local`,
    website: "https://alt.example",
    steuernummer: `STNRALT${uid}`,
    ustId: `DEUSTALT${uid}`,
    iban: `DE00ALTIBANOLD${uid}`,
    bic: `ALTBICOLDXXX`,
    bankName: `HausbankAltOLD${uid}`,
    bankAccountHolder: `KontoAltOLD${uid}`,
    ikNummer: `IKALT${uid}`,
  };

  // NEUE LIVE-Werte (nach dem Versand in `company_settings` geschrieben).
  const NEW = {
    companyName: `FirmaNeuNEU${uid}`,
    geschaeftsfuehrer: `GFNeuNEU${uid}`,
    strasse: "Neustrasse",
    hausnummer: "22",
    plz: "01002",
    stadt: `NeustadtNEU${uid}`,
    telefon: "+4935100000002",
    email: `neu-${uid}@firma.local`,
    website: "https://neu.example",
    steuernummer: `STNRNEU${uid}`,
    ustId: `DEUSTNEU${uid}`,
    iban: `DE00NEUIBANNEU${uid}`,
    bic: `NEUBICNEUXXX`,
    bankName: `HausbankNeuNEU${uid}`,
    bankAccountHolder: `KontoNeuNEU${uid}`,
    ikNummer: `IKNEU${uid}`,
  };

  const OLD_SNAPSHOT: InvoiceRenderSnapshot = {
    companySettings: {
      companyName: OLD.companyName,
      logoUrl: null,
      strasse: OLD.strasse,
      hausnummer: OLD.hausnummer,
      plz: OLD.plz,
      stadt: OLD.stadt,
      telefon: OLD.telefon,
      email: OLD.email,
      website: OLD.website,
      steuernummer: OLD.steuernummer,
      ustId: OLD.ustId,
      iban: OLD.iban,
      bic: OLD.bic,
      bankName: OLD.bankName,
      bankAccountHolder: OLD.bankAccountHolder,
      ikNummer: OLD.ikNummer,
      geschaeftsfuehrer: OLD.geschaeftsfuehrer,
    },
    customer: {
      geburtsdatum: "1940-08-08",
      beihilfeBerechtigt: false,
      rechnungAnKunde: false,
      name: null,
      vorname: "Frozen",
      nachname: `Kunde-${uid}`,
      strasse: CUST_STRASSE,
      nr: CUST_NR,
      plz: CUST_PLZ,
      stadt: CUST_STADT,
    },
  };

  let customerId: number;
  let employeeId: number;
  let invoiceId: number;
  let invoiceRow: NonNullable<Awaited<ReturnType<typeof storage.getInvoice>>>;
  let superadminUserId: number;
  // Original-Werte, um `company_settings` in afterAll wiederherzustellen
  // (die Tabelle ist innerhalb der Worker-Wegwerf-DB geteilt).
  const ORIGINAL_PARTIAL: Record<string, unknown> = {};

  beforeAll(async () => {
    const auth = await getAuthCookie();
    superadminUserId = auth.user.id;

    // Original-Company-Settings sichern (für die Wiederherstellung).
    const orig = await getCachedCompanySettings();
    expect(orig, "company_settings müssen geseedet sein").toBeTruthy();
    for (const k of MUT_KEYS) ORIGINAL_PARTIAL[k] = (orig as Record<string, unknown>)[k] ?? null;

    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    const hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    const providers = await apiGet<Array<{ id: number; name: string }>>("/api/admin/insurance-providers");
    const aok = providers.data.find((p) => /AOK PLUS/i.test(p.name)) ?? providers.data[0];
    expect(aok, "Mindestens eine Pflegekasse muss geseedet sein").toBeTruthy();

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Frozen",
      nachname: `Kunde-${uid}`,
      geburtsdatum: "1940-08-08",
      email: `freeze-${uid}@test.local`,
      strasse: CUST_STRASSE,
      nr: CUST_NR,
      plz: CUST_PLZ,
      stadt: CUST_STADT,
      telefon: "+4917600000008",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: aok!.id,
        versichertennummer: "F" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ nachnamePrefix: "Freeze_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

    // §45b reichlich finanzieren → Termin bleibt voll aus der Kasse gedeckt,
    // Rechnung bleibt `pflegekasse_gesetzlich` und erzeugt einen LN.
    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-0${MONTH}-05`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `Freeze-${uid}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Freeze" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: MONTH, billingYear: YEAR,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    invoiceId = invData.id;
    expect(invoiceId, "Rechnung muss eine id haben").toBeTruthy();

    // Voll-Build deterministisch abschließen (synchron, de-duped mit dem
    // Hintergrund-Persist) → die Rechnung hat danach ein echtes pdfPath.
    await persistInvoicePdf(invoiceId);

    // "Versendet"-Zustand simulieren: Snapshot mit den EINGEFRORENEN OLD-Werten
    // setzen und den LN-Cache leeren (das echte pdfPath bleibt erhalten — der
    // LN-Backfill-Pfad `renderLeistungsnachweisOnly` greift nur, wenn pdfPath
    // gesetzt UND leistungsnachweisPath NULL ist).
    await db.update(invoicesTable)
      .set({ renderSnapshot: OLD_SNAPSHOT, leistungsnachweisPath: null, leistungsnachweisHash: null })
      .where(eq(invoicesTable.id, invoiceId));

    // NACH dem Versand: Live-`company_settings` auf die NEUEN Werte ändern.
    await storage.updateCompanySettings(NEW as Parameters<typeof storage.updateCompanySettings>[0], superadminUserId);
    companySettingsCache.invalidate();

    const reloaded = await storage.getInvoice(invoiceId);
    expect(reloaded, `getInvoice(${invoiceId})`).toBeTruthy();
    expect(reloaded!.billingType, "Rechnung bleibt pflegekasse_gesetzlich").toBe("pflegekasse_gesetzlich");
    invoiceRow = reloaded!;

    // Sanity: die Live-Mutation ist sichtbar (Entwürfe sehen NEU).
    const liveNew = await getCachedCompanySettings();
    expect(liveNew.companyName, "Live-company_settings tragen jetzt die NEUEN Werte").toBe(NEW.companyName);
    expect(liveNew.iban).toBe(NEW.iban);
  }, 180_000);

  afterAll(async () => {
    // Company-Settings wiederherstellen (Tabelle ist Worker-weit geteilt).
    try {
      await storage.updateCompanySettings(ORIGINAL_PARTIAL as Parameters<typeof storage.updateCompanySettings>[0], superadminUserId);
      companySettingsCache.invalidate();
    } catch { /* best-effort */ }
    try { await db.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId)); } catch { /* best-effort (finalisierte Rechnung) */ }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  it("(1) buildInvoicePdfData: Snapshot friert alle Firmen-/Bankfelder ein; Entwurf nutzt NEUE Live-Werte", async () => {
    const liveNew = await getCachedCompanySettings();
    expect(liveNew.companyName).toBe(NEW.companyName);

    // --- EINGEFROREN (Snapshot vorhanden = versendet/storniert) → OLD-Werte.
    const frozen = await buildInvoicePdfData(invoiceRow, liveNew, { snapshot: OLD_SNAPSHOT });
    expect(frozen.isPflegekasseInvoice, "Pflegekassen-Rechnung").toBe(true);
    const fp = frozen.pdfData;
    expect(fp.companyName, "companyName eingefroren").toBe(OLD.companyName);
    expect(fp.iban, "IBAN eingefroren").toBe(OLD.iban);
    expect(fp.bic, "BIC eingefroren").toBe(OLD.bic);
    expect(fp.bankName, "bankName eingefroren").toBe(OLD.bankName);
    expect(fp.bankAccountHolder, "Kontoinhaber eingefroren").toBe(OLD.bankAccountHolder);
    expect(fp.steuernummer, "Steuernummer eingefroren").toBe(OLD.steuernummer);
    expect(fp.ustId, "USt-ID eingefroren").toBe(OLD.ustId);
    expect(fp.ikNummer, "IK-Nr eingefroren").toBe(OLD.ikNummer);
    expect(fp.geschaeftsfuehrer, "Geschäftsführer eingefroren").toBe(OLD.geschaeftsfuehrer);
    expect(fp.companyAddress, "Firmen-Anschrift eingefroren (Stadt)").toContain(OLD.stadt);
    // Die NEUEN Live-Werte dürfen im eingefrorenen Render NICHT erscheinen.
    expect(fp.companyName).not.toBe(NEW.companyName);
    expect(fp.iban).not.toBe(NEW.iban);
    expect(fp.bankName).not.toBe(NEW.bankName);
    expect(fp.steuernummer).not.toBe(NEW.steuernummer);

    // --- ENTWURF (kein Snapshot) → übernimmt die NEUEN Live-Werte.
    const draft = await buildInvoicePdfData(invoiceRow, liveNew);
    const dp = draft.pdfData;
    expect(dp.companyName, "Entwurf: companyName = NEU").toBe(NEW.companyName);
    expect(dp.iban, "Entwurf: IBAN = NEU").toBe(NEW.iban);
    expect(dp.bic, "Entwurf: BIC = NEU").toBe(NEW.bic);
    expect(dp.bankName, "Entwurf: bankName = NEU").toBe(NEW.bankName);
    expect(dp.bankAccountHolder, "Entwurf: Kontoinhaber = NEU").toBe(NEW.bankAccountHolder);
    expect(dp.steuernummer, "Entwurf: Steuernummer = NEU").toBe(NEW.steuernummer);
    expect(dp.ustId, "Entwurf: USt-ID = NEU").toBe(NEW.ustId);
    expect(dp.ikNummer, "Entwurf: IK-Nr = NEU").toBe(NEW.ikNummer);
    expect(dp.geschaeftsfuehrer, "Entwurf: Geschäftsführer = NEU").toBe(NEW.geschaeftsfuehrer);
    expect(dp.companyAddress, "Entwurf: Firmen-Anschrift = NEU (Stadt)").toContain(NEW.stadt);
    // Sicherstellen, dass OLD und NEW tatsächlich verschieden sind.
    expect(OLD.iban).not.toBe(NEW.iban);
    expect(OLD.companyName).not.toBe(NEW.companyName);
  }, 60_000);

  it("(2) renderLeistungsnachweisOnTheFly: Snapshot-Rechnung zeigt eingefrorenen Firmennamen, Entwurf den NEUEN", async () => {
    // Versendet (renderSnapshot gesetzt) → On-the-fly-LN trägt OLD.
    const frozenInvoice = { ...invoiceRow, renderSnapshot: OLD_SNAPSHOT } as typeof invoiceRow;
    const frozenLn = await renderLeistungsnachweisOnTheFly(frozenInvoice);
    expect(frozenLn.length, "LN-PDF-Bytes nicht leer").toBeGreaterThan(0);
    const frozenText = await extractPdfText(frozenLn);
    expect(frozenText, "On-the-fly-LN (versendet) trägt den EINGEFRORENEN Firmennamen").toContain(OLD.companyName);
    expect(frozenText, "On-the-fly-LN (versendet) trägt NICHT den NEUEN Firmennamen").not.toContain(NEW.companyName);

    // Entwurf (kein renderSnapshot) → On-the-fly-LN trägt die NEUEN Live-Werte.
    const draftInvoice = { ...invoiceRow, renderSnapshot: null } as typeof invoiceRow;
    const draftLn = await renderLeistungsnachweisOnTheFly(draftInvoice);
    const draftText = await extractPdfText(draftLn);
    expect(draftText, "On-the-fly-LN (Entwurf) trägt den NEUEN Firmennamen").toContain(NEW.companyName);
    expect(draftText, "On-the-fly-LN (Entwurf) trägt NICHT den eingefrorenen Firmennamen").not.toContain(OLD.companyName);
  }, 120_000);

  it("(3) renderLeistungsnachweisOnly (LN-Backfill via persistInvoicePdf): friert den Firmennamen ein", async () => {
    // Sicherstellen: Snapshot=OLD, LN-Cache leer (pdfPath bleibt gesetzt) →
    // persistInvoicePdf nimmt den `renderLeistungsnachweisOnly`-Zweig.
    await db.update(invoicesTable)
      .set({ renderSnapshot: OLD_SNAPSHOT, leistungsnachweisPath: null, leistungsnachweisHash: null })
      .where(eq(invoicesTable.id, invoiceId));

    await persistInvoicePdf(invoiceId);

    const reloaded = await storage.getInvoice(invoiceId);
    expect(reloaded!.leistungsnachweisPath, "LN-Backfill hat einen Pfad persistiert").toBeTruthy();
    const lnBytes = await loadLeistungsnachweisPdfFromStorage(reloaded!);
    expect(lnBytes, "persistierte LN-Bytes geladen").toBeTruthy();
    const text = await extractPdfText(lnBytes!);
    expect(text, "Backfill-LN trägt den EINGEFRORENEN Firmennamen").toContain(OLD.companyName);
    expect(text, "Backfill-LN trägt NICHT den NEUEN Firmennamen (Live)").not.toContain(NEW.companyName);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Task #1036 — LN-Stammadresse auf dem ON-DEMAND-Render-Pfad des Versands.
//
// Task #1034 wärmt vor `POST /api/billing/:id/send` über die Bündel-Route den
// PDF-Cache, sodass der emailte LN-Anhang aus dem persistierten Cache geliefert
// wird. Damit blieb der Cache-MISS-Pfad ungetestet: wenn `/send` selbst den LN
// on-demand (Chromium) rendern muss, baut die Route `pdfData` über
// `buildPdfData` + `applyCustomerPdfRecipient` — NICHT über `buildInvoicePdfData`
// (wo die #1032-Korrektur lebt). Eine Regression dort würde die FALSCHE
// (Pflegekassen-)Anschrift verschicken, während der gecachte-Pfad-Test grün
// bleibt.
//
// Dieser Test treibt `/send` OHNE Vorwärmung (kein Bündel-Call) und löscht
// zusätzlich vor dem Versand den persistierten LN-Pfad → erzwingt den
// on-demand-Render. Der TATSÄCHLICH versandte LN-Anhang (Bytes aus dem Test-
// Outbox-Stub) wird text-extrahiert und positiv auf die Kunden-Stammadresse,
// negativ auf die Kassen-Anschrift geprüft.
// ---------------------------------------------------------------------------
describe("Task #1036 — LN-Stammadresse auf dem on-demand Versand-Render", () => {
  const YEAR = 2026;
  const SEND_MONTH = 7;

  // Unverwechselbare Stammadresse (kollidiert nicht mit Kasse oder anderen Suiten).
  const MASTER_STRASSE = "Ondemandweg";
  const MASTER_NR = "11";
  const MASTER_PLZ = "01187";
  const MASTER_STADT = "Dresden-Ondemandort";

  // Unverwechselbare Kassen-Anschrift — diese DARF im freistehenden LN NICHT
  // auftauchen.
  const KASSE_STRASSE = "Ondemandkassenallee";
  const KASSE_NR = "5";
  const KASSE_PLZ = "99990";
  const KASSE_STADT = "Ondemandkassenstadt";

  let customerId: number;
  let employeeId: number;
  let hwServiceId: number;
  let insuranceProviderId: number;
  let kasseEmail: string;
  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();
    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    kasseEmail = `kasse-ondemand-${uniqueId()}@test.local`;
    const ik = String(Math.floor(100000000 + Math.random() * 900000000));
    const provRes = await apiPost<{ id: number }>("/api/admin/insurance-providers", {
      name: `Ondemand-Kasse ${uniqueId()}`,
      isPrivate: false,
      ikNummer: ik,
      strasse: KASSE_STRASSE,
      hausnummer: KASSE_NR,
      plz: KASSE_PLZ,
      stadt: KASSE_STADT,
      email: kasseEmail,
      emailInvoiceEnabled: true,
    });
    expect(provRes.status, `create provider: ${JSON.stringify(provRes.data)}`).toBe(201);
    insuranceProviderId = provRes.data.id;

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Ondemand",
      nachname: `LN-${uniqueId()}`,
      geburtsdatum: "1939-02-02",
      email: `ondemand-ln-${uniqueId()}@test.local`,
      strasse: MASTER_STRASSE,
      nr: MASTER_NR,
      plz: MASTER_PLZ,
      stadt: MASTER_STADT,
      telefon: "+4917600000005",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "O" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ nachnamePrefix: "OndemandLN_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${SEND_MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // SMTP-Dummy-Konfig (siehe #1034): `ensureSmtpConfigured` läuft VOR der
    // Stub-Weiche, daher müssen die Felder gesetzt sein, sonst schlägt /send
    // auch im Test-Stub fehl.
    const smtpRes = await apiPatch(`/api/company-settings`, {
      smtpHost: "smtp.test.local",
      smtpPort: "587",
      smtpUser: "outbox@test.local",
      smtpPass: "stub-secret",
      smtpFromEmail: "absender@test.local",
      smtpFromName: "CareConnect Test",
    });
    expect(smtpRes.status, `smtp-config: ${JSON.stringify(smtpRes.data)}`).toBe(200);
  });

  afterAll(async () => {
    for (const id of cleanupInvoiceIds) {
      try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch { /* best-effort */ }
    }
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  it("emailter LN (Cache-MISS → on-demand-Render) trägt die Kunden-Stammadresse, NICHT die Kasse", async () => {
    // --- Signierten, gesetzlich gedeckten Entwurf erzeugen (ohne Bündel-/
    //     Leistungsnachweis-Call → der PDF-Cache bleibt KALT).
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-0${SEND_MONTH}-08`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `OndemandLN-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Repro" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: SEND_MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: SEND_MONTH, billingYear: YEAR,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    const invoiceId: number = invData.id;
    expect(invoiceId, "Rechnung muss eine id haben").toBeTruthy();
    cleanupInvoiceIds.push(invoiceId);

    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice, `getInvoice(${invoiceId})`).toBeTruthy();
    expect(invoice!.billingType, "Rechnung bleibt pflegekasse_gesetzlich").toBe("pflegekasse_gesetzlich");
    const invoiceNumber = invoice!.invoiceNumber;

    const expectedMaster = formatCustomerMasterAddress({
      strasse: MASTER_STRASSE, nr: MASTER_NR, plz: MASTER_PLZ, stadt: MASTER_STADT,
    });
    expect(expectedMaster, "Stammadresse darf nicht leer sein").toBeTruthy();
    // Voraussetzung: recipientAddress = Kassen-Anschrift (≠ Stammadresse), sonst
    // wäre der Negativ-Test wertlos.
    expect(invoice!.recipientAddress ?? "", "recipientAddress = Kassen-Anschrift").toContain(KASSE_STADT);
    expect(invoice!.recipientAddress ?? "").not.toContain(MASTER_STRASSE);

    // --- Cache-MISS deterministisch erzwingen: generate persistiert das LN-PDF
    //     NICHT; zusätzlich räumen wir hier explizit pdfPath/leistungsnachweisPath
    //     ab, damit `/send` den LN garantiert on-demand rendert (nicht aus dem
    //     Cache liest). Draft-Path-Updates sind GoBD-Trigger-erlaubt (persist
    //     schreibt dieselben Spalten ohne Bypass).
    await db.update(invoicesTable)
      .set({ pdfPath: null, leistungsnachweisPath: null })
      .where(eq(invoicesTable.id, invoiceId));
    const cold = await storage.getInvoice(invoiceId);
    expect(cold!.leistungsnachweisPath ?? null, "LN-Cache muss vor /send leer sein (Cache-MISS)").toBeNull();

    // --- Versand → E-Mail an die Pflegekasse mit on-demand gerendertem LN.
    await clearTestOutbox();
    const sendRes = await apiPost<any>(`/api/billing/${invoiceId}/send`, {});
    expect(sendRes.status, `send: ${JSON.stringify(sendRes.data)}`).toBe(200);

    const outbox = await getTestOutbox();
    const lnAttachmentName = `LN-${invoiceNumber}.pdf`;
    const msg = outbox.find((m) => m.attachmentNames.includes(lnAttachmentName));
    expect(msg, `Versand-Mail mit Anhang ${lnAttachmentName} muss im Postausgang liegen`).toBeTruthy();
    expect(msg!.to, "Empfänger = Pflegekassen-E-Mail").toBe(kasseEmail);

    // KERN: die TATSÄCHLICH versandten LN-Bytes aus dem Outbox-Stub extrahieren.
    const lnAtt = msg!.attachments.find((a) => a.filename === lnAttachmentName);
    expect(lnAtt, "LN-Anhang-Bytes müssen im Stub-Outbox vorliegen").toBeTruthy();
    const lnBytes = Buffer.from(lnAtt!.contentBase64, "base64");
    expect(lnBytes.length, "LN-Anhang darf nicht leer sein").toBeGreaterThan(0);
    const lnText = await extractPdfText(lnBytes);

    // Positiv: der on-demand gerenderte, versandte LN trägt die Stammadresse.
    expect(lnText, "on-demand versandter LN enthält die Stamm-Straße").toContain(MASTER_STRASSE);
    expect(lnText, "on-demand versandter LN enthält den Stamm-Ort").toContain(MASTER_STADT);
    // Negativ: die Kassen-Anschrift darf im freistehenden LN nicht erscheinen.
    expect(lnText, "on-demand versandter LN zeigt NICHT die Kassen-Straße").not.toContain(KASSE_STRASSE);
    expect(lnText, "on-demand versandter LN zeigt NICHT den Kassen-Ort").not.toContain(KASSE_STADT);

    const afterSend = await storage.getInvoice(invoiceId);
    expect(afterSend!.status, "nach Versand: Status versendet").toBe("versendet");
  }, 240_000);
});

// ---------------------------------------------------------------------------
// Task #1040 — LN-Stammadresse auf dem BATCH/Stapel-Versand-Render-Pfad.
//
// Task #1036 sichert die Kunden-Stammadresse für den EINZEL-Versand
// (`POST /api/billing/:id/send`) auf dem Cache-MISS/on-demand-Render-Pfad ab.
// Die Stapel-Route (`POST /api/billing/send-batch`) baut `pdfData` über
// denselben Helfer (`buildPdfData` + `applyCustomerPdfRecipient` in
// `server/services/invoice-delivery.ts`), hat aber bislang keinen eigenen
// Route-Test. Eine Regression, die `applyCustomerPdfRecipient` in der
// Batch-Route umgeht, würde die FALSCHE (Pflegekassen-)Anschrift an viele
// Kunden GLEICHZEITIG verschicken und trotzdem grün bleiben.
//
// Dieser Test treibt `send-batch` OHNE Vorwärmung (kein Bündel-Call) und
// löscht zusätzlich vor dem Versand den persistierten LN-Pfad → erzwingt den
// on-demand-Render. Der TATSÄCHLICH versandte LN-Anhang (Bytes aus dem Test-
// Outbox-Stub) wird text-extrahiert und positiv auf die Kunden-Stammadresse,
// negativ auf die Kassen-Anschrift geprüft.
// ---------------------------------------------------------------------------
describe("Task #1040 — LN-Stammadresse auf dem Stapel-Versand-Render (send-batch)", () => {
  const YEAR = 2026;
  const SEND_MONTH = 9;

  // Unverwechselbare Stammadresse (kollidiert nicht mit Kasse oder anderen Suiten).
  const MASTER_STRASSE = "Stapelweg";
  const MASTER_NR = "22";
  const MASTER_PLZ = "01237";
  const MASTER_STADT = "Dresden-Stapelort";

  // Unverwechselbare Kassen-Anschrift — diese DARF im freistehenden LN NICHT
  // auftauchen.
  const KASSE_STRASSE = "Stapelkassenallee";
  const KASSE_NR = "9";
  const KASSE_PLZ = "99980";
  const KASSE_STADT = "Stapelkassenstadt";

  let customerId: number;
  let employeeId: number;
  let hwServiceId: number;
  let insuranceProviderId: number;
  let kasseEmail: string;
  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();
    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    kasseEmail = `kasse-stapel-${uniqueId()}@test.local`;
    const ik = String(Math.floor(100000000 + Math.random() * 900000000));
    const provRes = await apiPost<{ id: number }>("/api/admin/insurance-providers", {
      name: `Stapel-Kasse ${uniqueId()}`,
      isPrivate: false,
      ikNummer: ik,
      strasse: KASSE_STRASSE,
      hausnummer: KASSE_NR,
      plz: KASSE_PLZ,
      stadt: KASSE_STADT,
      email: kasseEmail,
      emailInvoiceEnabled: true,
    });
    expect(provRes.status, `create provider: ${JSON.stringify(provRes.data)}`).toBe(201);
    insuranceProviderId = provRes.data.id;

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Stapel",
      nachname: `LN-${uniqueId()}`,
      geburtsdatum: "1938-03-03",
      email: `stapel-ln-${uniqueId()}@test.local`,
      strasse: MASTER_STRASSE,
      nr: MASTER_NR,
      plz: MASTER_PLZ,
      stadt: MASTER_STADT,
      telefon: "+4917600000006",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "S" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ nachnamePrefix: "StapelLN_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${SEND_MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // SMTP-Dummy-Konfig (siehe #1034/#1036): `ensureSmtpConfigured` läuft VOR
    // der Stub-Weiche, daher müssen die Felder gesetzt sein, sonst schlägt der
    // Versand auch im Test-Stub fehl.
    const smtpRes = await apiPatch(`/api/company-settings`, {
      smtpHost: "smtp.test.local",
      smtpPort: "587",
      smtpUser: "outbox@test.local",
      smtpPass: "stub-secret",
      smtpFromEmail: "absender@test.local",
      smtpFromName: "CareConnect Test",
    });
    expect(smtpRes.status, `smtp-config: ${JSON.stringify(smtpRes.data)}`).toBe(200);
  });

  afterAll(async () => {
    for (const id of cleanupInvoiceIds) {
      try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch { /* best-effort */ }
    }
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  it("emailter LN aus send-batch (Cache-MISS → on-demand-Render) trägt die Kunden-Stammadresse, NICHT die Kasse", async () => {
    // --- Signierten, gesetzlich gedeckten Entwurf erzeugen (ohne Bündel-/
    //     Leistungsnachweis-Call → der PDF-Cache bleibt KALT).
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-0${SEND_MONTH}-08`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `StapelLN-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Repro" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: SEND_MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: SEND_MONTH, billingYear: YEAR,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    const invoiceId: number = invData.id;
    expect(invoiceId, "Rechnung muss eine id haben").toBeTruthy();
    cleanupInvoiceIds.push(invoiceId);

    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice, `getInvoice(${invoiceId})`).toBeTruthy();
    expect(invoice!.billingType, "Rechnung bleibt pflegekasse_gesetzlich").toBe("pflegekasse_gesetzlich");
    const invoiceNumber = invoice!.invoiceNumber;

    const expectedMaster = formatCustomerMasterAddress({
      strasse: MASTER_STRASSE, nr: MASTER_NR, plz: MASTER_PLZ, stadt: MASTER_STADT,
    });
    expect(expectedMaster, "Stammadresse darf nicht leer sein").toBeTruthy();
    // Voraussetzung: recipientAddress = Kassen-Anschrift (≠ Stammadresse), sonst
    // wäre der Negativ-Test wertlos.
    expect(invoice!.recipientAddress ?? "", "recipientAddress = Kassen-Anschrift").toContain(KASSE_STADT);
    expect(invoice!.recipientAddress ?? "").not.toContain(MASTER_STRASSE);

    // --- Cache-MISS deterministisch erzwingen: generate persistiert das LN-PDF
    //     NICHT; zusätzlich räumen wir hier explizit pdfPath/leistungsnachweisPath
    //     ab, damit `send-batch` den LN garantiert on-demand rendert (nicht aus
    //     dem Cache liest). Draft-Path-Updates sind GoBD-Trigger-erlaubt.
    await db.update(invoicesTable)
      .set({ pdfPath: null, leistungsnachweisPath: null })
      .where(eq(invoicesTable.id, invoiceId));
    const cold = await storage.getInvoice(invoiceId);
    expect(cold!.leistungsnachweisPath ?? null, "LN-Cache muss vor send-batch leer sein (Cache-MISS)").toBeNull();

    // --- Stapel-Versand → E-Mail an die Pflegekasse mit on-demand gerendertem LN.
    await clearTestOutbox();
    const sendRes = await apiPost<any>(`/api/billing/send-batch`, { invoiceIds: [invoiceId] });
    expect(sendRes.status, `send-batch: ${JSON.stringify(sendRes.data)}`).toBe(200);
    const batchResults = sendRes.data?.results ?? sendRes.data;
    const sentEntry = (Array.isArray(batchResults) ? batchResults : []).find((r: any) => r.invoiceId === invoiceId);
    expect(sentEntry, `Batch-Ergebnis für Rechnung ${invoiceId}: ${JSON.stringify(sendRes.data)}`).toBeTruthy();
    expect(sentEntry!.status, `Batch-Versand-Status: ${JSON.stringify(sentEntry)}`).toBe("sent");

    const outbox = await getTestOutbox();
    const lnAttachmentName = `LN-${invoiceNumber}.pdf`;
    const msg = outbox.find((m) => m.attachmentNames.includes(lnAttachmentName));
    expect(msg, `Versand-Mail mit Anhang ${lnAttachmentName} muss im Postausgang liegen`).toBeTruthy();
    expect(msg!.to, "Empfänger = Pflegekassen-E-Mail").toBe(kasseEmail);

    // KERN: die TATSÄCHLICH versandten LN-Bytes aus dem Outbox-Stub extrahieren.
    const lnAtt = msg!.attachments.find((a) => a.filename === lnAttachmentName);
    expect(lnAtt, "LN-Anhang-Bytes müssen im Stub-Outbox vorliegen").toBeTruthy();
    const lnBytes = Buffer.from(lnAtt!.contentBase64, "base64");
    expect(lnBytes.length, "LN-Anhang darf nicht leer sein").toBeGreaterThan(0);
    const lnText = await extractPdfText(lnBytes);

    // Positiv: der on-demand gerenderte, versandte LN trägt die Stammadresse.
    expect(lnText, "on-demand versandter LN enthält die Stamm-Straße").toContain(MASTER_STRASSE);
    expect(lnText, "on-demand versandter LN enthält den Stamm-Ort").toContain(MASTER_STADT);
    // Negativ: die Kassen-Anschrift darf im freistehenden LN nicht erscheinen.
    expect(lnText, "on-demand versandter LN zeigt NICHT die Kassen-Straße").not.toContain(KASSE_STRASSE);
    expect(lnText, "on-demand versandter LN zeigt NICHT den Kassen-Ort").not.toContain(KASSE_STADT);

    const afterSend = await storage.getInvoice(invoiceId);
    expect(afterSend!.status, "nach Stapel-Versand: Status versendet").toBe("versendet");
  }, 240_000);
});

// ---------------------------------------------------------------------------
// Task #1046 — Postversand der Kunden-KOPIE (Brief) trägt die Patient-
// Stammadresse, und die Zustell-Empfänger-Adresse ist der KUNDE (NICHT die
// Pflegekasse).
//
// Für `receivesMonthlyInvoice=true` + `documentDeliveryMethod="post"` baut die
// Versand-Route (`POST /api/billing/:id/send`) nach dem Kassen-Versand eine
// Kunden-Kopie als BRIEF: `buildCustomerPostAddress(cust)` (= Kunden-Stamm-
// adresse) plus `sendInvoiceCopyByPost` (Anschreiben + Rechnung + LN →
// LetterXpress `/setJob`). Die Zustell-Adresse (`document_deliveries.
// recipient_address`) wird NUR bei LetterXpress-Erfolg persistiert. Gegen den
// laufenden Server lässt sich der echte LetterXpress-fetch NICHT abfangen —
// deshalb wird hier die ECHTE Billing-Route IN-PROCESS gemountet und nur der
// LetterXpress-Host über einen globalen fetch-Dispatcher gemockt (alles andere
// läuft unverändert über den echten fetch gegen localhost).
//
// Eine Regression, die den Kunden-Brief versehentlich an die Pflegekassen-
// Anschrift adressiert (oder den LN mit Kassen-Anschrift füllt), würde Kunden-
// Post an die falsche Adresse schicken und trotzdem grün bleiben.
//
// HINWEIS zum Negativ-Test: der kombinierte Brief enthält die Rechnungsseite,
// die LEGITIM die Kassen-Anschrift trägt. Der Negativ-Test ("keine Kasse")
// wird daher auf dem ISOLIERTEN LN-Anhang (identischer Buffer wie in der
// Kassen-Mail) UND auf der persistierten Zustell-Adresse geführt, nicht auf
// dem gesamten Brief.
// ---------------------------------------------------------------------------
describe("Task #1046 — Post-Kopie an Kunde: LN trägt Stammadresse, Empfänger = Kunde", () => {
  const YEAR = 2026;
  const SEND_MONTH = 11;

  // Unverwechselbare Stammadresse (kollidiert nicht mit Kasse oder anderen Suiten).
  const MASTER_STRASSE = "Briefkopieweg";
  const MASTER_NR = "33";
  const MASTER_PLZ = "01069";
  const MASTER_STADT = "Dresden-Briefkopieort";

  // Unverwechselbare Kassen-Anschrift — diese DARF im isolierten LN / in der
  // Zustell-Adresse NICHT auftauchen.
  const KASSE_STRASSE = "Briefkopiekassenallee";
  const KASSE_NR = "7";
  const KASSE_PLZ = "99970";
  const KASSE_STADT = "Briefkopiekassenstadt";

  let customerId: number;
  let employeeId: number;
  let hwServiceId: number;
  let insuranceProviderId: number;
  let kasseEmail: string;
  let adminUserId: number;
  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  // --- In-Process-Mount der echten Billing-Route + LetterXpress-fetch-Mock ---
  const LX_HOST = "api.letterxpress.de";
  const LX_LETTER_ID = `lx-1046-${Date.now()}`;
  let realFetch: typeof fetch;
  const lxCalls: Array<{ url: string; body: string }> = [];
  const dispatchFetch = ((input: unknown, init?: unknown) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.toString()
      : (input as { url?: string })?.url ?? String(input);
    if (url.includes(LX_HOST)) {
      const body = (init as { body?: unknown } | undefined)?.body;
      lxCalls.push({ url, body: typeof body === "string" ? body : String(body ?? "") });
      return Promise.resolve(
        new Response(
          JSON.stringify({ status: 200, message: "OK", data: { letter_id: LX_LETTER_ID } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return realFetch(input as RequestInfo, init as RequestInit);
  }) as typeof fetch;

  let server: Server | null = null;
  let localBaseUrl = "";

  async function startInProcessBilling(): Promise<void> {
    const { default: billingRouter } = await import("../../server/routes/billing");
    const app = express();
    app.use(express.json({ limit: "50mb" }));
    // Fake-Auth: echter Superadmin (gültige DB-id für Audit-FKs) VOR den
    // router-internen requireAuth/requireAdmin.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: UserWithRoles }).user = {
        id: adminUserId, isAdmin: true, isSuperAdmin: true, roles: [],
      } as unknown as UserWithRoles;
      next();
    });
    app.use("/api/billing", billingRouter);
    // 4-arg Error-Handler: macht AppError-Status/JSON sichtbar.
    app.use((err: { statusCode?: number; status?: number; code?: string; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
      const status = err?.statusCode ?? err?.status ?? 500;
      res.status(status).json({ code: err?.code ?? "SERVER_ERROR", message: err?.message ?? String(err) });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server!.address() as AddressInfo;
    localBaseUrl = `http://127.0.0.1:${addr.port}`;
  }

  beforeAll(async () => {
    const auth = await getAuthCookie();
    adminUserId = auth.user.id;

    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    kasseEmail = `kasse-briefkopie-${uniqueId()}@test.local`;
    const ik = String(Math.floor(100000000 + Math.random() * 900000000));
    const provRes = await apiPost<{ id: number }>("/api/admin/insurance-providers", {
      name: `Briefkopie-Kasse ${uniqueId()}`,
      isPrivate: false,
      ikNummer: ik,
      strasse: KASSE_STRASSE,
      hausnummer: KASSE_NR,
      plz: KASSE_PLZ,
      stadt: KASSE_STADT,
      email: kasseEmail,
      emailInvoiceEnabled: true,
    });
    expect(provRes.status, `create provider: ${JSON.stringify(provRes.data)}`).toBe(201);
    insuranceProviderId = provRes.data.id;

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Briefkopie",
      nachname: `LN-${uniqueId()}`,
      geburtsdatum: "1937-04-04",
      email: `briefkopie-ln-${uniqueId()}@test.local`,
      strasse: MASTER_STRASSE,
      nr: MASTER_NR,
      plz: MASTER_PLZ,
      stadt: MASTER_STADT,
      telefon: "+4917600000007",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "B" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    // Kunden-Kopie per BRIEF aktivieren (Felder nicht im Create-Payload → direkt
    // setzen; Kunden sind nicht GoBD-Trigger-geschützt).
    await db.update(customersTable)
      .set({ receivesMonthlyInvoice: true, documentDeliveryMethod: "post" })
      .where(eq(customersTable.id, customerId));

    const emp = await createTestEmployee({ nachnamePrefix: "BriefkopieLN_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-${SEND_MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // SMTP-Dummy (Kassen-Mail-Stub-Weiche) + LetterXpress-Creds (Postversand).
    // letterxpressTestMode=true → print:"test".
    const settingsRes = await apiPatch(`/api/company-settings`, {
      smtpHost: "smtp.test.local",
      smtpPort: "587",
      smtpUser: "outbox@test.local",
      smtpPass: "stub-secret",
      smtpFromEmail: "absender@test.local",
      smtpFromName: "CareConnect Test",
      letterxpressUsername: "lx-user",
      letterxpressApiKey: "lx-key",
      letterxpressTestMode: true,
    });
    expect(settingsRes.status, `settings: ${JSON.stringify(settingsRes.data)}`).toBe(200);

    realFetch = globalThis.fetch.bind(globalThis);
    await startInProcessBilling();
    vi.stubGlobal("fetch", dispatchFetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const id of cleanupInvoiceIds) {
      try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch { /* best-effort */ }
    }
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  it("Brief-Kopie: LN trägt Stammadresse, Brief wird abgesetzt, Zustell-Adresse = Kunde (nicht Kasse)", async () => {
    // --- Signierten, gesetzlich gedeckten Entwurf erzeugen (ohne Bündel-Call
    //     → PDF-Cache bleibt kalt).
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-${SEND_MONTH}-09`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `BriefkopieLN-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt(post): ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Repro" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: SEND_MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: SEND_MONTH, billingYear: YEAR,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    const invoiceId: number = invData.id;
    expect(invoiceId, "Rechnung muss eine id haben").toBeTruthy();
    cleanupInvoiceIds.push(invoiceId);

    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice, `getInvoice(${invoiceId})`).toBeTruthy();
    expect(invoice!.billingType, "Rechnung bleibt pflegekasse_gesetzlich").toBe("pflegekasse_gesetzlich");
    const invoiceNumber = invoice!.invoiceNumber;

    // Voraussetzung: Rechnungs-Empfänger = Kasse (≠ Stammadresse), sonst wäre
    // der Negativ-Test wertlos.
    expect(invoice!.recipientAddress ?? "", "recipientAddress = Kassen-Anschrift").toContain(KASSE_STADT);
    expect(invoice!.recipientAddress ?? "").not.toContain(MASTER_STRASSE);

    // --- Cache-MISS erzwingen → /send rendert Rechnung + LN on-demand.
    await db.update(invoicesTable)
      .set({ pdfPath: null, leistungsnachweisPath: null })
      .where(eq(invoicesTable.id, invoiceId));
    const cold = await storage.getInvoice(invoiceId);
    expect(cold!.leistungsnachweisPath ?? null, "LN-Cache muss vor /send leer sein (Cache-MISS)").toBeNull();

    // Test-Prozess-Caches/Outbox/LX-Aufrufe zurücksetzen, damit die in-process
    // Route SMTP+LetterXpress frisch aus der DB lädt.
    companySettingsCache.invalidate();
    clearLocalOutbox();
    lxCalls.length = 0;

    // --- Versand über die IN-PROCESS gemountete echte Billing-Route ---
    const sendResp = await realFetch(`${localBaseUrl}/api/billing/${invoiceId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const sendJson: any = await sendResp.json();
    expect(sendResp.status, `send: ${JSON.stringify(sendJson)}`).toBe(200);

    // (1) Post-Kopie-Ergebnis vorhanden + genau ein LetterXpress-/setJob-Aufruf.
    const postResult = (sendJson.results ?? []).find((r: any) => r.customerCopy && r.status === "post_sent");
    expect(postResult, `Post-Kopie-Ergebnis: ${JSON.stringify(sendJson.results)}`).toBeTruthy();
    expect(postResult!.letterxpressLetterId, "Letter-ID vom LetterXpress-Stub").toBe(LX_LETTER_ID);
    expect(lxCalls.length, "genau ein LetterXpress-/setJob-Aufruf").toBe(1);
    expect(lxCalls[0].url, "LetterXpress-Pfad /setJob").toContain("/setJob");

    // (2) Der kombinierte Brief (Anschreiben + Rechnung + LN) enthält die
    //     Kunden-Stammadresse (Anschreiben-Adressfenster + LN-Leistungsempfänger).
    const lxBody = JSON.parse(lxCalls[0].body);
    const combinedBase64: string = lxBody?.letter?.base64_file ?? "";
    expect(combinedBase64.length, "base64_file im LetterXpress-Payload").toBeGreaterThan(0);
    const combinedBytes = Buffer.from(combinedBase64, "base64");
    expect(await pageCount(combinedBytes), "Brief = Anschreiben + Rechnung + LN (≥3 Seiten)").toBeGreaterThanOrEqual(3);
    const combinedText = await extractPdfText(combinedBytes);
    expect(combinedText, "Brief enthält die Stamm-Straße").toContain(MASTER_STRASSE);
    expect(combinedText, "Brief enthält den Stamm-Ort").toContain(MASTER_STADT);

    // (3) Der LN selbst (identischer Buffer wie in der Kassen-Mail) trägt die
    //     Stammadresse und NICHT die Kassen-Anschrift. Im kombinierten Brief
    //     erscheint die Kasse legitim auf der Rechnungsseite — daher Negativ-Test
    //     auf dem isolierten LN-Anhang.
    const localOutbox = getLocalOutbox();
    const lnAttachmentName = `LN-${invoiceNumber}.pdf`;
    const kasseMsg = localOutbox.find((m) => m.to === kasseEmail && m.attachmentNames.includes(lnAttachmentName));
    expect(
      kasseMsg,
      `Kassen-Mail mit ${lnAttachmentName}: ${JSON.stringify(localOutbox.map((m) => ({ to: m.to, names: m.attachmentNames })))}`,
    ).toBeTruthy();
    const lnAtt = kasseMsg!.attachments.find((a) => a.filename === lnAttachmentName);
    expect(lnAtt, "LN-Anhang-Bytes im Stub-Outbox").toBeTruthy();
    const lnBytes = Buffer.from(lnAtt!.contentBase64, "base64");
    expect(lnBytes.length, "LN-Anhang darf nicht leer sein").toBeGreaterThan(0);
    const lnText = await extractPdfText(lnBytes);
    expect(lnText, "LN trägt die Stamm-Straße").toContain(MASTER_STRASSE);
    expect(lnText, "LN trägt den Stamm-Ort").toContain(MASTER_STADT);
    expect(lnText, "LN zeigt NICHT die Kassen-Straße").not.toContain(KASSE_STRASSE);
    expect(lnText, "LN zeigt NICHT den Kassen-Ort").not.toContain(KASSE_STADT);

    // (4) KERN — die persistierte Zustell-Adresse der Post-Kopie = KUNDE, nicht Kasse.
    const postDeliveries = await db.select().from(documentDeliveries)
      .where(and(eq(documentDeliveries.customerId, customerId), eq(documentDeliveries.deliveryMethod, "post")));
    expect(postDeliveries.length, "Post-Zustell-Eintrag muss existieren").toBeGreaterThanOrEqual(1);
    const postDelivery = postDeliveries.find((d) => d.letterxpressLetterId === LX_LETTER_ID) ?? postDeliveries[0];
    expect(postDelivery.status, "Post-Zustellung erfolgreich").toBe("sent");
    expect(postDelivery.recipientAddress ?? "", "Zustell-Adresse enthält Stamm-Straße").toContain(MASTER_STRASSE);
    expect(postDelivery.recipientAddress ?? "", "Zustell-Adresse enthält Stamm-Ort").toContain(MASTER_STADT);
    expect(postDelivery.recipientAddress ?? "", "Zustell-Adresse NICHT Kassen-Straße").not.toContain(KASSE_STRASSE);
    expect(postDelivery.recipientAddress ?? "", "Zustell-Adresse NICHT Kassen-Ort").not.toContain(KASSE_STADT);

    const afterSend = await storage.getInvoice(invoiceId);
    expect(afterSend!.status, "nach Versand: Status versendet").toBe("versendet");
  }, 240_000);
});

// ---------------------------------------------------------------------------
// Task #1046 (Ergänzung) — EMAIL-Kopie an den Kunden trägt die Patient-
// Stammadresse, und der Kopie-Empfänger ist der KUNDE (NICHT die Pflegekasse).
//
// Gegenstück zum Post-Pfad: für `receivesMonthlyInvoice=true` +
// `documentDeliveryMethod="email"` mailt `/send` zusätzlich eine Rechnungs-Kopie
// (Rechnung + LN) an die KUNDEN-E-Mail. Dieser Pfad braucht kein LetterXpress
// und läuft daher vollständig gegen den laufenden Server. Geprüft wird, dass der
// emailte LN die Stammadresse (nicht die Kasse) trägt und der Kopie-Empfänger
// die Kunden-E-Mail ist.
// ---------------------------------------------------------------------------
describe("Task #1046 (Ergänzung) — Email-Kopie an Kunde: LN trägt Stammadresse, Empfänger = Kunde", () => {
  const YEAR = 2026;
  const SEND_MONTH = 12;

  const MASTER_STRASSE = "Mailkopieweg";
  const MASTER_NR = "44";
  const MASTER_PLZ = "01099";
  const MASTER_STADT = "Dresden-Mailkopieort";

  const KASSE_STRASSE = "Mailkopiekassenallee";
  const KASSE_NR = "3";
  const KASSE_PLZ = "99960";
  const KASSE_STADT = "Mailkopiekassenstadt";

  let customerId: number;
  let employeeId: number;
  let hwServiceId: number;
  let insuranceProviderId: number;
  let kasseEmail: string;
  let customerEmail: string;
  const cleanupApptIds: number[] = [];
  const cleanupSrIds: number[] = [];
  const cleanupInvoiceIds: number[] = [];

  beforeAll(async () => {
    await getAuthCookie();
    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

    kasseEmail = `kasse-mailkopie-${uniqueId()}@test.local`;
    const ik = String(Math.floor(100000000 + Math.random() * 900000000));
    const provRes = await apiPost<{ id: number }>("/api/admin/insurance-providers", {
      name: `Mailkopie-Kasse ${uniqueId()}`,
      isPrivate: false,
      ikNummer: ik,
      strasse: KASSE_STRASSE,
      hausnummer: KASSE_NR,
      plz: KASSE_PLZ,
      stadt: KASSE_STADT,
      email: kasseEmail,
      emailInvoiceEnabled: true,
    });
    expect(provRes.status, `create provider: ${JSON.stringify(provRes.data)}`).toBe(201);
    insuranceProviderId = provRes.data.id;

    customerEmail = `mailkopie-ln-${uniqueId()}@test.local`;
    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Mailkopie",
      nachname: `LN-${uniqueId()}`,
      geburtsdatum: "1936-05-05",
      email: customerEmail,
      strasse: MASTER_STRASSE,
      nr: MASTER_NR,
      plz: MASTER_PLZ,
      stadt: MASTER_STADT,
      telefon: "+4917600000008",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: insuranceProviderId,
        versichertennummer: "M" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    // Kunden-Kopie per EMAIL aktivieren (documentDeliveryMethod bleibt Default
    // "email"; nur receivesMonthlyInvoice muss true sein).
    await db.update(customersTable)
      .set({ receivesMonthlyInvoice: true, documentDeliveryMethod: "email" })
      .where(eq(customersTable.id, customerId));

    const emp = await createTestEmployee({ nachnamePrefix: "MailkopieLN_Integ" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 13100,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-${SEND_MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    const smtpRes = await apiPatch(`/api/company-settings`, {
      smtpHost: "smtp.test.local",
      smtpPort: "587",
      smtpUser: "outbox@test.local",
      smtpPass: "stub-secret",
      smtpFromEmail: "absender@test.local",
      smtpFromName: "CareConnect Test",
    });
    expect(smtpRes.status, `smtp-config: ${JSON.stringify(smtpRes.data)}`).toBe(200);
  });

  afterAll(async () => {
    for (const id of cleanupInvoiceIds) {
      try { await db.delete(invoicesTable).where(eq(invoicesTable.id, id)); } catch { /* best-effort */ }
    }
    for (const id of cleanupSrIds) {
      try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
    }
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  it("Email-Kopie: emailter LN an die Kunden-Adresse trägt die Stammadresse, NICHT die Kasse", async () => {
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-${SEND_MONTH}-08`,
      scheduledStart: "10:00",
      scheduledEnd: "11:00",
      notes: `MailkopieLN-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: hwServiceId, durationMinutes: 60 }],
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    cleanupApptIds.push(apptRes.data.id);
    const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
      actualStart: "10:00",
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 60, details: "Repro" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: SEND_MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const genRes = await apiPost<any>("/api/billing/generate", {
      customerId, billingMonth: SEND_MONTH, billingYear: YEAR,
    });
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    const invData = Array.isArray(genRes.data) ? genRes.data[0]
      : genRes.data?.invoices ? genRes.data.invoices[0]
      : genRes.data;
    const invoiceId: number = invData.id;
    expect(invoiceId, "Rechnung muss eine id haben").toBeTruthy();
    cleanupInvoiceIds.push(invoiceId);

    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice, `getInvoice(${invoiceId})`).toBeTruthy();
    expect(invoice!.billingType, "Rechnung bleibt pflegekasse_gesetzlich").toBe("pflegekasse_gesetzlich");
    const invoiceNumber = invoice!.invoiceNumber;

    // Voraussetzung: Rechnungs-Empfänger = Kasse (≠ Stammadresse).
    expect(invoice!.recipientAddress ?? "", "recipientAddress = Kassen-Anschrift").toContain(KASSE_STADT);
    expect(invoice!.recipientAddress ?? "").not.toContain(MASTER_STRASSE);

    // Cache-MISS erzwingen → on-demand-Render.
    await db.update(invoicesTable)
      .set({ pdfPath: null, leistungsnachweisPath: null })
      .where(eq(invoicesTable.id, invoiceId));
    const cold = await storage.getInvoice(invoiceId);
    expect(cold!.leistungsnachweisPath ?? null, "LN-Cache muss vor /send leer sein (Cache-MISS)").toBeNull();

    await clearTestOutbox();
    const sendRes = await apiPost<any>(`/api/billing/${invoiceId}/send`, {});
    expect(sendRes.status, `send: ${JSON.stringify(sendRes.data)}`).toBe(200);

    // Kunden-Kopie-Ergebnis: Versand an die KUNDEN-E-Mail.
    const copyResult = (sendRes.data?.results ?? []).find((r: any) => r.customerCopy && r.status === "sent");
    expect(copyResult, `Kunden-Kopie-Ergebnis: ${JSON.stringify(sendRes.data?.results)}`).toBeTruthy();
    expect(copyResult!.recipientEmail, "Kopie-Empfänger = Kunden-E-Mail").toBe(customerEmail);

    const outbox = await getTestOutbox();
    const lnAttachmentName = `LN-${invoiceNumber}.pdf`;
    // Genau die KUNDEN-Kopie (nicht die Kassen-Mail) herausgreifen.
    const copyMsg = outbox.find((m) => m.to === customerEmail && m.attachmentNames.includes(lnAttachmentName));
    expect(
      copyMsg,
      `Kunden-Kopie-Mail mit ${lnAttachmentName}: ${JSON.stringify(outbox.map((m) => ({ to: m.to, names: m.attachmentNames })))}`,
    ).toBeTruthy();
    expect(copyMsg!.to, "Empfänger der Kopie = Kunde, nicht Kasse").not.toBe(kasseEmail);

    const lnAtt = copyMsg!.attachments.find((a) => a.filename === lnAttachmentName);
    expect(lnAtt, "LN-Anhang-Bytes der Kunden-Kopie").toBeTruthy();
    const lnBytes = Buffer.from(lnAtt!.contentBase64, "base64");
    expect(lnBytes.length, "LN-Anhang darf nicht leer sein").toBeGreaterThan(0);
    const lnText = await extractPdfText(lnBytes);
    expect(lnText, "LN der Kunden-Kopie trägt die Stamm-Straße").toContain(MASTER_STRASSE);
    expect(lnText, "LN der Kunden-Kopie trägt den Stamm-Ort").toContain(MASTER_STADT);
    expect(lnText, "LN der Kunden-Kopie zeigt NICHT die Kassen-Straße").not.toContain(KASSE_STRASSE);
    expect(lnText, "LN der Kunden-Kopie zeigt NICHT den Kassen-Ort").not.toContain(KASSE_STADT);

    // Zustell-Eintrag der Email-Kopie: Empfänger = Kunden-E-Mail.
    const emailDeliveries = await db.select().from(documentDeliveries)
      .where(and(eq(documentDeliveries.customerId, customerId), eq(documentDeliveries.deliveryMethod, "email")));
    const copyDelivery = emailDeliveries.find((d) => d.recipientEmail === customerEmail);
    expect(copyDelivery, `Email-Kopie-Zustell-Eintrag für ${customerEmail}`).toBeTruthy();
    expect(copyDelivery!.status, "Email-Kopie erfolgreich").toBe("sent");

    const afterSend = await storage.getInvoice(invoiceId);
    expect(afterSend!.status, "nach Versand: Status versendet").toBe("versendet");
  }, 240_000);
});
