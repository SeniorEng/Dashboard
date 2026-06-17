import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Reproduktion der zwei Prod-Rechnungen für Kunde "Egon Uhlig" → AOK PLUS
 * (gesetzliche Pflegekasse), Mitarbeiter Marcel Fiebag, Abrechnungsmonat
 * April 2026.
 *
 * Prod-Vorlage (1:1 nachgebaut):
 *   RE-2026-0023 (Topf-Gruppe, §45b):  11,81 €
 *     - 02.04.2026 Alltagsbegleitung 30min  10,58 € + Anfahrt 7,00 km  1,23 €
 *   RE-2026-0022 (Topf-Gruppe, §45a):  66,91 €
 *     - 02.04.2026 Alltagsbegleitung 30min  10,42 € + Anfahrt 7,00 km  1,22 €
 *     - 09.04.2026 Hauswirtschaft 1h15      47,50 € + Anfahrt 22,20 km 7,77 €
 *
 * Szenario-Logik: §45b (Priorität 1, FIFO) hatte im April nur noch 11,81 €
 * frei → nimmt seinen Anteil am 02.04-Termin (proportional je Line-Item) und
 * ist erschöpft; §45a (Priorität 2, Umwandlung) übernimmt den Überlauf des
 * 02.04-Termins + den kompletten 09.04-Termin. Da beide Töpfe an dieselbe
 * gesetzliche Pflegekasse abgerechnet werden, erzeugt der Lauf zwei
 * Rechnungen mit gemeinsamer billingRunId ("Topf-Gruppe", Task #759).
 *
 * Hinweis: In der Realität beträgt der §45b-Monatsbetrag 131 €; hier ist nur
 * der zum Abrechnungszeitpunkt verbliebene Rest (11,81 €) modelliert, weil
 * genau dieser Rest die Prod-Aufteilung erzeugt hat.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import { prices } from "@shared/schema";
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
const MONTH = 4;

let customerId: number;
let employeeId: number;
let hwServiceId: number;
let abServiceId: number;
let travelKmServiceId: number;
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];

beforeAll(async () => {
  await getAuthCookie();

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;
  travelKmServiceId = services.data.find((s) => s.code === "travel_km")!.id;

  const providers = await apiGet<Array<{ id: number; name: string }>>("/api/admin/insurance-providers");
  expect(providers.status, `insurance-providers: ${JSON.stringify(providers.data)}`).toBe(200);
  const aok = providers.data.find((p) => /AOK PLUS/i.test(p.name));
  expect(aok, "AOK PLUS muss als Pflegekasse geseedet sein (exakter Prod-Empfänger)").toBeTruthy();

  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Egon",
    nachname: `Integ-Uhlig-${uniqueId()}`,
    geburtsdatum: "1942-05-10",
    email: `egon-${uniqueId()}@test.local`,
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

  // Prod-Kilometersatz war 0,35 €/km (Test-Seed liefert nur 0,30 €/km) →
  // kundenspezifischer travel_km-Preis = 35 ct, damit Verbrauchsbuchung UND
  // Rechnung den exakten Prod-Satz verwenden.
  await db.insert(prices).values({
    scope: "customer",
    origin: "customer_service_prices",
    customerId,
    serviceId: travelKmServiceId,
    cents: 35,
    validFrom: "2024-01-01",
  });

  const emp = await createTestEmployee({ vorname: "Marcel", nachnamePrefix: "Fiebag_Integ" });
  employeeId = emp.id;

  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: employeeId,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);
});

afterAll(async () => {
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
  scheduledStart: string,
  scheduledEnd: string,
  serviceId: number,
  durationMinutes: number,
  travelKilometers: number,
): Promise<void> {
  const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart,
    scheduledEnd,
    notes: `Egon-Uhlig-Repro-${uniqueId()}`,
    assignedEmployeeId: employeeId,
    services: [{ serviceId, durationMinutes }],
  });
  expect(apptRes.status, `appt ${date}: ${JSON.stringify(apptRes.data)}`).toBe(201);
  cleanupApptIds.push(apptRes.data.id);

  const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
    actualStart: scheduledStart,
    travelOriginType: "home",
    travelKilometers,
    customerKilometers: 0,
    services: [{ serviceId, actualDurationMinutes: durationMinutes, details: "Repro" }],
  });
  expect(docRes.status, `document ${date}: ${JSON.stringify(docRes.data)}`).toBe(200);
}

describe("Reproduktion Prod-Rechnungen Egon Uhlig (April 2026, §45b → §45a Topf-Gruppe)", () => {
  it("erzeugt 2 Rechnungen (11,81 € §45b + 66,91 € §45a) mit gemeinsamer billingRunId", async () => {
    // §45b: nur 11,81 € Rest frei (Priorität 1, FIFO) → erzwingt Cascade.
    const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 1181,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201]).toContain(init45b.status);
    // §45a: ausreichend Überlauf-Kapazität (Priorität 2).
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

    // Termine in Dokumentations-Reihenfolge (02.04 zuerst → konsumiert §45b-Rest).
    await createAndDocument(`${YEAR}-0${MONTH}-02`, "13:00", "13:30", abServiceId, 30, 7.0);
    await createAndDocument(`${YEAR}-0${MONTH}-09`, "13:15", "14:30", hwServiceId, 75, 22.2);

    // Leistungsnachweis erstellen + signieren.
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

    // Rechnungslauf → Topf-Gruppe (Split pro Topf).
    const genRes = await apiPost<{ splitInvoices?: boolean; invoices?: Array<{ id: number; billingRunId: string | null; budgetType: string | null; totalCents?: number }> }>(
      "/api/billing/generate",
      { customerId, billingMonth: MONTH, billingYear: YEAR },
    );
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    expect(genRes.data.splitInvoices, "Mehr-Topf-Lauf muss splitInvoices=true liefern").toBe(true);

    const invoices = genRes.data.invoices ?? [];
    expect(invoices.length, "Es müssen genau 2 Rechnungen entstehen").toBe(2);
    const billingRunIds = new Set(invoices.map((i) => i.billingRunId));
    expect(billingRunIds.size, "Beide Rechnungen müssen dieselbe billingRunId teilen (Topf-Gruppe)").toBe(1);

    // Detail je Rechnung laden + Report bauen.
    const report: Array<Record<string, unknown>> = [];
    for (const inv of invoices) {
      const detail = await apiGet<any>(`/api/billing/${inv.id}`);
      expect(detail.status, `detail ${inv.id}: ${JSON.stringify(detail.data)}`).toBe(200);
      const d = detail.data;
      const lineItems = (d.lineItems ?? d.items ?? []).map((li: any) => ({
        beschreibung: li.description ?? li.serviceName,
        serviceCode: li.serviceCode,
        menge: li.quantity,
        einzelpreisCent: li.unitPriceCents,
        gesamtCent: li.totalCents,
      }));
      const sumCents = lineItems.reduce((s: number, li: any) => s + (li.gesamtCent ?? 0), 0);
      const gesamtCent = d.totalCents ?? inv.totalCents ?? sumCents;
      report.push({
        invoiceId: inv.id,
        rechnungsnummer: d.invoiceNumber,
        budgetType: d.budgetType ?? inv.budgetType,
        empfaenger: d.recipientName ?? d.insuranceProviderName,
        billingType: d.billingType,
        billingRunId: d.billingRunId ?? inv.billingRunId,
        gesamtCent,
        gesamtEuro: (gesamtCent / 100).toFixed(2),
        lineItems,
      });
    }

    // Sortiert nach Betrag für stabilen Report (klein = §45b, groß = §45a).
    report.sort((a, b) => (a.gesamtCent as number) - (b.gesamtCent as number));
    // eslint-disable-next-line no-console
    console.log("\n===== REPRODUKTION EGON UHLIG — ERZEUGTE RECHNUNGEN =====\n" +
      JSON.stringify(report, null, 2) + "\n========================================================\n");

    const totals = report.map((r) => r.gesamtCent as number).sort((a, b) => a - b);
    expect(totals, "Beträge müssen exakt 11,81 € (§45b) und 66,91 € (§45a) sein").toEqual([1181, 6691]);

    const byPot = new Map(report.map((r) => [r.budgetType as string, r]));
    const pot45b = byPot.get("entlastungsbetrag_45b")!;
    const pot45a = byPot.get("umwandlung_45a")!;
    expect(pot45b?.gesamtCent, "§45b-Rechnung = 11,81 €").toBe(1181);
    expect(pot45a?.gesamtCent, "§45a-Rechnung = 66,91 €").toBe(6691);

    // 1:1-Line-Item-Fidelity gegen die Prod-Rechnungen.
    const lineCents = (r: any, code: string): number[] =>
      (r.lineItems as any[]).filter((li) => li.serviceCode === code)
        .map((li) => li.gesamtCent ?? 0).sort((a: number, b: number) => a - b);
    const sumByCode = (r: any, code: string): number =>
      lineCents(r, code).reduce((s, c) => s + c, 0);

    // Einzelpreise = Prod-Sätze (AB 42 €/h, HW 38 €/h, km 0,35 €).
    const allItems = [...(pot45b.lineItems as any[]), ...(pot45a.lineItems as any[])];
    for (const li of allItems.filter((x) => x.serviceCode === "alltagsbegleitung")) {
      expect(li.einzelpreisCent, "Alltagsbegleitung 42 €/h").toBe(4200);
    }
    for (const li of allItems.filter((x) => x.serviceCode === "hauswirtschaft")) {
      expect(li.einzelpreisCent, "Hauswirtschaft 38 €/h").toBe(3800);
    }
    for (const li of allItems.filter((x) => x.serviceCode === "travel_km")) {
      expect(li.einzelpreisCent, "Anfahrt 0,35 €/km").toBe(35);
    }

    // RE-2026-0023 (§45b): Alltagsbegleitung 10,58 € + Anfahrt 1,23 €
    expect(sumByCode(pot45b, "alltagsbegleitung"), "§45b Alltagsbegleitung = 10,58 €").toBe(1058);
    expect(lineCents(pot45b, "travel_km"), "§45b Anfahrt = 1,23 €").toEqual([123]);

    // RE-2026-0022 (§45a): Alltagsbegleitung 10,42 € + Hauswirtschaft 47,50 €
    //   + Anfahrt je Termin separat: 02.04 → 1,22 €, 09.04 → 7,77 €.
    expect(sumByCode(pot45a, "alltagsbegleitung"), "§45a Alltagsbegleitung = 10,42 €").toBe(1042);
    expect(sumByCode(pot45a, "hauswirtschaft"), "§45a Hauswirtschaft = 47,50 €").toBe(4750);
    expect(lineCents(pot45a, "travel_km"), "§45a Anfahrt-Lines = 1,22 € (02.04) + 7,77 € (09.04)").toEqual([122, 777]);
  }, 180_000);
});
