import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Task #788 — Storno reversiert das Budget vollständig über den ECHTEN
 * Rechnungs-Flow (Multi-Topf-Split + Cascade-Storno).
 *
 * Die DB-nahe Property-Suite `tests/equality/storno-db-reversal-symmetrie.test.ts`
 * (Task #781) ruft `reverseBudgetTransaction` zwar exakt so auf, wie es
 * `performStorno` tut, reproduziert die Schleife aber direkt — sie fasst
 * NIE den echten Rechnungs-Storno-Endpoint an. Ein Regress in der
 * `performStorno`-Verdrahtung (falsche appointmentIds aus den Line-Items
 * selektiert, oder ein Bug im `cascadeRun`-Split-Pfad) würde dort
 * durchrutschen.
 *
 * Dieser Test schließt die Lücke end-to-end:
 *
 *   1. Multi-Topf-Konsumtion über den realen Flow erzeugen: §45b knapp →
 *      Cascade nach §45a, inkl. Reise- UND Kunden-Kilometer (km-tragende
 *      Line-Items), dokumentiert über `POST /api/appointments/:id/document`.
 *   2. Leistungsnachweis erstellen + signieren, dann
 *      `POST /api/billing/generate` → erzeugt N Split-Rechnungen (eine pro
 *      Topf) mit gemeinsamer `billingRunId`.
 *   3. Pre-Storno-Aggregat je (Topf, Allocation, Kunde) über JEDE
 *      `budget_transactions`-Spalte snapshotten.
 *   4. `PATCH /api/billing/:id/status { status: "storniert", cascadeRun: true }`
 *      auf EINE der Split-Rechnungen → storniert alle Geschwister.
 *
 * Invariante: Nach dem Cascade-Storno muss Σ über {consumption + reversal}
 * je Topf, Allocation und Kunde für JEDE Spalte exakt 0 ergeben (reversal =
 * −consumption). Vergisst der Storno-Pfad einen Termin, eine Spalte oder
 * eine Geschwister-Rechnung, kippt das Aggregat.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetTransactions, type BudgetTransaction } from "@shared/schema";
import {
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  apiDelete,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";
import { billingReferenceMonth, pastWeekdayInBillingMonth } from "../helpers/billing-month";

const NUMERIC_COLUMNS = [
  "amountCents",
  "hauswirtschaftMinutes",
  "hauswirtschaftCents",
  "alltagsbegleitungMinutes",
  "alltagsbegleitungCents",
  "travelKilometers",
  "travelCents",
  "customerKilometers",
  "customerKilometersCents",
] as const;

type ColumnSums = Record<(typeof NUMERIC_COLUMNS)[number], number>;

function zeroSums(): ColumnSums {
  return Object.fromEntries(NUMERIC_COLUMNS.map((c) => [c, 0])) as ColumnSums;
}

function addInto(target: ColumnSums, tx: BudgetTransaction): void {
  for (const col of NUMERIC_COLUMNS) {
    target[col] += Number(tx[col] ?? 0) || 0;
  }
}

interface Aggregate {
  perCustomer: ColumnSums;
  perPot: Map<string, ColumnSums>;
  perAllocation: Map<number, ColumnSums>;
}

function aggregate(txs: BudgetTransaction[]): Aggregate {
  const perCustomer = zeroSums();
  const perPot = new Map<string, ColumnSums>();
  const perAllocation = new Map<number, ColumnSums>();

  for (const tx of txs) {
    addInto(perCustomer, tx);

    if (!perPot.has(tx.budgetType)) perPot.set(tx.budgetType, zeroSums());
    addInto(perPot.get(tx.budgetType)!, tx);

    const allocKey = tx.allocationId ?? -1;
    if (!perAllocation.has(allocKey)) perAllocation.set(allocKey, zeroSums());
    addInto(perAllocation.get(allocKey)!, tx);
  }

  return { perCustomer, perPot, perAllocation };
}

async function allTxs(customerId: number): Promise<BudgetTransaction[]> {
  return db.select()
    .from(budgetTransactions)
    .where(eq(budgetTransactions.customerId, customerId));
}

function expectAllZero(sums: ColumnSums, label: string): void {
  for (const col of NUMERIC_COLUMNS) {
    expect(sums[col], `${label} — Spalte ${col} muss nach Storno netto 0 sein`).toBe(0);
  }
}

let customerId: number;
let employeeId: number;
let hwServiceId: number;
let abServiceId: number;
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];

beforeAll(async () => {
  await getAuthCookie();

  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  const list = services.data;
  hwServiceId = list.find((s) => s.code === "hauswirtschaft")!.id;
  abServiceId = list.find((s) => s.code === "alltagsbegleitung")!.id;

  const cust = await createTestCustomer({
    vorname: "T788-Cascade-Storno",
    nachname: `Reversal-${uniqueId()}`,
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_privat",
    acceptsPrivatePayment: true,
  });
  customerId = cust.id as number;

  const emp = await createTestEmployee({ nachnamePrefix: "BS_T788" });
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

describe("Task #788 — Cascade-Storno reversiert Multi-Topf-Budget über den echten Rechnungs-Flow", () => {
  it("Multi-Topf-Split-Rechnung (§45b → §45a) mit km: PATCH storno+cascadeRun bucht jede Spalte je Topf/Allocation/Kunde auf 0 zurück", async () => {
    const apptDate = pastWeekdayInBillingMonth();
    const { year, month } = billingReferenceMonth();

    // §45b knapp → Cascade muss in §45a überlaufen (Multi-Topf-Konsumtion).
    await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "entlastungsbetrag_45b",
      currentMonthAmountCents: 1000,
      carryoverAmountCents: 0,
      budgetStartDate: apptDate,
    });
    await apiPost(`/api/budget/${customerId}/initial-budget`, {
      budgetType: "umwandlung_45a",
      currentMonthAmountCents: 59880,
      carryoverAmountCents: 0,
      budgetStartDate: apptDate,
    });

    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 59880, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    // 1) Termin anlegen (langer Termin → Konsumtion > §45b-Restbestand →
    //    Cascade nach §45a), mit Reise- UND Kunden-km.
    const services = [
      { serviceId: hwServiceId, durationMinutes: 240 },
      { serviceId: abServiceId, durationMinutes: 60 },
    ];
    const apptRes = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: apptDate,
      scheduledStart: "08:00",
      scheduledEnd: "13:00",
      notes: `T788-Cascade-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services,
    });
    expect(apptRes.status, `appt: ${JSON.stringify(apptRes.data)}`).toBe(201);
    const appointmentId = apptRes.data.id;
    cleanupApptIds.push(appointmentId);

    const docRes = await apiPost(`/api/appointments/${appointmentId}/document`, {
      actualStart: "08:00",
      travelOriginType: "home",
      travelKilometers: 18,
      customerKilometers: 7,
      services: services.map((s) => ({
        serviceId: s.serviceId,
        actualDurationMinutes: s.durationMinutes,
        details: "T788-Doc",
      })),
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    // Sicherstellen, dass es wirklich eine Cascade über >1 Topf ist und km
    // gebucht wurden — sonst wäre der Test wertlos.
    const afterBooking = await allTxs(customerId);
    const consumptions = afterBooking.filter((t) => t.transactionType === "consumption");
    const distinctPots = new Set(consumptions.map((t) => t.budgetType));
    expect(distinctPots.size, "Buchung muss über mehrere Töpfe kaskadieren").toBeGreaterThanOrEqual(2);
    const totalTravelKm = consumptions.reduce((s, t) => s + (Number(t.travelKilometers ?? 0) || 0), 0);
    const totalCustomerKm = consumptions.reduce((s, t) => s + (Number(t.customerKilometers ?? 0) || 0), 0);
    expect(totalTravelKm, "Reise-km müssen gebucht sein").toBeGreaterThan(0);
    expect(totalCustomerKm, "Kunden-km müssen gebucht sein").toBeGreaterThan(0);

    // 2) Leistungsnachweis erstellen + signieren.
    const srRes = await apiPost<{ id: number }>("/api/service-records", {
      customerId,
      employeeId,
      year,
      month,
    });
    expect(srRes.status, `SR create: ${JSON.stringify(srRes.data)}`).toBe(201);
    cleanupSrIds.push(srRes.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost(`/api/service-records/${srRes.data.id}/sign`, {
        signerType,
        signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    // 3) Rechnung generieren → Multi-Topf-Split mit gemeinsamer billingRunId.
    const genRes = await apiPost<{ splitInvoices?: boolean; invoices?: Array<{ id: number; billingRunId: string | null; budgetType: string | null }> }>(
      "/api/billing/generate",
      { customerId, billingMonth: month, billingYear: year },
    );
    expect(genRes.status, `generate: ${JSON.stringify(genRes.data)}`).toBe(200);
    expect(genRes.data.splitInvoices, "Mehr-Topf-Lauf muss splitInvoices=true liefern").toBe(true);
    const invoices = genRes.data.invoices ?? [];
    expect(invoices.length, "Split muss >1 Rechnung erzeugen").toBeGreaterThanOrEqual(2);
    const billingRunIds = new Set(invoices.map((i) => i.billingRunId));
    expect(billingRunIds.size, "Alle Split-Rechnungen müssen dieselbe billingRunId teilen").toBe(1);
    const billingRunId = [...billingRunIds][0];
    expect(billingRunId, "billingRunId muss gesetzt sein").toBeTruthy();

    // 4) Pre-Storno-Aggregat (alle Tx) snapshotten — hier sind es nur die
    //    Consumption-Tx. Nach dem Storno müssen consumption + reversal je
    //    Spalte/Topf/Allocation/Kunde netto 0 ergeben.
    const pre = aggregate(afterBooking);
    // Sanity: vor Storno ist amountCents je Topf != 0 (es wurde verbraucht).
    let anyNonZeroPot = false;
    for (const sums of pre.perPot.values()) {
      if (sums.amountCents !== 0) anyNonZeroPot = true;
    }
    expect(anyNonZeroPot, "Vor Storno muss mindestens ein Topf Verbrauch != 0 haben").toBe(true);

    // Storno EINER Split-Rechnung mit Cascade über die billingRunId-Geschwister.
    const stornoTarget = invoices[0];
    const stornoRes = await apiPatch<unknown>(`/api/billing/${stornoTarget.id}/status`, {
      status: "storniert",
      cascadeRun: true,
    });
    expect(stornoRes.status, `storno cascade: ${JSON.stringify(stornoRes.data)}`).toBe(200);

    // Alle Original-Rechnungen des Laufs müssen jetzt storniert sein.
    const listRes = await apiGet<Array<{ id: number; billingRunId: string | null; status: string; invoiceType: string }>>(
      `/api/billing?customerId=${customerId}`,
    );
    const runInvoices = (listRes.data as Array<{ id: number; billingRunId: string | null; status: string; invoiceType: string }>)
      .filter((i) => i.billingRunId === billingRunId && i.invoiceType !== "stornorechnung");
    for (const inv of runInvoices) {
      expect(inv.status, `Rechnung ${inv.id} muss nach Cascade-Storno 'storniert' sein`).toBe("storniert");
    }

    // Invariante: Σ über {consumption + reversal} == 0 je Spalte/Topf/Allocation/Kunde.
    const finalTxs = await allTxs(customerId);
    const post = aggregate(finalTxs);

    // Jede Reversal hat eine Consumption-Gegenbuchung → alle Töpfe/Allocations
    // aus dem Pre-Snapshot müssen weiterhin existieren und auf 0 stehen.
    for (const pot of pre.perPot.keys()) {
      const sums = post.perPot.get(pot);
      expect(sums, `Topf ${pot} fehlt nach Storno`).toBeDefined();
      expectAllZero(sums!, `perPot[${pot}]`);
    }
    for (const alloc of pre.perAllocation.keys()) {
      const sums = post.perAllocation.get(alloc);
      expect(sums, `Allocation ${alloc} fehlt nach Storno`).toBeDefined();
      expectAllZero(sums!, `perAllocation[${alloc}]`);
    }
    expectAllZero(post.perCustomer, "perCustomer");
  }, 180_000);
});
