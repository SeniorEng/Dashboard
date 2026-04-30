// Race-Conditions auf Rechnungsnummer-Vergabe + Storno-Atomarität.
// INC-1.1: 10 parallele POST /generate -> 10 eindeutige, lückenlose Nummern.
// INC-2.1: 5 parallele Storni -> 5 eindeutige Stornorechnungen ohne Waisen.
// INC-3.1: Direkte Tx mit Failure-Injection -> Rollback hinterlässt keine Stornorechnung.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";
import { db } from "../../server/lib/db";
import {
  getNextInvoiceNumberTx,
  createInvoiceTx,
  updateInvoiceStatusTx,
  getInvoiceLineItemsTx,
} from "../../server/storage/billing-storage";
import { invoices } from "../../shared/schema";
import { and, eq } from "drizzle-orm";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let testEmployeeId: number;
let hwServiceId: number;

const cleanupCustomerIds: number[] = [];
const cleanupServiceRecordIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftToWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}

async function findFreeSlotAndCreate(
  customerId: number,
  serviceId: number,
  durationMinutes: number,
  noteTag: string,
): Promise<{ id: number; date: string; time: string }> {
  for (let offset = 1; offset <= 60; offset++) {
    const candidate = new Date();
    candidate.setDate(candidate.getDate() - offset);
    shiftToWeekday(candidate);
    const dateStr = ymdLocal(candidate);
    for (const time of SEED_TIMES) {
      const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `INC-${noteTag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(`findFreeSlotAndCreate(${noteTag}): kein freier Slot`);
}

async function documentAppointment(
  appointmentId: number,
  startTime: string,
  serviceId: number,
  actualMinutes: number,
  details: string,
): Promise<void> {
  const res = await apiPost(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details }],
  });
  if (res.status !== 200) {
    throw new Error(`documentAppointment(${appointmentId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function createServiceRecord(customerId: number, year: number, month: number): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  if (res.status !== 201) {
    throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  cleanupServiceRecordIds.push(res.data.id);
  return res.data.id;
}

async function signServiceRecord(srId: number): Promise<void> {
  for (const signerType of ["employee", "customer"] as const) {
    const res = await apiPost(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: "data:image/png;base64,iVBORw0KGgo=",
    });
    if (res.status !== 200) {
      throw new Error(`signServiceRecord(${srId}, ${signerType}) failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
  }
}

function szPayload(tag: string) {
  return {
    vorname: "INC-SZ",
    nachname: `Privat-${tag}-${uniqueId()}`,
    geburtsdatum: "1942-03-10",
    strasse: "Teststraße",
    nr: "1",
    plz: "10115",
    stadt: "Berlin",
    pflegegrad: 2,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
    contacts: [
      {
        contactType: "familie",
        isPrimary: true,
        vorname: "Kontakt",
        nachname: "INC-SZ",
        mobilnummer: "+4917600000010",
      },
    ],
  };
}

async function createCustomer(payload: Record<string, unknown>): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/admin/customers", payload);
  if (res.status !== 201) {
    throw new Error(`createCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const id = res.data.id;
  cleanupCustomerIds.push(id);
  await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: testEmployeeId,
    backupEmployeeId2: null,
  });
  return id;
}

interface PreparedInvoiceCustomer {
  customerId: number;
  year: number;
  month: number;
}

async function prepareCustomerForInvoice(tag: string): Promise<PreparedInvoiceCustomer> {
  const customerId = await createCustomer(szPayload(tag));
  const appt = await findFreeSlotAndCreate(customerId, hwServiceId, 30, tag);
  await documentAppointment(appt.id, appt.time, hwServiceId, 30, `INC-${tag}`);
  const apptDate = new Date(appt.date);
  const year = apptDate.getFullYear();
  const month = apptDate.getMonth() + 1;
  const srId = await createServiceRecord(customerId, year, month);
  await signServiceRecord(srId);
  return { customerId, year, month };
}

interface InvoiceLite {
  id: number;
  invoiceNumber: string;
  status: string;
  invoiceType?: string;
  stornierteRechnungId?: number | null;
  customerId: number;
}

interface GenerateResponse {
  splitInvoices?: boolean;
  invoices?: InvoiceLite[];
  id?: number;
  invoiceNumber?: string;
}

async function generateInvoiceForPrepared(p: PreparedInvoiceCustomer): Promise<InvoiceLite> {
  const res = await apiPost<GenerateResponse | InvoiceLite>("/api/billing/generate", {
    customerId: p.customerId,
    billingMonth: p.month,
    billingYear: p.year,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `generateInvoice(customer=${p.customerId}) failed: ${res.status} ${JSON.stringify(res.data)}`,
    );
  }
  const data = res.data as GenerateResponse;
  const inv = (data.splitInvoices && data.invoices ? data.invoices[0] : (res.data as InvoiceLite));
  cleanupInvoiceIds.push(inv.id);
  return inv;
}

function parseSequenceFromInvoiceNumber(invoiceNumber: string): { year: number; sequence: number } {
  const match = /^RE-(\d{4})-(\d+)$/.exec(invoiceNumber);
  if (!match) throw new Error(`Unerwartetes Rechnungsnummern-Format: ${invoiceNumber}`);
  return { year: Number(match[1]), sequence: Number(match[2]) };
}

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<Array<{ id: number; code: string }>>("/api/services/all");
  const hw = servicesRes.data.find((s) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service hauswirtschaft fehlt in der Test-DB");
  hwServiceId = hw.id;

  const emp = await createTestEmployee({ nachnamePrefix: "TestINC" });
  testEmployeeId = emp.id;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch { /* ignore */ }
  }
  for (const id of cleanupServiceRecordIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch { /* ignore */ }
  }
  for (const id of cleanupCustomerIds) {
    try { await apiDelete(`/api/admin/customers/${id}`); } catch { /* ignore */ }
  }
  await deactivateTestEmployee(testEmployeeId);
});

describe("INC-1: Parallele Rechnungs-Generierung", () => {
  it("INC-1.1 — 10 parallele POST /api/billing/generate liefern 10 eindeutige, lückenlose Nummern", async () => {
    // Vorbereitung sequentiell — die Race tritt erst beim parallelen Insert auf.
    const prepared: PreparedInvoiceCustomer[] = [];
    for (let i = 0; i < 10; i++) {
      prepared.push(await prepareCustomerForInvoice(`P${i}`));
    }

    const years = new Set(prepared.map((p) => p.year));
    expect(years.size, "Alle Test-Kunden müssen im selben Abrechnungsjahr liegen").toBe(1);
    const billingYear = prepared[0].year;

    const settled = await Promise.allSettled(prepared.map((p) => generateInvoiceForPrepared(p)));

    const failures = settled
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.status === "rejected");
    expect(
      failures.length,
      `Alle 10 Generierungen müssen erfolgreich sein, Fehler: ${failures.map((f) => `#${f.i}: ${(f.r as PromiseRejectedResult).reason}`).join(" | ")}`,
    ).toBe(0);

    const invoicesResult = settled
      .filter((r): r is PromiseFulfilledResult<InvoiceLite> => r.status === "fulfilled")
      .map((r) => r.value);

    const numbers = invoicesResult.map((inv) => inv.invoiceNumber);
    const unique = new Set(numbers);
    expect(unique.size, `Erwartet 10 eindeutige Rechnungsnummern, bekam: ${numbers.join(", ")}`).toBe(10);

    // tests laufen seriell (vitest fileParallelism: false), die 10 Nummern
    // müssen daher exakt 10 aufeinanderfolgende Sequenzen sein.
    const sequences = numbers
      .map((n) => parseSequenceFromInvoiceNumber(n))
      .map((p) => {
        expect(p.year).toBe(billingYear);
        return p.sequence;
      })
      .sort((a, b) => a - b);

    const minSeq = sequences[0];
    const maxSeq = sequences[sequences.length - 1];
    expect(maxSeq - minSeq, `Sortiert: ${sequences.join(", ")}`).toBe(9);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i], `Lücke zwischen ${sequences[i - 1]} und ${sequences[i]}`).toBe(sequences[i - 1] + 1);
    }
  }, 120_000);
});

describe("INC-2: Parallele Storno-Operationen", () => {
  it("INC-2.1 — 5 parallele Storno-Anfragen erzeugen 5 eindeutige Stornorechnungen ohne Waisen", async () => {
    const prepared: PreparedInvoiceCustomer[] = [];
    for (let i = 0; i < 5; i++) {
      prepared.push(await prepareCustomerForInvoice(`S${i}`));
    }

    const originals: InvoiceLite[] = [];
    for (const p of prepared) {
      originals.push(await generateInvoiceForPrepared(p));
    }

    for (const inv of originals) {
      const res = await apiPatch(`/api/billing/${inv.id}/status`, { status: "versendet" });
      expect(res.status, `versendet-Transition für ${inv.invoiceNumber}`).toBe(200);
    }

    const settled = await Promise.allSettled(
      originals.map((inv) => apiPatch(`/api/billing/${inv.id}/status`, { status: "storniert" })),
    );

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      expect(r.status, `Storno #${i} (${originals[i].invoiceNumber})`).toBe("fulfilled");
      if (r.status === "fulfilled") {
        expect(r.value.status, `Storno #${i} HTTP-Status, body=${JSON.stringify(r.value.data)}`).toBe(200);
      }
    }

    const stornoNumbers: string[] = [];
    for (const inv of originals) {
      const list = await apiGet<InvoiceLite[]>(`/api/billing?customerId=${inv.customerId}`);
      expect(list.status).toBe(200);
      const stornoForOriginal = list.data.filter(
        (i) => i.invoiceType === "stornorechnung" && i.stornierteRechnungId === inv.id,
      );
      expect(
        stornoForOriginal.length,
        `Genau 1 Stornorechnung pro Original (Original ${inv.invoiceNumber}, gefunden: ${stornoForOriginal.length})`,
      ).toBe(1);
      cleanupInvoiceIds.push(stornoForOriginal[0].id);
      stornoNumbers.push(stornoForOriginal[0].invoiceNumber);

      const original = list.data.find((i) => i.id === inv.id);
      expect(original?.status, `Original ${inv.invoiceNumber} muss storniert sein`).toBe("storniert");
    }

    const uniqueStornos = new Set(stornoNumbers);
    expect(
      uniqueStornos.size,
      `5 Storni müssen 5 eindeutige Nummern haben, bekam: ${stornoNumbers.join(", ")}`,
    ).toBe(5);
  }, 120_000);
});

describe("INC-3: Storno-Atomarität bei injiziertem Fehler", () => {
  it("INC-3.1 — Wirft die Tx nach Stornorechnungs-Insert, bleibt KEINE Stornorechnung in der DB", async () => {
    // Setup: Kunde + Rechnung versendet.
    const prepared = await prepareCustomerForInvoice("FAIL");
    const original = await generateInvoiceForPrepared(prepared);
    const send = await apiPatch(`/api/billing/${original.id}/status`, { status: "versendet" });
    expect(send.status).toBe(200);

    // Direkte Tx: Stornorechnung einfügen, Original-Status updaten, dann werfen.
    // Beide Inserts/Updates müssen via Rollback verworfen werden.
    const sentinel = `FAIL-INJECT-${uniqueId()}`;
    await expect(
      db.transaction(async (tx) => {
        const number = await getNextInvoiceNumberTx(tx, prepared.year);
        const lineItems = await getInvoiceLineItemsTx(tx, original.id);
        const stornoData = {
          invoiceNumber: number,
          customerId: original.customerId,
          billingType: "selbstzahler",
          invoiceType: "stornorechnung",
          billingMonth: prepared.month,
          billingYear: prepared.year,
          recipientName: sentinel,
          recipientAddress: "Teststraße 1, 10115 Berlin",
          customerName: sentinel,
          insuranceProviderName: null,
          insuranceIkNummer: null,
          versichertennummer: null,
          pflegegrad: 2,
          netAmountCents: -100,
          vatAmountCents: -19,
          grossAmountCents: -119,
          vatRate: 1900,
          status: "versendet",
          stornierteRechnungId: original.id,
        };
        const stornoLineItems = lineItems.map((li) => ({
          appointmentId: li.appointmentId,
          appointmentDate: li.appointmentDate,
          serviceDescription: li.serviceDescription,
          serviceCode: li.serviceCode,
          startTime: li.startTime,
          endTime: li.endTime,
          durationMinutes: li.durationMinutes,
          unitPriceCents: li.unitPriceCents,
          totalCents: -li.totalCents,
          employeeName: li.employeeName,
          employeeLbnr: li.employeeLbnr,
          appointmentNotes: li.appointmentNotes ?? null,
          serviceDetails: li.serviceDetails ?? null,
        }));
        await createInvoiceTx(tx, stornoData, stornoLineItems, auth.user.id);
        await updateInvoiceStatusTx(tx, original.id, "storniert", auth.user.id);
        throw new Error("simulated failure after storno insert");
      }),
    ).rejects.toThrow(/simulated failure/);

    // Beweis: keine Stornorechnung mit unserem Sentinel-Marker oder
    // stornierteRechnungId=original.id existiert.
    const orphans = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.invoiceType, "stornorechnung"),
          eq(invoices.stornierteRechnungId, original.id),
        ),
      );
    expect(orphans.length, `Tx-Rollback muss Stornorechnung verwerfen, gefunden: ${orphans.length}`).toBe(0);

    // Original-Status darf NICHT "storniert" sein — der UpdateInvoiceStatusTx
    // lief in derselben Tx und muss ebenfalls verworfen worden sein.
    const list = await apiGet<InvoiceLite[]>(`/api/billing?customerId=${original.customerId}`);
    const reread = list.data.find((i) => i.id === original.id);
    expect(reread?.status, `Original-Status muss durch Rollback unverändert bleiben`).toBe("versendet");
  }, 60_000);
});
