/**
 * Task #1039 — Regression: Doppelter Leistungsnachweis im Bündel-Druck
 *
 * Für kundenadressierte Rechnungen (`pflegekasse_privat` sowie
 * `pflegekasse_gesetzlich` mit `rechnungAnKunde`/Beihilfe) montiert
 * `buildInvoicePdfBytes` den Leistungsnachweis (LN) bereits FEST in das
 * gespeicherte Rechnungs-PDF (`pdfPath`). Die Bündel-/Sammeldruck-Endpoints
 * hängten den separat gecachten Standalone-LN danach ein ZWEITES Mal an →
 * doppelter LN (RE-2026-0034).
 *
 * Dieser Test fixiert die LN-Seiten-Anzahl pro Abrechnungstyp gegen die
 * Bündel-Route `GET /api/billing/:id/bundle`:
 *   - pflegekasse_privat            → genau 1 LN
 *   - pflegekasse_privat + Beihilfe → genau 2 LN (Zweitausfertigung,
 *     KEIN zusätzlicher dritter LN)
 *   - pflegekasse_gesetzlich        → genau 1 LN (separat angehängt)
 *   - selbstzahler                  → genau 1 LN (on-the-fly angehängt)
 *
 * Gezählt wird der LN-Titel `LEISTUNGSNACHWEIS` (erscheint ausschließlich auf
 * LN-Seiten; das Rechnungs-PDF trägt den Titel `RECHNUNG`). Tests laufen
 * seriell gegen eine isolierte Wegwerf-Test-DB pro Worker; jeder Test legt
 * eigene Kunden an und räumt im afterAll auf.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { describe } from "../helpers/object-storage";
import {
  apiGet,
  apiPost,
  getAuthCookie,
  uniqueId,
  cleanupCustomer,
} from "../test-utils";
import { validSignatureDataUrl } from "../helpers/valid-signature";

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
        notes: `LNDUP-${noteTag}-${uniqueId()}`,
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
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details: "LNDUP-Doc" }],
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
    | { splitInvoices?: boolean; invoices?: Array<{ id: number }> }
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
  const name = `LNDupKasse${tag}`;
  const ik = String(Date.now()).slice(-9).padStart(9, "0");
  const res = await apiPost<{ id: number; name: string }>("/api/admin/insurance-providers", {
    name,
    ikNummer: ik,
    isPrivate: false,
  });
  if (res.status !== 201) {
    throw new Error(`createDedicatedProvider failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { id: res.data.id, name: res.data.name };
}

// ---------- PDF helpers ----------

async function fetchBundlePdf(invoiceId: number): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/api/billing/${invoiceId}/bundle`, {
    headers: { Cookie: auth.cookie },
  });
  expect(res.status, `bundle ${invoiceId} HTTP 200`).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("application/pdf");
  return Buffer.from(await res.arrayBuffer());
}

// `pdf-parse` bündelt ein altes pdf.js, das pdf-lib-Object-Streams nicht liest.
// Daher die Bytes über pdf-lib auf eine klassische Xref-Tabelle normalisieren
// (Text-Streams bleiben unverändert), bevor wir den Text extrahieren.
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

// Summiert die LN-Seiten über ALLE PDF-Einträge eines ZIP-Archivs. Greift für
// beide ZIP-Layouts:
//   - /bundle-by-payer ZIP: pro Rechnung zwei Dateien (Rechnung + ggf. LN).
//   - /bulk-print ZIP (groupByPayer=true): pro Payer-Gruppe EIN gemergtes PDF.
// In beiden Fällen ist die Σ der `LEISTUNGSNACHWEIS`-Titel über alle PDFs die
// effektive LN-Anzahl, die der Admin gedruckt bekommt.
async function countLeistungsnachweiseInZip(buf: Buffer): Promise<number> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  let total = 0;
  for (const entry of entries) {
    const content = await entry.async("nodebuffer");
    if (content.subarray(0, 5).toString("latin1") !== "%PDF-") continue;
    total += await countLeistungsnachweise(content);
  }
  return total;
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

describe("LN-Dup: Bündel-Druck enthält den Leistungsnachweis genau einmal (Task #1039)", () => {
  it("pflegekasse_privat → genau 1 LN im Bündel", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const provider = await createDedicatedProvider(`P${Date.now().toString(36)}`);
    const customerId = await createCustomer({
      vorname: "LNDup-Privat",
      nachname: `K-${uniqueId()}`,
      geburtsdatum: "1938-05-12",
      strasse: "Teststraße",
      nr: "5",
      plz: "10117",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_privat",
      acceptsPrivatePayment: true,
      insurance: {
        providerId: provider.id,
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
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "privat");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "privat darf nicht splitten").toBe(1);

    const bundle = await fetchBundlePdf(ids[0]);
    expect(await countLeistungsnachweise(bundle), "privat-Bündel = genau 1 LN").toBe(1);
  }, 240_000);

  it("pflegekasse_privat + Beihilfe → genau 2 LN (Zweitausfertigung, kein dritter)", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const provider = await createDedicatedProvider(`B${Date.now().toString(36)}`);
    const customerId = await createCustomer({
      vorname: "LNDup-Beihilfe",
      nachname: `K-${uniqueId()}`,
      geburtsdatum: "1936-02-02",
      strasse: "Beihilfeweg",
      nr: "7",
      plz: "10117",
      stadt: "Berlin",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_privat",
      acceptsPrivatePayment: true,
      beihilfeBerechtigt: true,
      insurance: {
        providerId: provider.id,
        versichertennummer: "B" + String(Math.floor(100000000 + Math.random() * 900000000)),
        validFrom: "2024-01-01",
      },
      budgets: {
        entlastungsbetrag45b: 13100,
        verhinderungspflege39: 0,
        pflegesachleistungen36: 0,
        validFrom: "2024-01-01",
      },
    });
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "beihilfe");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "beihilfe darf nicht splitten").toBe(1);

    const bundle = await fetchBundlePdf(ids[0]);
    expect(await countLeistungsnachweise(bundle), "beihilfe-Bündel = genau 2 LN").toBe(2);
  }, 240_000);

  it("pflegekasse_gesetzlich (ohne Kostenerstattung) → genau 1 LN", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const provider = await createDedicatedProvider(`G${Date.now().toString(36)}`);
    const customerId = await createCustomer({
      vorname: "LNDup-Gesetzlich",
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
        providerId: provider.id,
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
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "gesetzlich");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "gesetzlich darf nicht splitten").toBe(1);

    const bundle = await fetchBundlePdf(ids[0]);
    expect(await countLeistungsnachweise(bundle), "gesetzlich-Bündel = genau 1 LN").toBe(1);
  }, 240_000);

  it("selbstzahler → genau 1 LN (on-the-fly angehängt)", async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const customerId = await createCustomer({
      vorname: "LNDup-Selbstzahler",
      nachname: `K-${uniqueId()}`,
      geburtsdatum: "1942-03-10",
      email: `lndup-sz-${uniqueId()}@test.local`,
      strasse: "Privatweg",
      nr: "1",
      plz: "10115",
      stadt: "Berlin",
      pflegegrad: 2,
      pflegegradSeit: "2024-01-01",
      billingType: "selbstzahler",
      acceptsPrivatePayment: true,
    });
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "selbstzahler");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "selbstzahler darf nicht splitten").toBe(1);

    const bundle = await fetchBundlePdf(ids[0]);
    expect(await countLeistungsnachweise(bundle), "selbstzahler-Bündel = genau 1 LN").toBe(1);
  }, 240_000);
});

// ============================================================
// Task #1044 — Dieselbe LN-Dup-Regression auch für die beiden Mehr-Rechnungs-
// Druckwege fixieren:
//   - GET  /api/billing/bundle-by-payer  (Kassen-Bündel, PDF + ZIP)
//   - POST /api/billing/bulk-print       (Monats-Sammeldruck, groupByPayer
//                                          false = gemergtes PDF, true = ZIP)
//
// Beide nutzen — wie /:id/bundle — `shouldAppendStandaloneLeistungsnachweis`,
// um den bereits ins Rechnungs-PDF einmontierten LN nicht ein zweites Mal
// anzuhängen. Eine Regression (doppelter LN) muss hier ebenso auffliegen.
//
// Isolation: Jeder Kunde bekommt eine EIGENE dedizierte Krankenkasse und wird
// per `insuranceProviderId` gefiltert abgefragt. Das gilt auch für den
// Selbstzahler — er darf laut Customer-Schema einen Insurance-Block tragen
// (billingType bleibt `selbstzahler`, LN-Logik unverändert), wodurch er über
// denselben Kassen-Filter exakt isolierbar wird. So liefert jeder Aufruf genau
// EINE Rechnung zurück — robust gegen Fremd-Drafts aus anderen Tests/der Dev-DB.
// ============================================================

type BillingTypeKey = "privat" | "gesetzlich" | "selbstzahler" | "beihilfe";

function rand9(): string {
  return String(Math.floor(100000000 + Math.random() * 900000000));
}

async function createIsolatedProvider(tag: string): Promise<{ id: number; name: string }> {
  const res = await apiPost<{ id: number; name: string }>("/api/admin/insurance-providers", {
    name: `LNDup1044-${tag}-${uniqueId()}`,
    ikNummer: rand9(),
    isPrivate: false,
  });
  if (res.status !== 201) {
    throw new Error(`createIsolatedProvider failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { id: res.data.id, name: res.data.name };
}

function typedCustomerPayload(key: BillingTypeKey, providerId: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    nachname: `K-${uniqueId()}`,
    strasse: "Sammeldruckweg",
    nr: "3",
    plz: "10117",
    stadt: "Berlin",
    pflegegradSeit: "2024-01-01",
  };
  const insurance = (prefix: string) => ({
    providerId,
    versichertennummer: prefix + rand9(),
    validFrom: "2024-01-01",
  });
  const budgets = {
    entlastungsbetrag45b: 13100,
    verhinderungspflege39: 0,
    pflegesachleistungen36: 0,
    validFrom: "2024-01-01",
  };
  switch (key) {
    case "privat":
      return {
        ...base,
        vorname: "BP-Privat",
        geburtsdatum: "1938-05-12",
        pflegegrad: 3,
        billingType: "pflegekasse_privat",
        acceptsPrivatePayment: true,
        insurance: insurance("A"),
        budgets,
      };
    case "beihilfe":
      return {
        ...base,
        vorname: "BP-Beihilfe",
        geburtsdatum: "1936-02-02",
        pflegegrad: 3,
        billingType: "pflegekasse_privat",
        acceptsPrivatePayment: true,
        beihilfeBerechtigt: true,
        insurance: insurance("B"),
        budgets,
      };
    case "gesetzlich":
      return {
        ...base,
        vorname: "BP-Gesetzlich",
        geburtsdatum: "1940-03-03",
        pflegegrad: 3,
        billingType: "pflegekasse_gesetzlich",
        acceptsPrivatePayment: false,
        rechnungAnKunde: false,
        insurance: insurance("G"),
        budgets,
      };
    case "selbstzahler":
      return {
        ...base,
        vorname: "BP-Selbstzahler",
        geburtsdatum: "1942-03-10",
        email: `bp-sz-${uniqueId()}@test.local`,
        pflegegrad: 2,
        billingType: "selbstzahler",
        acceptsPrivatePayment: true,
        insurance: insurance("S"),
      };
  }
}

interface TypedInvoice {
  customerId: number;
  invoiceId: number;
  provider: { id: number; name: string };
}

async function createTypedInvoice(
  key: BillingTypeKey,
  year: number,
  month: number,
  tag: string,
): Promise<TypedInvoice> {
  const provider = await createIsolatedProvider(tag);
  const customerId = await createCustomer(typedCustomerPayload(key, provider.id));
  const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, tag);
  await documentAppointment(appt.id, appt.time, hwServiceId, 30);
  await createAndSignServiceRecord(customerId, year, month);
  const ids = await generateInvoice(customerId, year, month);
  expect(ids.length, `${key}/${tag} darf nicht splitten`).toBe(1);
  return { customerId, invoiceId: ids[0], provider };
}

async function fetchBundleByPayer(
  providerId: number,
  year: number,
  month: number,
  format: "pdf" | "zip",
): Promise<{ status: number; contentType: string; buffer: Buffer }> {
  const res = await fetch(
    `${BASE_URL}/api/billing/bundle-by-payer?year=${year}&month=${month}&insuranceProviderId=${providerId}&format=${format}`,
    { headers: { Cookie: auth.cookie } },
  );
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    buffer: Buffer.from(await res.arrayBuffer()),
  };
}

async function bulkPrint(body: {
  billingMonth: number;
  billingYear: number;
  insuranceProviderId?: number;
  groupByPayer?: boolean;
}): Promise<{ status: number; contentType: string; buffer: Buffer }> {
  const res = await fetch(`${BASE_URL}/api/billing/bulk-print`, {
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
    buffer: Buffer.from(await res.arrayBuffer()),
  };
}

const PRINT_TYPES: Array<{ key: BillingTypeKey; label: string; expectedLn: number }> = [
  { key: "privat", label: "pflegekasse_privat", expectedLn: 1 },
  { key: "gesetzlich", label: "pflegekasse_gesetzlich", expectedLn: 1 },
  { key: "selbstzahler", label: "selbstzahler", expectedLn: 1 },
  { key: "beihilfe", label: "pflegekasse_privat + Beihilfe", expectedLn: 2 },
];

describe("LN-Dup: Kassen-Bündel & Sammeldruck enthalten den LN genau einmal (Task #1044)", () => {
  for (const t of PRINT_TYPES) {
    describe(t.label, () => {
      const { year, month } = recentPastWeekdayAnchor();
      // invA: read-only Bündel-Abfragen + Sammeldruck groupByPayer=false (konsumiert).
      // invB: separater Draft für Sammeldruck groupByPayer=true (konsumiert).
      let invA: TypedInvoice;
      let invB: TypedInvoice;

      beforeAll(async () => {
        invA = await createTypedInvoice(t.key, year, month, `${t.key}A`);
        invB = await createTypedInvoice(t.key, year, month, `${t.key}B`);
      }, 240_000);

      it(`bundle-by-payer PDF → genau ${t.expectedLn} LN`, async () => {
        const out = await fetchBundleByPayer(invA.provider.id, year, month, "pdf");
        expect(out.status, "bundle-by-payer PDF HTTP 200").toBe(200);
        expect(out.contentType).toContain("application/pdf");
        expect(await countLeistungsnachweise(out.buffer), `${t.label} bundle-by-payer PDF`).toBe(t.expectedLn);
      }, 120_000);

      it(`bundle-by-payer ZIP → genau ${t.expectedLn} LN`, async () => {
        const out = await fetchBundleByPayer(invA.provider.id, year, month, "zip");
        expect(out.status, "bundle-by-payer ZIP HTTP 200").toBe(200);
        expect(out.contentType).toContain("application/zip");
        expect(await countLeistungsnachweiseInZip(out.buffer), `${t.label} bundle-by-payer ZIP`).toBe(t.expectedLn);
      }, 120_000);

      it(`bulk-print groupByPayer=false → genau ${t.expectedLn} LN`, async () => {
        const out = await bulkPrint({
          billingMonth: month,
          billingYear: year,
          insuranceProviderId: invA.provider.id,
          groupByPayer: false,
        });
        expect(out.status, "bulk-print PDF HTTP 200").toBe(200);
        expect(out.contentType).toContain("application/pdf");
        expect(await countLeistungsnachweise(out.buffer), `${t.label} bulk-print PDF`).toBe(t.expectedLn);
      }, 120_000);

      it(`bulk-print groupByPayer=true → genau ${t.expectedLn} LN`, async () => {
        const out = await bulkPrint({
          billingMonth: month,
          billingYear: year,
          insuranceProviderId: invB.provider.id,
          groupByPayer: true,
        });
        expect(out.status, "bulk-print ZIP HTTP 200").toBe(200);
        expect(out.contentType).toContain("application/zip");
        expect(await countLeistungsnachweiseInZip(out.buffer), `${t.label} bulk-print ZIP`).toBe(t.expectedLn);
      }, 120_000);
    });
  }
});
