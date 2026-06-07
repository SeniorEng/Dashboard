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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { storage } from "../../server/storage";
import {
  buildPdfData,
  enrichPdfDataWithSignatures,
  assertServiceRecordsScopedToInvoice,
  buildInvoicePdfBytes,
  buildInvoicePdfData,
} from "../../server/services/invoice-pdf-orchestrator";
import { generateLeistungsnachweisHtml } from "../../server/lib/pdf-generator";
import { formatCustomerMasterAddress } from "../../server/lib/customer-address-format";
import type { InvoiceRenderSnapshot } from "@shared/schema";
import { getCachedCompanySettings } from "../../server/services/cache";
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
  runCleanup,
  uniqueId,
} from "../test-utils";

async function pageCount(buf: Buffer): Promise<number> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(buf);
  return doc.getPageCount();
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
