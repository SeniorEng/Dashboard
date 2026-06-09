import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1015 — End-to-End-Test für den Phantom-Storno-Abrechnungsfall.
 *
 * Task #1012 verhindert, dass ein Budget-Topf, dessen Verbrauch
 * ausschließlich aus stornierten/reversierten Buchungen besteht, eine eigene
 * Folge-Rechnung erzeugt. Bisher war das nur durch einen reinen Funktions-Test
 * (`tests/equality/phantom-storno-split.test.ts`) abgedeckt. Dieser Test läuft
 * den kompletten HTTP-Pfad durch (`/api/billing/preview` + `/api/billing/generate`).
 *
 * Szenario (analog Egon Uhlig, aber storniert):
 *   1. §45b (Priorität 1) hat nur 10,00 € frei, §45a (Priorität 2) genug.
 *   2. Ein Termin wird mit 60 min Alltagsbegleitung (42,00 €) dokumentiert →
 *      Cascade: §45b 10,00 € + §45a 32,00 € (zwei consumption-Zeilen).
 *   3. Der Termin wird wiedereröffnet (`/reopen`) → BEIDE Buchungen werden
 *      reversiert (§45b + §45a netto null).
 *   4. Re-Dokumentation mit nur 10 min (7,00 €) → §45b absorbiert alles
 *      (neue, lebende §45b-Buchung), §45a bleibt rein storniert.
 *   5. Abrechnung: Der §45a-Anteil ist nur durch eine stornierte Buchung
 *      entstanden → er darf KEINEN eigenen Topf/Rechnung mehr erzeugen.
 *      Erwartet: genau EINE §45b-Rechnung, kein splitInvoices.
 *
 * Vorschau (`/billing/preview`) und Generierung (`/billing/generate`) müssen
 * denselben (Single-Topf-)Stand liefern.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const YEAR = 2026;
const MONTH = 5;

const POT_45B_LIMIT_CENTS = 1000; // §45b: nur 10,00 € frei → erzwingt Overflow.
const POT_45A_LIMIT_CENTS = 50000; // §45a: reichlich Kapazität (Priorität 2).
const FULL_DURATION_MIN = 60; // Erst-Doku → 42,00 € (Overflow §45b → §45a).
const REDUCED_DURATION_MIN = 10; // Re-Doku → 7,00 € (passt komplett in §45b).
const EXPECTED_INVOICE_CENTS = 700; // AB 10 min @ 42 €/h = 7,00 €.

let customerId: number;
let employeeId: number;
let abServiceId: number;
let appointmentId: number;
let serviceRecordId: number;

beforeAll(async () => {
  await getAuthCookie();

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

  const providers = await apiGet<Array<{ id: number; name: string }>>("/api/admin/insurance-providers");
  expect(providers.status, `insurance-providers: ${JSON.stringify(providers.data)}`).toBe(200);
  const aok = providers.data.find((p) => /AOK PLUS/i.test(p.name));
  expect(aok, "AOK PLUS muss als Pflegekasse geseedet sein").toBeTruthy();

  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Petra",
    nachname: `Phantom-Storno-${uniqueId()}`,
    geburtsdatum: "1945-03-12",
    email: `phantom-${uniqueId()}@test.local`,
    strasse: "Stornoweg",
    nr: "7",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000099",
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

  const emp = await createTestEmployee({ nachnamePrefix: "Phantom_Integ" });
  employeeId = emp.id;

  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: employeeId,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);
});

afterAll(async () => {
  if (serviceRecordId) {
    try { await apiDelete(`/api/service-records/${serviceRecordId}`); } catch { /* best-effort */ }
  }
  if (appointmentId) {
    try { await apiDelete(`/api/appointments/${appointmentId}`); } catch { /* best-effort */ }
  }
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
  await runCleanup();
});

async function documentAppointment(actualDurationMinutes: number): Promise<void> {
  const docRes = await apiPost(`/api/appointments/${appointmentId}/document`, {
    actualStart: "13:00",
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: abServiceId, actualDurationMinutes, details: "Phantom-Storno-Repro" }],
  });
  expect(docRes.status, `document (${actualDurationMinutes}min): ${JSON.stringify(docRes.data)}`).toBe(200);
}

describe("Phantom-Storno über echten Rechnungslauf (Task #1015)", () => {
  it("storniert §45a-Anteil → nur EINE §45b-Rechnung, kein splitInvoices, Preview == Generate", async () => {
    // §45b: nur 10,00 € frei (Priorität 1, FIFO) → erzwingt Overflow.
    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: POT_45B_LIMIT_CENTS,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201], `init §45b: ${JSON.stringify(init45b.data)}`).toContain(init45b.status);
    // §45a: ausreichend Overflow-Kapazität (Priorität 2).
    const init45a = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a",
      currentMonthAmountCents: POT_45A_LIMIT_CENTS,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201], `init §45a: ${JSON.stringify(init45a.data)}`).toContain(init45a.status);

    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: POT_45B_LIMIT_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: POT_45A_LIMIT_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // Termin anlegen (60 min Alltagsbegleitung geplant).
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: `${YEAR}-0${MONTH}-05`,
      scheduledStart: "13:00",
      scheduledEnd: "14:00",
      notes: `Phantom-Storno-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: abServiceId, durationMinutes: FULL_DURATION_MIN }],
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    appointmentId = apptRes.data.id;

    // (1) Erst-Doku 60 min (42,00 €) → Cascade §45b 10,00 € + §45a 32,00 €.
    await documentAppointment(FULL_DURATION_MIN);

    // (2) Wiedereröffnen → reversiert BEIDE Buchungen (§45b + §45a netto null).
    const reopenRes = await apiPost(`/api/appointments/${appointmentId}/reopen`, {});
    expect(reopenRes.status, `reopen: ${JSON.stringify(reopenRes.data)}`).toBe(200);

    // (3) Re-Doku 10 min (7,00 €) → §45b absorbiert alles (lebende §45b-Buchung),
    //     §45a bleibt rein storniert (Phantom-Topf).
    await documentAppointment(REDUCED_DURATION_MIN);

    // Leistungsnachweis erstellen + signieren.
    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId, employeeId, year: YEAR, month: MONTH,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    serviceRecordId = srRes.data.id;
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${serviceRecordId}/sign`, {
        signerType, signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    // (4a) Vorschau: §45a (rein storniert) darf NICHT als Split-Topf auftauchen.
    const preview = await apiGet<{
      splitInvoices: boolean;
      splitPots: string[];
      totalCents: number;
      coveredAppointments: number;
    }>(`/api/billing/preview?customerId=${customerId}&month=${MONTH}&year=${YEAR}`);
    expect(preview.status, `preview: ${JSON.stringify(preview.data)}`).toBe(200);
    expect(preview.data.splitInvoices, "Phantom-§45a → kein Mehrtopf-Split").toBe(false);
    expect(preview.data.splitPots, "keine Split-Töpfe bei Single-Topf-Lauf").toEqual([]);
    expect(preview.data.totalCents, "Vorschau-Summe = lebende §45b-Buchung (7,00 €)").toBe(EXPECTED_INVOICE_CENTS);

    // (4b) Generierung: genau EINE Rechnung, kein splitInvoices.
    const genRes = await apiPost<{ id?: number; splitInvoices?: boolean; budgetType?: string | null; billingType?: string; grossAmountCents?: number; invoices?: unknown[] }>(
      "/api/billing/generate",
      { customerId, billingMonth: MONTH, billingYear: YEAR },
    );
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    expect(genRes.data.splitInvoices, "Single-Topf-Lauf darf NICHT splitInvoices=true liefern").not.toBe(true);
    expect(genRes.data.invoices, "Single-Topf-Lauf liefert keine invoices[]-Liste").toBeUndefined();
    expect(typeof genRes.data.id, "Single-Topf-Lauf liefert genau eine Rechnung (mit id)").toBe("number");
    expect(genRes.data.billingType, "Rechnung geht an die Pflegekasse (§45b), nicht Selbstzahler").toBe("pflegekasse_gesetzlich");
    expect(genRes.data.grossAmountCents, "Rechnungssumme = lebende §45b-Buchung (7,00 €)").toBe(EXPECTED_INVOICE_CENTS);

    // (4c) Persistenz-Gegenprobe: exakt EINE aktive Rechnung im Monat.
    const list = await apiGet<Array<{ id: number; status: string; invoiceType: string; billingMonth: number; billingYear: number }>>(
      `/api/billing?customerId=${customerId}&month=${MONTH}&year=${YEAR}`,
    );
    expect(list.status, `list: ${JSON.stringify(list.data)}`).toBe(200);
    const activeInvoices = list.data.filter(
      (inv) => inv.status !== "storniert" && inv.invoiceType !== "stornorechnung",
    );
    expect(activeInvoices.length, "Es darf genau EINE aktive Rechnung entstehen (keine Phantom-§45a-Rechnung)").toBe(1);
    expect(activeInvoices[0].id, "Die einzige Rechnung ist die generierte §45b-Rechnung").toBe(genRes.data.id);

    // (4d) Detail laden: Single-Topf → seit Task #1094 mit echtem Pot gestempelt
    //      (§45b), aber keiner Topf-Gruppe zugehörig, Summe = 7,00 €.
    const detail = await apiGet<{ budgetType: string | null; billingRunId: string | null; totalCents?: number; grossAmountCents?: number; lineItems?: Array<{ serviceCode: string | null; totalCents: number }> }>(
      `/api/billing/${genRes.data.id}`,
    );
    expect(detail.status, `detail: ${JSON.stringify(detail.data)}`).toBe(200);
    // Task #1094: Die Single-Pot-Kassenrechnung wird mit ihrem echten Budget-Topf
    // gestempelt (statt des früheren Legacy-NULL-Markers), damit der Renderer die
    // pot-spezifische §-Notiz/Überschrift verwendet.
    expect(detail.data.budgetType ?? null, "Single-Topf-§45b-Rechnung trägt seit Task #1094 ihren echten Pot-Marker").toBe("entlastungsbetrag_45b");
    expect(detail.data.billingRunId ?? null, "Single-Topf-Rechnung gehört zu keiner Topf-Gruppe").toBeNull();
    const lineItems = detail.data.lineItems ?? [];
    const abLines = lineItems.filter((li) => li.serviceCode === "alltagsbegleitung");
    expect(abLines.length, "genau eine Alltagsbegleitung-Zeile").toBe(1);
    expect(abLines[0].totalCents, "AB-Zeile = 7,00 € (re-dokumentierte 10 min)").toBe(EXPECTED_INVOICE_CENTS);
  }, 180_000);
});
