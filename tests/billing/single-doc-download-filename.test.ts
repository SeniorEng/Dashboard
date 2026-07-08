/**
 * Task #1701 — Sprechender Content-Disposition-Header beim Einzel-Download
 * (Rechnung / Leistungsnachweis / Bündel) aus dem Rechnungs-Zeilen-Menü.
 *
 * Task #1696 hat den „sprechenden" Datei-Namen
 *   `Rechnungsnummer - Nachname, Vorname - Dokumentart.pdf`
 * eingeführt (ASCII-Fallback + RFC-5987 `filename*`, Umlaute BEWAHRT). Bislang
 * war nur der reine String-Helfer (`buildSpeakingInvoiceFilename` /
 * `buildContentDisposition`) unit-getestet — die ROUTE-Verdrahtung
 * (`setSpeakingPdfDisposition` in server/routes/billing.ts) hatte keinen
 * Route-/Integration-Test. Ein Refactor könnte den lesbaren, umlaut-sicheren
 * Header still fallen lassen, ohne dass ein Test fehlschlägt.
 *
 * Dieser Test trifft alle drei Einzel-Download-Routen einer echten Rechnung
 * eines Kunden mit Umlaut im Nachnamen und fixiert, dass der
 * Content-Disposition-Header
 *   - den ASCII-Fallback (`filename="…"`) trägt,
 *   - die RFC-5987-Variante (`filename*=UTF-8''…`, percent-encoded) trägt und
 *   - je Dokumentart die korrekte Dokumentart-Bezeichnung enthält.
 *
 * Isolation: Ein eigener Kunde pro Lauf (Umlaut-Nachname), im afterAll
 * aufgeräumt. Object-Storage-Guard via `describe` aus tests/helpers/
 * object-storage → sauberer Skip im No-Sidecar-CI, analog
 * tests/billing/bundle-duplicate-ln.test.ts.
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
} from "../../shared/domain/invoice-export-filename";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;

const cleanupCustomerIds: number[] = [];

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
        notes: `SDDL-${noteTag}-${uniqueId()}`,
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
    services: [{ serviceId, actualDurationMinutes: actualMinutes, details: "SDDL-Doc" }],
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
  const res = await apiPost<{ id: number; name: string }>("/api/admin/insurance-providers", {
    name: `SDDLKasse-${tag}-${uniqueId()}`,
    ikNummer: String(Math.floor(100000000 + Math.random() * 900000000)),
    isPrivate: false,
  });
  if (res.status !== 201) {
    throw new Error(`createDedicatedProvider failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { id: res.data.id, name: res.data.name };
}

async function fetchHeaders(
  path: string,
): Promise<{ status: number; contentType: string; contentDisposition: string }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: auth.cookie } });
  // Body drainen, damit keine offenen Sockets/Timer den Test-Prozess halten.
  await res.arrayBuffer();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    contentDisposition: res.headers.get("content-disposition") ?? "",
  };
}

// Der Umlaut-Nachname stellt sicher, dass sowohl der ASCII-Fallback (Umlaut → `_`)
// als auch die RFC-5987-Variante (percent-encoded UTF-8) geprüft werden.
const UMLAUT_VORNAME = "Jörg";
const UMLAUT_NACHNAME = "Müller-Schäfer";

interface CreatedInvoice {
  invoiceId: number;
  invoiceNumber: string;
  vorname: string;
  nachname: string;
}

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

describe("Einzel-Download-Header: sprechender Datei-Name mit Umlaut (Task #1701)", () => {
  let created: CreatedInvoice;

  beforeAll(async () => {
    const { year, month } = recentPastWeekdayAnchor();
    const provider = await createDedicatedProvider(`P${Date.now().toString(36)}`);
    const customerId = await createCustomer({
      vorname: UMLAUT_VORNAME,
      nachname: `${UMLAUT_NACHNAME}-${uniqueId()}`,
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
    const appt = await createAppointmentInMonth(customerId, hwServiceId, 30, year, month, "single");
    await documentAppointment(appt.id, appt.time, hwServiceId, 30);
    await createAndSignServiceRecord(customerId, year, month);
    const ids = await generateInvoice(customerId, year, month);
    expect(ids.length, "privat darf nicht splitten").toBe(1);

    const detail = await apiGet<{ invoiceNumber: string; customerVorname?: string | null; customerNachname?: string | null }>(
      `/api/billing/${ids[0]}`,
    );
    expect(detail.status, "GET /api/billing/:id HTTP 200").toBe(200);

    created = {
      invoiceId: ids[0],
      invoiceNumber: detail.data.invoiceNumber,
      vorname: detail.data.customerVorname ?? UMLAUT_VORNAME,
      nachname: detail.data.customerNachname ?? UMLAUT_NACHNAME,
    };
  }, 240_000);

  const cases: Array<{ kind: SpeakingInvoiceDocumentKind; path: (id: number) => string; label: string }> = [
    { kind: "invoice", path: (id) => `/api/billing/${id}/pdf`, label: "Rechnung" },
    { kind: "leistungsnachweis", path: (id) => `/api/billing/${id}/leistungsnachweis`, label: "Leistungsnachweis" },
    { kind: "bundle", path: (id) => `/api/billing/${id}/bundle`, label: "Rechnung+Leistungsnachweis" },
  ];

  for (const c of cases) {
    it(`${c.kind}: Content-Disposition trägt den sprechenden Namen (ASCII-Fallback + filename*)`, async () => {
      const out = await fetchHeaders(c.path(created.invoiceId));
      expect(out.status, `${c.kind} HTTP 200`).toBe(200);
      expect(out.contentType).toContain("application/pdf");

      const expectedFilename = buildSpeakingInvoiceFilename({
        invoiceNumber: created.invoiceNumber,
        vorname: created.vorname,
        nachname: created.nachname,
        kind: c.kind,
      });
      const expectedHeader = buildContentDisposition(expectedFilename, "inline");

      // Exakt der vom Helfer erzeugte Header — schützt die Route-Verdrahtung
      // gegen ein stilles Weglassen von ASCII-Fallback ODER filename*.
      expect(out.contentDisposition).toBe(expectedHeader);

      // Zusätzliche, explizite Zusicherungen (falls der Helfer sich ändert,
      // bleiben die fachlichen Garantien sichtbar):
      // 1) ASCII-Fallback: Umlaute werden ausgeschrieben (`ü→ue`, `ä→ae`),
      //    keine Roh-Umlaute und kein `_` an Umlaut-Stelle mehr (Task #1706).
      expect(out.contentDisposition).toContain('filename="');
      expect(out.contentDisposition).toMatch(/filename="[^"]*Mueller-Schaefer[^"]*"/);
      // 2) RFC-5987: percent-encodete UTF-8-Variante mit erhaltenem Umlaut.
      expect(out.contentDisposition).toContain("filename*=UTF-8''");
      expect(out.contentDisposition).toContain(encodeURIComponent(expectedFilename));
      // 3) Dokumentart-Bezeichnung ist enthalten.
      expect(decodeURIComponent(out.contentDisposition)).toContain(c.label);
    }, 120_000);
  }
});
