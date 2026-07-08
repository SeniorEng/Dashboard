/**
 * Task #1697 — Schutz gegen stilles Zurückfallen der Download-Namen auf
 * zufällige UUIDs / reine Rechnungsnummern.
 *
 * Task #1696 hat „sprechende" PDF-Dateinamen für die drei Einzel-Downloads
 * eingeführt (Rechnung, Leistungsnachweis, Bündel). Der reine Namens-Helfer
 * `buildSpeakingInvoiceFilename` ist unit-getestet, ABER es gab keinen Test, der
 * belegt, dass die drei echten HTTP-Routen den korrekten `Content-Disposition`-
 * Header auch tatsächlich senden. Ein Refactor der PDF-Response-Pfade könnte den
 * Header still entfernen und wieder UUID-/nur-Nummer-Dateinamen einführen, ohne
 * dass ein Test rot wird.
 *
 * Dieser Test fixiert die HTTP-Vertrags-Invariante für:
 *   GET /billing/:id/pdf
 *   GET /billing/:id/leistungsnachweis
 *   GET /billing/:id/bundle
 *
 * Für jede Route wird geprüft, dass der `Content-Disposition`-Header
 *   1. den ASCII-Fallback `filename="…"` UND
 *   2. die RFC-5987-Variante `filename*=UTF-8''…`
 * enthält und exakt dem entspricht, was `buildSpeakingInvoiceFilename` +
 * `buildContentDisposition` liefern (SSoT).
 *
 * Abgedeckt:
 *   - Kunde mit Umlaut im Namen → Umlaut überlebt in `filename*` (UTF-8),
 *     wird im ASCII-Fallback zu `_`.
 *   - Selbstzahler (LN wird on-the-fly gerendert) UND Pflegekasse (LN aus dem
 *     Cache) — beide LN-Pfade werden ausgeführt.
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
  buildContentDisposition,
  type SpeakingInvoiceDocumentKind,
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
        notes: `DL-${noteTag}-${uniqueId()}`,
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
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details: "DL-Doc" }],
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
    name: `DLKasse-${tag}-${uniqueId()}`,
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

async function fetchDisposition(path: string): Promise<{ status: number; disposition: string | null }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: auth.cookie } });
  // Body muss konsumiert werden, damit die Verbindung freigegeben wird.
  await res.arrayBuffer();
  return { status: res.status, disposition: res.headers.get("content-disposition") };
}

/**
 * Prüft für einen der drei Download-Endpunkte, dass der Content-Disposition-
 * Header EXAKT dem SSoT-Namen entspricht und beide Filename-Varianten trägt.
 */
async function expectSpeakingDisposition(args: {
  path: string;
  invoiceNumber: string;
  vorname: string;
  nachname: string;
  kind: SpeakingInvoiceDocumentKind;
}): Promise<void> {
  const { path, invoiceNumber, vorname, nachname, kind } = args;
  const { status, disposition } = await fetchDisposition(path);
  expect(status, `${path} HTTP 200`).toBe(200);
  expect(disposition, `${path} hat Content-Disposition`).toBeTruthy();

  const expectedFilename = buildSpeakingInvoiceFilename({
    invoiceNumber,
    vorname,
    nachname,
    kind,
  });
  const expectedHeader = buildContentDisposition(expectedFilename, "inline");

  // Vertrag: der tatsächliche Header ist byte-identisch mit dem SSoT-Helper.
  expect(disposition, `${path} Content-Disposition == SSoT`).toBe(expectedHeader);

  // Redundant, aber selbst-erklärend gegen künftige Regressionen: beide
  // Filename-Varianten sind vorhanden.
  const asciiFallback = expectedFilename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_"); // eslint-disable-line no-control-regex
  expect(disposition!, `${path} enthält ASCII filename=`).toContain(`filename="${asciiFallback}"`);
  expect(disposition!, `${path} enthält RFC-5987 filename*`).toContain(
    `filename*=UTF-8''${encodeURIComponent(expectedFilename)}`,
  );
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

describe("Sprechende Download-Dateinamen: Content-Disposition der drei Einzel-Downloads (Task #1697)", () => {
  it("Pflegekasse (LN aus Cache): /pdf, /leistungsnachweis und /bundle tragen den sprechenden Namen inkl. Umlaut", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    const vorname = "Jörg";
    const nachname = `Müller-Schäfer-${uniqueId()}`;

    const provider = await createDedicatedProvider("GK");
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
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "gk");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "gesetzlich darf nicht splitten").toBe(1);
    const invoiceId = ids[0];
    const invoiceNumber = await getInvoiceNumber(invoiceId);

    // Umlaut-Sanity: der Nachname trägt tatsächlich Umlaute, sonst wäre der
    // filename*-Nachweis wertlos.
    expect(nachname, "Nachname enthält Umlaut").toMatch(/[äöüÄÖÜ]/);

    await expectSpeakingDisposition({
      path: `/api/billing/${invoiceId}/pdf`,
      invoiceNumber,
      vorname,
      nachname,
      kind: "invoice",
    });
    await expectSpeakingDisposition({
      path: `/api/billing/${invoiceId}/leistungsnachweis`,
      invoiceNumber,
      vorname,
      nachname,
      kind: "leistungsnachweis",
    });
    await expectSpeakingDisposition({
      path: `/api/billing/${invoiceId}/bundle`,
      invoiceNumber,
      vorname,
      nachname,
      kind: "bundle",
    });
  }, 300_000);

  it("Selbstzahler (LN on-the-fly gerendert): /pdf, /leistungsnachweis und /bundle tragen den sprechenden Namen inkl. Umlaut", async () => {
    const { year, month } = recentPastWeekdayAnchor();

    const vorname = "Günther";
    const nachname = `Öztürk-${uniqueId()}`;

    const customerId = await createCustomer({
      vorname,
      nachname,
      geburtsdatum: "1945-07-07",
      strasse: "Selbstweg",
      nr: "9",
      plz: "10117",
      stadt: "Berlin",
      pflegegrad: 2,
      pflegegradSeit: "2024-01-01",
      email: `dl-sz-${uniqueId()}@example.com`,
      billingType: "selbstzahler",
      acceptsPrivatePayment: true,
    });
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "sz");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "Selbstzahler darf nicht splitten").toBe(1);
    const invoiceId = ids[0];
    const invoiceNumber = await getInvoiceNumber(invoiceId);

    expect(nachname, "Nachname enthält Umlaut").toMatch(/[äöüÄÖÜ]/);

    await expectSpeakingDisposition({
      path: `/api/billing/${invoiceId}/pdf`,
      invoiceNumber,
      vorname,
      nachname,
      kind: "invoice",
    });
    // Selbstzahler → kein LN-Cache; die Route rendert den LN on-the-fly.
    await expectSpeakingDisposition({
      path: `/api/billing/${invoiceId}/leistungsnachweis`,
      invoiceNumber,
      vorname,
      nachname,
      kind: "leistungsnachweis",
    });
    await expectSpeakingDisposition({
      path: `/api/billing/${invoiceId}/bundle`,
      invoiceNumber,
      vorname,
      nachname,
      kind: "bundle",
    });
  }, 300_000);
});
