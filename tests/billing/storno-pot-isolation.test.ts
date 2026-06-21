import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #1377 — Pot-bewusster Rechnungs-Storno.
 *
 * Bei Multi-Topf-Abrechnung trägt EIN Termin Konsumptionen in mehreren Töpfen
 * (hier §45b + privat), die als getrennte Rechnungen pro Topf ausgestellt sind
 * (`invoices.budget_type`, verbunden über `billing_run_id`). Der Cascade-Storno
 * der Route `PATCH /api/billing/:id/status` durfte deshalb beim Stornieren EINER
 * Topf-Rechnung NUR die Konsumptionen DIESES Topfes zurückbuchen — nicht die der
 * noch lebenden Geschwister-Rechnung im anderen Topf.
 *
 * Reproduktion: §45b auf einen kleinen Rest gedeckelt, Termin überläuft in den
 * privaten Topf → Split erzeugt 2 Rechnungen (§45b + privat) mit gemeinsamer
 * billingRunId. Das Stornieren NUR der privaten Rechnung (ohne cascadeRun) darf
 * den §45b-Netto-Verbrauch unangetastet lassen.
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
const APPT_DATE = `${YEAR}-0${MONTH}-08`;

let customerId: number;
let employeeId: number;
let abServiceId: number;
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];

/** Netto-Verbrauch (consumption + reversal) eines Topfes in Cent. */
async function netConsumedCents(budgetType: string): Promise<number> {
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

beforeAll(async () => {
  await getAuthCookie();

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Storno",
    nachname: `PotIso-${uniqueId()}`,
    geburtsdatum: "1942-05-10",
    email: `storno-potiso-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "12",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000001",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    // §45b-Überlauf darf in den privaten Topf laufen.
    acceptsPrivatePayment: true,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  customerId = custRes.data.id;

  const emp = await createTestEmployee({ vorname: "Marcel", nachnamePrefix: "PotIso_Integ" });
  employeeId = emp.id;
  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: employeeId,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  // §45b auf 500 ct gedeckelt → Termin überläuft in den privaten Topf.
  const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 500,
    carryoverAmountCents: 0,
    budgetStartDate: `${YEAR}-0${MONTH}-01`,
  });
  expect([200, 201]).toContain(init45b.status);

  const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 500, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

  // Ein Termin (Alltagsbegleitung 60 min) — Kosten deutlich über 500 ct.
  const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId,
    date: APPT_DATE,
    scheduledStart: "13:00",
    scheduledEnd: "14:00",
    notes: `Storno-PotIso-${uniqueId()}`,
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
    services: [{ serviceId: abServiceId, actualDurationMinutes: 60, details: "PotIso" }],
  });
  expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

  // Leistungsnachweis erstellen + dual signieren (Pflegekasse → status=completed).
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

describe("Pot-Storno-Isolation: Storno der Privat-Rechnung lässt §45b unangetastet (Task #1377)", () => {
  it("storniert nur den privaten Topf, §45b-Netto bleibt unverändert", async () => {
    // Rechnungslauf → Topf-Gruppe (§45b + privat).
    const genRes = await apiPost<{ splitInvoices?: boolean; invoices?: Array<{ id: number; billingRunId: string | null; budgetType: string | null }> }>(
      "/api/billing/generate",
      { customerId, billingMonth: MONTH, billingYear: YEAR },
    );
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    expect(genRes.data.splitInvoices, "Mehr-Topf-Lauf muss splitInvoices=true liefern").toBe(true);

    const invoices = genRes.data.invoices ?? [];
    expect(invoices.length, "Es müssen genau 2 Rechnungen entstehen (§45b + privat)").toBe(2);
    const runIds = new Set(invoices.map((i) => i.billingRunId));
    expect(runIds.size, "Beide Rechnungen müssen dieselbe billingRunId teilen").toBe(1);
    expect([...runIds][0], "billingRunId muss gesetzt sein").toBeTruthy();

    const pot45bInvoice = invoices.find((i) => i.budgetType === "entlastungsbetrag_45b");
    const privateInvoice = invoices.find((i) => i.budgetType == null);
    expect(pot45bInvoice, "§45b-Rechnung muss existieren").toBeTruthy();
    expect(privateInvoice, "Privat-Rechnung (budgetType NULL) muss existieren").toBeTruthy();

    // Verbrauchs-Baseline DIREKT nach der Abrechnung.
    const net45bBefore = await netConsumedCents("entlastungsbetrag_45b");
    const netPrivateBefore = await netConsumedCents("private");
    expect(net45bBefore, "§45b verbraucht 500 ct").toBe(-500);
    expect(netPrivateBefore, "privater Topf trägt den Überlauf (> 0)").toBeLessThan(0);

    // NUR die Privat-Rechnung stornieren (kein cascadeRun → Geschwister bleibt).
    const stornoRes = await apiPatch(`/api/billing/${privateInvoice!.id}/status`, {
      status: "storniert",
    });
    expect(stornoRes.status, `storno privat: ${JSON.stringify(stornoRes.data)}`).toBe(200);

    // §45b-Rechnung lebt weiter.
    const pot45bDetail = await apiGet<{ status: string }>(`/api/billing/${pot45bInvoice!.id}`);
    expect(pot45bDetail.data.status, "§45b-Rechnung darf NICHT storniert sein").not.toBe("storniert");

    // KERN-ASSERTION: §45b-Netto unverändert, privater Topf netto null.
    const net45bAfter = await netConsumedCents("entlastungsbetrag_45b");
    const netPrivateAfter = await netConsumedCents("private");
    expect(net45bAfter, "§45b-Netto bleibt nach Privat-Storno unverändert").toBe(net45bBefore);
    expect(netPrivateAfter, "privater Topf ist nach Storno netto null zurückgebucht").toBe(0);
  }, 180_000);
});
