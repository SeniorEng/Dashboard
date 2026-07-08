/**
 * Task #1700 — Sprechende Datei-Namen auch für den Krankenkassen-Bündel-Download.
 *
 * Task #1698 hatte bereits den TOP-LEVEL-Dateinamen des Bündels
 * (`<Pflegekasse> - <YYYY-MM> - Sammelbündel.<ext>`) auf einen sprechenden Namen
 * umgestellt. Die ZIP-EINTRÄGE trugen aber weiterhin reine
 * Rechnungsnummer-Namen (`<Nr>-Rechnung.pdf` / `<Nr>-Leistungsnachweis.pdf`).
 * Task #1700 gleicht die Eintrags-Namen an die drei Einzel-Downloads an:
 * `Rechnungsnummer - Nachname, Vorname - Dokumentart.pdf` (Umlaute bewahrt,
 * filesystem-sicher, innerhalb des Archivs kollisionsfrei de-dupliziert).
 *
 * Dieser Test fixiert die HTTP-Vertrags-Invariante für:
 *   GET /billing/bundle-by-payer?format=zip
 *   GET /billing/bundle-by-payer?format=pdf
 *
 * Geprüft wird:
 *   1. Der Top-Level-`Content-Disposition` == `buildSpeakingKassenBundleFilename`
 *      + `buildContentDisposition` (SSoT), inkl. beider filename-Varianten.
 *   2. Die ZIP-Eintrags-Namen == `buildSpeakingInvoiceFilename` (Rechnung + LN),
 *      gemeinsam über `dedupeExportFilenames` de-dupliziert. Umlaut überlebt im
 *      Eintrags-Namen.
 *
 * Tests laufen seriell gegen eine isolierte Wegwerf-Test-DB pro Worker; jeder
 * Test legt eigene Kunden an und räumt im afterAll auf.
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
import {
  buildSpeakingInvoiceFilename,
  buildSpeakingKassenBundleFilename,
  buildContentDisposition,
  dedupeExportFilenames,
} from "@shared/domain/invoice-export-filename";

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
        notes: `BP-${noteTag}-${uniqueId()}`,
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
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details: "BP-Doc" }],
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
    name: `BPKasse-${tag}-${uniqueId()}`,
    ikNummer: ik,
    isPrivate: false,
  });
  if (res.status !== 201) {
    throw new Error(`createDedicatedProvider failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { id: res.data.id, name: res.data.name };
}

async function getInvoiceNumber(invoiceId: number): Promise<string> {
  const res = await apiGet<{ id: number; invoiceNumber: string }>(`/api/billing/${invoiceId}`);
  expect(res.status, `GET /api/billing/${invoiceId} HTTP 200`).toBe(200);
  return res.data.invoiceNumber;
}

async function fetchBundle(path: string): Promise<{ status: number; disposition: string | null; buffer: Buffer }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: auth.cookie } });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, disposition: res.headers.get("content-disposition"), buffer };
}

async function readZipEntryNames(buf: Buffer): Promise<string[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  return Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name);
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

describe("Sprechende Bündel-Download-Dateinamen: /billing/bundle-by-payer (Task #1700)", () => {
  it("ZIP: Top-Level-Name UND Eintrags-Namen sind sprechend (Rechnung + LN), Umlaut überlebt", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    const vorname = "Jörg";
    const nachname = `Müller-Schäfer-${uniqueId()}`;

    const provider = await createDedicatedProvider("ZIP");
    const customerId = await createCustomer({
      vorname,
      nachname,
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
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "zip");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "gesetzlich darf nicht splitten").toBe(1);
    const invoiceNumber = await getInvoiceNumber(ids[0]);

    expect(nachname, "Nachname enthält Umlaut").toMatch(/[äöüÄÖÜ]/);

    const { status, disposition, buffer } = await fetchBundle(
      `/api/billing/bundle-by-payer?year=${year}&month=${month}&insuranceProviderId=${provider.id}&format=zip`,
    );
    expect(status, "bundle-by-payer zip HTTP 200").toBe(200);

    // 1. Top-Level-Name == SSoT.
    const expectedTop = buildContentDisposition(
      buildSpeakingKassenBundleFilename({ providerName: provider.name, year, month, extension: "zip" }),
      "attachment",
    );
    expect(disposition, "Top-Level Content-Disposition == SSoT").toBe(expectedTop);

    // 2. ZIP-Eintrags-Namen == SSoT (Rechnung + LN, gemeinsam de-dupliziert).
    const entryNames = await readZipEntryNames(buffer);
    const expectedEntries = dedupeExportFilenames([
      buildSpeakingInvoiceFilename({ invoiceNumber, vorname, nachname, kind: "invoice" }),
      buildSpeakingInvoiceFilename({ invoiceNumber, vorname, nachname, kind: "leistungsnachweis" }),
    ]);
    // Reihenfolge (Rechnung vor LN) ist deterministisch.
    expect(entryNames, "ZIP-Eintrags-Namen == sprechende SSoT-Namen").toEqual(expectedEntries);
    // Umlaut überlebt im Eintrags-Namen.
    expect(entryNames.join("\n"), "Eintrags-Name trägt Umlaut").toMatch(/[äöüÄÖÜ]/);
    // Keine reinen Rechnungsnummer-Namen mehr.
    for (const name of entryNames) {
      expect(name, "kein `<Nr>-Rechnung.pdf` Altmuster").not.toMatch(/^\S+-Rechnung\.pdf$/);
    }
  }, 300_000);

  it("PDF: Top-Level-Name ist sprechend (Sammelbündel)", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    const provider = await createDedicatedProvider("PDF");
    const customerId = await createCustomer({
      vorname: "Günther",
      nachname: `Öztürk-${uniqueId()}`,
      geburtsdatum: "1942-05-05",
      strasse: "Kassenweg",
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
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "pdf");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "gesetzlich darf nicht splitten").toBe(1);

    const { status, disposition } = await fetchBundle(
      `/api/billing/bundle-by-payer?year=${year}&month=${month}&insuranceProviderId=${provider.id}&format=pdf`,
    );
    expect(status, "bundle-by-payer pdf HTTP 200").toBe(200);

    const expectedTop = buildContentDisposition(
      buildSpeakingKassenBundleFilename({ providerName: provider.name, year, month, extension: "pdf" }),
      "inline",
    );
    expect(disposition, "Top-Level Content-Disposition == SSoT").toBe(expectedTop);
  }, 300_000);
});
