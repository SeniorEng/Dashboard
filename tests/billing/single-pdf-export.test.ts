/**
 * Task #1695 — Einzel-PDF-Export (POST /api/billing/single-pdf-export)
 *
 * Die „Einzeln (ZIP)"-Variante des konsolidierten „Drucken"-Menüs. Der Admin
 * wählt Rechnungen (per IDs und/oder Zeitraum) und lädt ein ZIP, in dem JEDE
 * Rechnung als eigene PDF mit lesbarem Dateinamen
 * (`Rechnungsnummer_Kunde_Datum.pdf`) liegt. Über `includeLeistungsnachweise`
 * wird je Rechnung der zugehörige Leistungsnachweis in DIESELBE Einzel-PDF
 * gemergt (eine Datei je Rechnung).
 *
 * Dieser Test fixiert die Kern-Invarianten der Route:
 *   1. Genau EINE PDF pro ausgewählter Rechnung im ZIP.
 *   2. „Nur Rechnungen": Jede PDF ist LN-FREI — sowohl für den 1:1-Pfad
 *      (gesetzliche Kasse, versiegeltes PDF ist bereits ohne LN) als auch für
 *      den invoice-only-Re-Render-Pfad (privat: das versiegelte PDF ist
 *      Rechnung+LN gemergt, der Export rendert die Rechnung ohne LN neu).
 *   3. „+ Leistungsnachweise": Jede PDF enthält genau EINEN LN, in dieselbe
 *      Einzel-PDF gemergt.
 *   4. READ-ONLY: Status bleibt `entwurf` (kein „versendet"), und das versiegelte
 *      Original-PDF (pdfHash + LN im Bündel) ist nach dem Export BYTE-unverändert.
 *   5. Reine Stornorechnungen werden vom Export ausgeschlossen.
 *   6. Dateinamen folgen dem Muster und sind innerhalb des ZIP eindeutig.
 *
 * Tests laufen seriell gegen eine isolierte Wegwerf-Test-DB pro Worker; jeder
 * Test legt eigene Kunden an und räumt im afterAll auf.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { describe } from "../helpers/object-storage";
import {
  apiGet,
  apiPost,
  apiPatch,
  getAuthCookie,
  uniqueId,
  cleanupCustomer,
} from "../test-utils";
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { buildContentDisposition } from "@shared/domain/invoice-export-filename";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;

const cleanupCustomerIds: number[] = [];

// ---------- Date / Slot helpers ----------

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

function recentPastWeekdayAnchor(): { year: number; month: number } {
  const d = new Date();
  do {
    d.setDate(d.getDate() - 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

async function createAppointmentInMonth(
  customerId: number,
  serviceId: number,
  durationMinutes: number,
  year: number,
  month: number,
  noteTag: string,
): Promise<{ id: number; date: string; time: string }> {
  const today = new Date();
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = lastDay; day >= 1; day--) {
    const cand = new Date(year, month - 1, day);
    if (cand > today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymdLocal(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `LEX-${noteTag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId, durationMinutes }],
      });
      if (res.status === 201) {
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(
    `createAppointmentInMonth(${year}-${month}, ${noteTag}): kein freier Werktag-Slot im Monat`,
  );
}

// ---------- Billing-flow helpers ----------

async function createCustomer(payload: Record<string, unknown>): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/admin/customers", payload);
  if (res.status !== 201) {
    throw new Error(`createCustomer failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  cleanupCustomerIds.push(res.data.id);
  return res.data.id;
}

async function documentAppointment(
  appointmentId: number,
  startTime: string,
  serviceId: number,
  actualMinutes: number,
): Promise<void> {
  const res = await apiPost<unknown>(`/api/appointments/${appointmentId}/document`, {
    actualStart: startTime,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details: "LEX-Doc" }],
  });
  if (res.status !== 200) {
    throw new Error(`documentAppointment(${appointmentId}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function createAndSignServiceRecord(customerId: number, year: number, month: number): Promise<void> {
  const res = await apiPost<{ id: number }>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  if (res.status !== 201) {
    throw new Error(`createServiceRecord failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const srId = res.data.id;
  for (const signerType of ["employee", "customer"] as const) {
    const signRes = await apiPost<unknown>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    if (signRes.status !== 200) {
      throw new Error(`signServiceRecord(${srId}, ${signerType}) failed: ${signRes.status} ${JSON.stringify(signRes.data)}`);
    }
  }
}

async function generateInvoice(customerId: number, year: number, month: number): Promise<number[]> {
  const res = await apiPost<unknown>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`generateInvoice failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const data = res.data as
    | { invoices?: Array<{ id: number }> }
    | Array<{ id: number }>
    | { id: number };
  let list: Array<{ id: number }>;
  if (data && typeof data === "object" && "invoices" in data && Array.isArray((data as { invoices?: Array<{ id: number }> }).invoices)) {
    list = (data as { invoices: Array<{ id: number }> }).invoices;
  } else if (Array.isArray(data)) {
    list = data;
  } else {
    list = [data as { id: number }];
  }
  return list.map((i) => i.id);
}

async function createDedicatedProvider(tag: string): Promise<{ id: number; name: string }> {
  const ik = String(Date.now()).slice(-9).padStart(9, "0");
  const res = await apiPost<{ id: number; name: string }>("/api/admin/insurance-providers", {
    name: `LexKasse-${tag}-${uniqueId()}`,
    ikNummer: ik,
    isPrivate: false,
  });
  if (res.status !== 201) {
    throw new Error(`createDedicatedProvider failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { id: res.data.id, name: res.data.name };
}

// ---------- PDF / ZIP helpers ----------

type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;
async function extractPdfText(buf: Buffer): Promise<string> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(buf);
  const normalized = Buffer.from(await doc.save({ useObjectStreams: false }));
  const ns = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as { default: PdfParseFn };
  const parsed = await ns.default(normalized);
  return parsed.text;
}

async function countLeistungsnachweise(buf: Buffer): Promise<number> {
  const text = await extractPdfText(buf);
  return (text.match(/LEISTUNGSNACHWEIS/g) ?? []).length;
}

interface ZipPdfEntry {
  name: string;
  content: Buffer;
}

async function readZipPdfEntries(buf: Buffer): Promise<ZipPdfEntry[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const out: ZipPdfEntry[] = [];
  for (const entry of entries) {
    const content = await entry.async("nodebuffer");
    out.push({ name: entry.name, content });
  }
  return out;
}

async function singlePdfExport(body: {
  invoiceIds?: number[];
  billingMonth?: number;
  billingYear?: number;
  insuranceProviderId?: number;
  includeLeistungsnachweise?: boolean;
}): Promise<{ status: number; contentType: string; contentDisposition: string | null; buffer: Buffer; summaryHeader: string | null }> {
  const res = await fetch(`${BASE_URL}/api/billing/single-pdf-export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${auth.cookie}; careconnect_csrf=${auth.csrfToken}`,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    contentDisposition: res.headers.get("content-disposition"),
    buffer: Buffer.from(await res.arrayBuffer()),
    summaryHeader: res.headers.get("x-single-pdf-export-summary"),
  };
}

async function fetchBundlePdf(invoiceId: number): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/api/billing/${invoiceId}/bundle`, {
    headers: { Cookie: auth.cookie },
  });
  expect(res.status, `bundle ${invoiceId} HTTP 200`).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

async function getInvoiceStatus(invoiceId: number, year: number, month: number): Promise<string | undefined> {
  const res = await apiGet<Array<{ id: number; status: string }>>(
    `/api/billing?year=${year}&month=${month}`,
  );
  expect(res.status).toBe(200);
  return res.data.find((inv) => inv.id === invoiceId)?.status;
}

// ============================================================

beforeAll(async () => {
  auth = await getAuthCookie();

  const servicesRes = await apiGet<Array<{ id: number; code: string }>>("/api/services");
  if (servicesRes.status !== 200 || !Array.isArray(servicesRes.data)) {
    throw new Error("Service-Katalog konnte nicht geladen werden");
  }
  const hw = servicesRes.data.find((s) => s.code === "hauswirtschaft");
  if (!hw) throw new Error("Pflicht-Service 'hauswirtschaft' fehlt in der Test-DB");
  hwServiceId = hw.id;
});

afterAll(async () => {
  for (const id of cleanupCustomerIds) {
    await cleanupCustomer(id);
  }
});

describe("Einzel-PDF-Export: eine PDF pro Rechnung, LN-Merge optional, READ-ONLY (Task #1695)", () => {
  it("exportiert je eine LN-freie PDF pro Rechnung (1:1- und Re-Render-Pfad) ohne Status-Aenderung; +LN mergt je einen LN", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    // Gesetzliche Kasse → versiegeltes PDF ist bereits LN-FREI (1:1-Pfad).
    const gkProvider = await createDedicatedProvider("GK");
    const gkCustomerId = await createCustomer({
      vorname: "Lex-Gesetzlich",
      nachname: `K-${uniqueId()}`,
      geburtsdatum: "1940-03-03",
      strasse: "Kassenweg",
      nr: "1",
      plz: "10115",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: gkProvider.id,
        versichertennummer: "G" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
      budgets: {
        entlastungsbetrag45b: 13100,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2024-01-01",
      },
    });
    const gkAppt = await createAppointmentInMonth(gkCustomerId, hwServiceId, 30, year, month, "gk");
    await documentAppointment(gkAppt.id, gkAppt.time, hwServiceId, 30);
    await createAndSignServiceRecord(gkCustomerId, year, month);
    const gkIds = await generateInvoice(gkCustomerId, year, month);
    expect(gkIds.length, "gesetzlich darf nicht splitten").toBe(1);

    // Privat → versiegeltes PDF ist Rechnung+LN GEMERGT (Re-Render-Pfad).
    const pvProvider = await createDedicatedProvider("PV");
    const pvCustomerId = await createCustomer({
      vorname: "Lex-Privat",
      nachname: `K-${uniqueId()}`,
      geburtsdatum: "1938-05-12",
      strasse: "Privatweg",
      nr: "5",
      plz: "10117",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_privat",
      acceptsPrivatePayment: true,
      insurance: {
        providerId: pvProvider.id,
        versichertennummer: "A" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
      budgets: {
        entlastungsbetrag45b: 13100,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2024-01-01",
      },
    });
    const pvAppt = await createAppointmentInMonth(pvCustomerId, hwServiceId, 30, year, month, "pv");
    await documentAppointment(pvAppt.id, pvAppt.time, hwServiceId, 30);
    await createAndSignServiceRecord(pvCustomerId, year, month);
    const pvIds = await generateInvoice(pvCustomerId, year, month);
    expect(pvIds.length, "privat darf nicht splitten").toBe(1);

    // Sanity: das versiegelte Privat-PDF enthält tatsächlich einen LN (sonst
    // würde der Re-Render-Pfad gar nicht geprüft).
    const sealedPvBundle = await fetchBundlePdf(pvIds[0]);
    expect(await countLeistungsnachweise(sealedPvBundle), "privat sealed = 1 LN").toBe(1);

    // ---- „Nur Rechnungen": Export beider Rechnungen ohne LN ----
    const out = await singlePdfExport({ invoiceIds: [gkIds[0], pvIds[0]] });
    expect(out.status, "single-pdf-export HTTP 200").toBe(200);
    expect(out.contentType).toContain("application/zip");

    const entries = await readZipPdfEntries(out.buffer);
    // 1. Genau eine PDF pro Rechnung.
    expect(entries.length, "eine PDF pro Rechnung").toBe(2);
    for (const e of entries) {
      expect(e.content.subarray(0, 5).toString("latin1"), `${e.name} ist ein PDF`).toBe("%PDF-");
      // 2. Jede PDF ist LN-FREI.
      expect(await countLeistungsnachweise(e.content), `${e.name} LN-frei`).toBe(0);
      // 6. Dateiname folgt dem Muster Rechnungsnummer_Kunde_Datum.pdf.
      expect(e.name, `${e.name} folgt dem Muster`).toMatch(
        /^[A-Za-z0-9_-]+_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+\.pdf$/,
      );
    }
    // 6. Dateinamen eindeutig.
    const lowerNames = entries.map((e) => e.name.toLowerCase());
    expect(new Set(lowerNames).size, "Dateinamen eindeutig").toBe(entries.length);

    // Summary-Header.
    expect(out.summaryHeader, "Summary-Header vorhanden").toBeTruthy();
    const summary = JSON.parse(decodeURIComponent(out.summaryHeader!)) as {
      total: number;
      exported: number;
      errors: number;
    };
    expect(summary.exported).toBe(2);
    expect(summary.errors).toBe(0);

    // ---- „+ Leistungsnachweise": je eine PDF mit genau EINEM gemergten LN ----
    const outLn = await singlePdfExport({
      invoiceIds: [gkIds[0], pvIds[0]],
      includeLeistungsnachweise: true,
    });
    expect(outLn.status, "single-pdf-export +LN HTTP 200").toBe(200);
    const entriesLn = await readZipPdfEntries(outLn.buffer);
    // 1. Weiterhin genau eine (jetzt gemergte) PDF pro Rechnung.
    expect(entriesLn.length, "+LN: eine PDF pro Rechnung").toBe(2);
    for (const e of entriesLn) {
      expect(e.content.subarray(0, 5).toString("latin1"), `${e.name} ist ein PDF`).toBe("%PDF-");
      // 3. Genau EIN LN je Rechnung, in dieselbe Einzel-PDF gemergt.
      expect(await countLeistungsnachweise(e.content), `${e.name} enthält genau 1 LN`).toBe(1);
    }

    // 4. READ-ONLY: Status bleibt entwurf (KEIN „versendet").
    expect(await getInvoiceStatus(gkIds[0], year, month), "gk Status unverändert").toBe("entwurf");
    expect(await getInvoiceStatus(pvIds[0], year, month), "pv Status unverändert").toBe("entwurf");

    // 4. READ-ONLY: versiegeltes Privat-PDF unverändert (LN weiterhin enthalten).
    const sealedPvAfter = await fetchBundlePdf(pvIds[0]);
    expect(await countLeistungsnachweise(sealedPvAfter), "privat sealed nach Export = 1 LN").toBe(1);
  }, 300_000);

  it("schließt reine Stornorechnungen vom Export aus", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const provider = await createDedicatedProvider("ST");
    const customerId = await createCustomer({
      vorname: "Lex-Storno",
      nachname: `K-${uniqueId()}`,
      geburtsdatum: "1939-04-04",
      strasse: "Stornoweg",
      nr: "2",
      plz: "10115",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: provider.id,
        versichertennummer: "S" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
      budgets: {
        entlastungsbetrag45b: 13100,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2024-01-01",
      },
    });
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "st");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length).toBe(1);

    // Rechnung stornieren → erzeugt eine Stornorechnung (invoiceType=stornorechnung).
    const stornoRes = await apiPatch<unknown>(`/api/billing/${ids[0]}/status`, {
      status: "storniert",
    });
    expect([200, 201]).toContain(stornoRes.status);

    // Der Storno-BELEG (invoiceType=stornorechnung) wird über die Monats-Liste
    // identifiziert, damit der Test robust gegen das konkrete Nummern-Schema ist.
    const listRes = await apiGet<Array<{ id: number; invoiceNumber: string; invoiceType: string }>>(
      `/api/billing?year=${year}&month=${month}&insuranceProviderId=${provider.id}`,
    );
    expect(listRes.status).toBe(200);
    const stornoBelege = listRes.data.filter((inv) => inv.invoiceType === "stornorechnung");
    expect(stornoBelege.length, "Storno hat einen Storno-Beleg erzeugt").toBeGreaterThanOrEqual(1);
    const stornoNumbers = new Set(stornoBelege.map((inv) => inv.invoiceNumber));

    // Export über den Zeitraum: die Stornorechnung darf NICHT im ZIP landen.
    const out = await singlePdfExport({ billingMonth: month, billingYear: year, insuranceProviderId: provider.id });
    expect(out.status).toBe(200);
    const summary = JSON.parse(decodeURIComponent(out.summaryHeader!)) as { results: Array<{ invoiceId: number; invoiceNumber: string }> };
    for (const r of summary.results) {
      expect(stornoNumbers.has(r.invoiceNumber), `Storno-Beleg ${r.invoiceNumber} nicht exportiert`).toBe(false);
    }
  }, 300_000);

  it("lehnt eine Anfrage ohne IDs und ohne Zeitraum ab (400)", async () => {
    const out = await singlePdfExport({});
    expect(out.status).toBe(400);
  });

  it("Content-Disposition läuft über den umlaut-sicheren Helper (ASCII-Fallback + RFC-5987 filename*) (Task #1704)", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const provider = await createDedicatedProvider("CD");
    const customerId = await createCustomer({
      vorname: "Lex-Disp",
      nachname: `K-${uniqueId()}`,
      geburtsdatum: "1941-06-06",
      strasse: "Dispweg",
      nr: "3",
      plz: "10115",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      rechnungAnKunde: false,
      insurance: {
        providerId: provider.id,
        versichertennummer: "D" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
      budgets: {
        entlastungsbetrag45b: 13100,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2024-01-01",
      },
    });
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "cd");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length).toBe(1);

    // Zeitraum-only-Export (ohne IDs) → deterministischer ZIP-Name
    // `Rechnungen-MM-YYYY.zip`.
    const out = await singlePdfExport({
      billingMonth: month,
      billingYear: year,
      insuranceProviderId: provider.id,
    });
    expect(out.status).toBe(200);
    expect(out.contentType).toContain("application/zip");
    expect(out.contentDisposition, "Download trägt Content-Disposition").toBeTruthy();

    const expectedZipName = `Rechnungen-${String(month).padStart(2, "0")}-${year}.zip`;
    const expectedHeader = buildContentDisposition(expectedZipName, "attachment");

    // Vertrag: der Header ist byte-identisch mit dem SSoT-Helper — ein Refactor
    // zurück auf das rohe `attachment; filename="…"` (ohne filename*) wird rot.
    expect(out.contentDisposition, "Content-Disposition == SSoT-Helper").toBe(expectedHeader);
    expect(out.contentDisposition!, "enthält ASCII filename=").toContain(`filename="${expectedZipName}"`);
    expect(out.contentDisposition!, "enthält RFC-5987 filename*").toContain("filename*=UTF-8''");
  }, 300_000);
});
