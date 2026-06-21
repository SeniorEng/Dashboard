import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1378 — Storno-Topf-Isolation für §45a-Überlauf und 3-Topf-Läufe.
 *
 * Erweitert die Regression aus Task #1377 (`storno-pot-isolation.test.ts`,
 * Fall §45b + privat) um die weiteren Topf-Kombinationen, die der
 * Consumption-Engine real bucht und die denselben pot-bewussten
 * `performStorno`-Reversal-Code in `PATCH /api/billing/:id/status`
 * durchlaufen:
 *
 *   1. §45a-Überlauf in den privaten Topf → Storno NUR der Privat-Rechnung
 *      lässt den §45a-Netto-Verbrauch unangetastet.
 *
 *   2. 3-Topf-Split (§45b + §45a + privat):
 *      a) Storno EINER Topf-Rechnung berührt ausschließlich deren Topf, die
 *         beiden lebenden Geschwister-Töpfe bleiben unverändert.
 *      b) `cascadeRun=true` storniert weiterhin ALLE Geschwister-Rechnungen
 *         der `billing_run_id` — alle Töpfe netto zurückgebucht.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import { and, eq } from "drizzle-orm";
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
// Pro Szenario ein EIGENES Termin-Datum (gleicher Mitarbeiter → sonst Slot-409).
const DATE_45A = `${YEAR}-0${MONTH}-08`; // Mi
const DATE_3POT_SINGLE = `${YEAR}-0${MONTH}-09`; // Do
const DATE_3POT_CASCADE = `${YEAR}-0${MONTH}-10`; // Fr

let employeeId: number;
let abServiceId: number;
const cleanupCustomerIds: number[] = [];
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];

interface PotSetting {
  budgetType: "entlastungsbetrag_45b" | "umwandlung_45a" | "ersatzpflege_39_42a";
  enabled: boolean;
  priority: number;
  /** Falls gesetzt: initial-budget + monatlicher Cap auf diesen Wert. */
  capCents: number | null;
}

interface Scenario {
  customerId: number;
  apptId: number;
}

/** Netto-Verbrauch (consumption + reversal) eines Topfes in Cent. */
async function netConsumedCents(customerId: number, budgetType: string): Promise<number> {
  const rows = await db
    .select()
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, budgetType),
      ),
    );
  return rows.reduce((s, r) => s + r.amountCents, 0);
}

/**
 * Legt einen Kunden mit den übergebenen Topf-Einstellungen an, bucht EINEN
 * 60-Minuten-Alltagsbegleitung-Termin (Kosten 42,00 € → überläuft jeden klein
 * gedeckelten Topf in den privaten Pot) und signiert den Leistungsnachweis
 * doppelt (Pflegekasse → status=completed). Gibt customerId + apptId zurück.
 */
async function setupScenario(pots: PotSetting[], apptDate: string): Promise<Scenario> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Storno",
    nachname: `PotIso2-${uniqueId()}`,
    geburtsdatum: "1942-05-10",
    email: `storno-potiso2-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "12",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000001",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    // Überlauf darf in den privaten Topf laufen.
    acceptsPrivatePayment: true,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  const customerId = custRes.data.id;
  cleanupCustomerIds.push(customerId);

  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: employeeId,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  // Initial-Budget je aktivem, gedeckeltem Topf (klein → erzwingt Überlauf).
  for (const p of pots) {
    if (!p.enabled || p.capCents == null) continue;
    const init = await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: p.budgetType,
      currentMonthAmountCents: p.capCents,
      carryoverAmountCents: 0,
      budgetStartDate: `${YEAR}-0${MONTH}-01`,
    });
    expect([200, 201], `initial-budget ${p.budgetType}: ${JSON.stringify(init.data)}`).toContain(init.status);
  }

  const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: pots.map((p) => ({
      budgetType: p.budgetType,
      enabled: p.enabled,
      priority: p.priority,
      monthlyLimitCents: p.enabled ? p.capCents : null,
      yearlyLimitCents: null,
      validFrom: null,
      validTo: null,
    })),
  });
  expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

  // Ein Termin (Alltagsbegleitung 60 min, 42,00 €) — überläuft jeden Topf.
  const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId,
    date: apptDate,
    scheduledStart: "13:00",
    scheduledEnd: "14:00",
    notes: `Storno-PotIso2-${uniqueId()}`,
    assignedEmployeeId: employeeId,
    services: [{ serviceId: abServiceId, durationMinutes: 60 }],
  });
  expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
  cleanupApptIds.push(apptRes.data.id);

  const docRes = await apiPost(`/api/appointments/${apptRes.data.id}/document`, {
    actualStart: "13:00",
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "PotIso2" }],
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

  return { customerId, apptId: apptRes.data.id };
}

interface GeneratedInvoice {
  id: number;
  billingRunId: string | null;
  budgetType: string | null;
}

async function generateSplit(customerId: number): Promise<GeneratedInvoice[]> {
  const genRes = await apiPost<{ splitInvoices?: boolean; invoices?: GeneratedInvoice[] }>(
    "/api/billing/generate",
    { customerId, billingMonth: MONTH, billingYear: YEAR },
  );
  expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
  expect(genRes.data.splitInvoices, "Mehr-Topf-Lauf muss splitInvoices=true liefern").toBe(true);
  const invoices = genRes.data.invoices ?? [];
  const runIds = new Set(invoices.map((i) => i.billingRunId));
  expect(runIds.size, "Alle Rechnungen müssen dieselbe billingRunId teilen").toBe(1);
  expect([...runIds][0], "billingRunId muss gesetzt sein").toBeTruthy();
  return invoices;
}

beforeAll(async () => {
  await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

  const emp = await createTestEmployee({ nachnamePrefix: "PotIso2_Integ" });
  employeeId = emp.id;
});

afterAll(async () => {
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ }
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
  }
  for (const id of cleanupCustomerIds) {
    try { await cleanupCustomer(id); } catch { /* best-effort */ }
  }
  await deactivateTestEmployee(employeeId);
  await runCleanup();
});

describe("Pot-Storno-Isolation §45a-Überlauf (Task #1378)", () => {
  it("storniert nur den privaten Topf, §45a-Netto bleibt unverändert", async () => {
    // §45a auf 500 ct gedeckelt → Termin (4200 ct) überläuft in den privaten Topf.
    const { customerId } = await setupScenario([
      { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, capCents: null },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, capCents: 500 },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, capCents: null },
    ], DATE_45A);

    const invoices = await generateSplit(customerId);
    expect(invoices.length, "Es müssen genau 2 Rechnungen entstehen (§45a + privat)").toBe(2);

    const pot45aInvoice = invoices.find((i) => i.budgetType === "umwandlung_45a");
    const privateInvoice = invoices.find((i) => i.budgetType == null);
    expect(pot45aInvoice, "§45a-Rechnung muss existieren").toBeTruthy();
    expect(privateInvoice, "Privat-Rechnung (budgetType NULL) muss existieren").toBeTruthy();

    const net45aBefore = await netConsumedCents(customerId, "umwandlung_45a");
    const netPrivateBefore = await netConsumedCents(customerId, "private");
    expect(net45aBefore, "§45a verbraucht 500 ct").toBe(-500);
    expect(netPrivateBefore, "privater Topf trägt den Überlauf (> 0)").toBeLessThan(0);

    // NUR die Privat-Rechnung stornieren (kein cascadeRun → §45a bleibt lebend).
    const stornoRes = await apiPatch(`/api/billing/${privateInvoice!.id}/status`, {
      status: "storniert",
    });
    expect(stornoRes.status, `storno privat: ${JSON.stringify(stornoRes.data)}`).toBe(200);

    const pot45aDetail = await apiGet<{ status: string }>(`/api/billing/${pot45aInvoice!.id}`);
    expect(pot45aDetail.data.status, "§45a-Rechnung darf NICHT storniert sein").not.toBe("storniert");

    // KERN-ASSERTION: §45a-Netto unverändert, privater Topf netto null.
    const net45aAfter = await netConsumedCents(customerId, "umwandlung_45a");
    const netPrivateAfter = await netConsumedCents(customerId, "private");
    expect(net45aAfter, "§45a-Netto bleibt nach Privat-Storno unverändert").toBe(net45aBefore);
    expect(netPrivateAfter, "privater Topf ist nach Storno netto null zurückgebucht").toBe(0);
  }, 180_000);
});

describe("Pot-Storno-Isolation 3-Topf-Lauf §45b + §45a + privat (Task #1378)", () => {
  it("storniert nur den §45a-Topf, §45b und privat bleiben unverändert", async () => {
    // §45b + §45a je auf 500 ct gedeckelt → Termin (4200 ct) splittet 3-fach.
    const { customerId } = await setupScenario([
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, capCents: 500 },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, capCents: 500 },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, capCents: null },
    ], DATE_3POT_SINGLE);

    const invoices = await generateSplit(customerId);
    expect(invoices.length, "Es müssen genau 3 Rechnungen entstehen (§45b + §45a + privat)").toBe(3);

    const pot45bInvoice = invoices.find((i) => i.budgetType === "entlastungsbetrag_45b");
    const pot45aInvoice = invoices.find((i) => i.budgetType === "umwandlung_45a");
    const privateInvoice = invoices.find((i) => i.budgetType == null);
    expect(pot45bInvoice, "§45b-Rechnung muss existieren").toBeTruthy();
    expect(pot45aInvoice, "§45a-Rechnung muss existieren").toBeTruthy();
    expect(privateInvoice, "Privat-Rechnung (budgetType NULL) muss existieren").toBeTruthy();

    const net45bBefore = await netConsumedCents(customerId, "entlastungsbetrag_45b");
    const net45aBefore = await netConsumedCents(customerId, "umwandlung_45a");
    const netPrivateBefore = await netConsumedCents(customerId, "private");
    expect(net45bBefore, "§45b verbraucht 500 ct").toBe(-500);
    expect(net45aBefore, "§45a verbraucht 500 ct").toBe(-500);
    expect(netPrivateBefore, "privater Topf trägt den Überlauf (> 0)").toBeLessThan(0);

    // NUR die §45a-Rechnung stornieren (kein cascadeRun).
    const stornoRes = await apiPatch(`/api/billing/${pot45aInvoice!.id}/status`, {
      status: "storniert",
    });
    expect(stornoRes.status, `storno §45a: ${JSON.stringify(stornoRes.data)}`).toBe(200);

    // Geschwister-Rechnungen leben weiter.
    const pot45bDetail = await apiGet<{ status: string }>(`/api/billing/${pot45bInvoice!.id}`);
    const privateDetail = await apiGet<{ status: string }>(`/api/billing/${privateInvoice!.id}`);
    expect(pot45bDetail.data.status, "§45b-Rechnung darf NICHT storniert sein").not.toBe("storniert");
    expect(privateDetail.data.status, "Privat-Rechnung darf NICHT storniert sein").not.toBe("storniert");

    // KERN-ASSERTION: nur §45a netto null, §45b und privat unverändert.
    const net45bAfter = await netConsumedCents(customerId, "entlastungsbetrag_45b");
    const net45aAfter = await netConsumedCents(customerId, "umwandlung_45a");
    const netPrivateAfter = await netConsumedCents(customerId, "private");
    expect(net45aAfter, "§45a-Netto ist null zurückgebucht").toBe(0);
    expect(net45bAfter, "§45b-Netto bleibt unverändert").toBe(net45bBefore);
    expect(netPrivateAfter, "privater Topf bleibt unverändert").toBe(netPrivateBefore);
  }, 180_000);

  it("storniert mit cascadeRun=true ALLE Topf-Rechnungen des Laufs", async () => {
    const { customerId } = await setupScenario([
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, capCents: 500 },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, capCents: 500 },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, capCents: null },
    ], DATE_3POT_CASCADE);

    const invoices = await generateSplit(customerId);
    expect(invoices.length, "Es müssen genau 3 Rechnungen entstehen (§45b + §45a + privat)").toBe(3);

    expect(await netConsumedCents(customerId, "entlastungsbetrag_45b")).toBe(-500);
    expect(await netConsumedCents(customerId, "umwandlung_45a")).toBe(-500);
    expect(await netConsumedCents(customerId, "private")).toBeLessThan(0);

    // Cascade-Storno EINER Rechnung storniert alle Geschwister des Laufs.
    const stornoRes = await apiPatch(`/api/billing/${invoices[0].id}/status`, {
      status: "storniert",
      cascadeRun: true,
    });
    expect(stornoRes.status, `cascade-storno: ${JSON.stringify(stornoRes.data)}`).toBe(200);

    for (const inv of invoices) {
      const detail = await apiGet<{ status: string }>(`/api/billing/${inv.id}`);
      expect(detail.data.status, `Rechnung ${inv.id} (${inv.budgetType ?? "privat"}) muss storniert sein`).toBe("storniert");
    }

    // KERN-ASSERTION: alle Töpfe netto null zurückgebucht.
    expect(await netConsumedCents(customerId, "entlastungsbetrag_45b"), "§45b netto null").toBe(0);
    expect(await netConsumedCents(customerId, "umwandlung_45a"), "§45a netto null").toBe(0);
    expect(await netConsumedCents(customerId, "private"), "privat netto null").toBe(0);
  }, 180_000);
});
