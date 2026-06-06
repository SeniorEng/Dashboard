/**
 * Task #1021 — End-to-End: Re-abgerechnete Termine dürfen denselben Budget-
 * Topf NICHT zweimal verbrauchen.
 *
 * Task #1014 hat die Lücke geschlossen, dass ein netto-null-belegter
 * (storniert-und-re-abgerechneter) Termin beim Re-Abrechnen frische
 * Consumption-Zeilen bucht (`rebookNetZeroAppointmentConsumption`, verdrahtet
 * in `generateInvoiceCore`). Die Unit-/Flow-Tests
 * (`rebook-net-zero-consumption.test.ts`, `storno-then-rebill.test.ts`) prüfen
 * den Re-Book direkt bzw. den Storno→Re-Rechnungs-Happy-Path. Es fehlte ein
 * EINZIGER End-to-End-Test, der das volle Doppel-Spend-Szenario über die
 * öffentlichen Billing-Routen fährt:
 *
 *   1. Termin A anlegen, dokumentieren (bucht §45b-Consumption), abrechnen.
 *   2. Rechnung von A stornieren (`PATCH /api/billing/:id/status` →
 *      `storniert`) → Cascade-Reversal macht A netto null.
 *   3. A erneut abrechnen (`POST /api/billing/generate`) → `generateInvoiceCore`
 *      bucht A via Re-Book frisch nach (sonst weist die Rechnung §45b aus, das
 *      der Ledger weiter als verfügbar führt).
 *   4. SPÄTEREN Termin B anlegen, dokumentieren (liest jetzt die nach dem
 *      Re-Book reduzierte §45b-Verfügbarkeit), abrechnen.
 *
 * Kern-Assertion (fängt den Doppel-Spend-Bug):
 *   Σ(Live-§45b-Consumption im Ledger) === Σ(Netto der beiden AKTIVEN
 *   Rechnungen) === A + B, und beides ≤ Topf-Kapazität.
 *
 * Ohne den Re-Book (Bug-Zustand) bliebe A netto null → Ledger-Live = nur B,
 * während die beiden aktiven Rechnungen A + B ausweisen → Ledger ≠ Rechnungen
 * → der Topf wäre über zwei aktive Rechnungen doppelt belegt.
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetTransactions } from "@shared/schema";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  cleanupCustomer,
  runCleanup,
} from "../test-utils";

const AB_HOURLY_CENTS = 4200; // Alltagsbegleitung, siehe scripts/seed-test-reference-data.ts
const POT_CAPACITY_CENTS = 13100; // §45b gesetzliches Monats-Maximum
const APPT_MINUTES = 30;
const APPT_COST_CENTS = (AB_HOURLY_CENTS * APPT_MINUTES) / 60; // 2100

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abServiceId: number;
let customerId: number;

const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "20:00", "20:30", "21:00", "21:30", "22:00", "22:30",
];

/** Legt einen reinen Kassen-Kunden (PG3, KEIN Privatzahler) mit EINEM
 *  limitierten Topf (§45b) an. §45a/§39 sind deaktiviert → echter Single-Pot. */
async function setupSinglePotCustomer(monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "DoubleSpend",
    nachname: `Rebill-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `double-spend-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "3",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000077",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  const id = custRes.data.id;

  const assignRes = await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  const init45b = await apiPost(`/api/budget/${id}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: POT_CAPACITY_CENTS,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45b: ${JSON.stringify(init45b.data)}`).toContain(init45b.status);

  const typesRes = await apiPut(`/api/budget/${id}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: POT_CAPACITY_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

  return id;
}

/** Sucht einen freien (vergangenen) Werktags-Slot im Monat und legt dort einen
 *  Alltagsbegleitung-Termin an. `exclude` sperrt einen bereits belegten Tag. */
async function createAppt(year: number, month: number, exclude: string | null, tag: string): Promise<{ id: number; date: string; time: string }> {
  const today = new Date();
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = lastDay; day >= 1; day--) {
    const cand = new Date(year, month - 1, day);
    if (cand > today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymd(cand);
    if (dateStr === exclude) continue;
    for (const time of SEED_TIMES) {
      const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `DoubleSpend-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: abServiceId, durationMinutes: APPT_MINUTES }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(`createAppt(${tag}): kein freier Werktags-Slot im Monat gefunden`);
}

async function documentAppt(id: number, time: string): Promise<void> {
  const res = await apiPost<unknown>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: abServiceId, actualDurationMinutes: APPT_MINUTES, details: "DoubleSpend-Test" }],
  });
  if (res.status !== 200) throw new Error(`document failed: ${res.status} ${JSON.stringify(res.data)}`);
}

/** Erstellt + signiert einen monatlichen Leistungsnachweis. Deckt automatisch
 *  alle noch nicht erfassten dokumentierten Termine des Monats ab. */
async function createAndSignSr(year: number, month: number): Promise<number> {
  const cre = await apiPost<{ id: number }>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  expect(cre.status, `SR create: ${JSON.stringify(cre.data)}`).toBe(201);
  const srId = cre.data.id;
  cleanupSrIds.push(srId);
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<unknown>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    expect(sig.status, `SR sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
  }
  return srId;
}

async function generate(year: number, month: number): Promise<any[]> {
  const gen = await apiPost<any>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const invoices: any[] = gen.data?.splitInvoices ? gen.data.invoices : [gen.data];
  for (const inv of invoices) if (inv?.id) cleanupInvoiceIds.push(inv.id);
  return invoices;
}

/** Summe der LIVE §45b-Consumption im Ledger (Consumption minus reversierte). */
async function liveConsumption45bCents(): Promise<number> {
  const consumptions = await db.select({
    id: budgetTransactions.id,
    amountCents: budgetTransactions.amountCents,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
    eq(budgetTransactions.transactionType, "consumption"),
  ));
  const reversals = await db.select({
    ref: budgetTransactions.reversedTransactionId,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, "entlastungsbetrag_45b"),
    eq(budgetTransactions.transactionType, "reversal"),
  ));
  const reversedIds = new Set(reversals.map((r) => r.ref).filter((x): x is number => x !== null));
  return consumptions
    .filter((c) => !reversedIds.has(c.id))
    .reduce((sum, c) => sum + Math.abs(c.amountCents), 0);
}

/** Netto-Summe der aktiven (nicht stornierten, keine Stornorechnungen) Rechnungen. */
async function activeInvoiceNetCents(): Promise<{ totalNet: number; count: number }> {
  const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
  const rows = Array.isArray(list.data) ? list.data : [];
  const active = rows.filter(
    (i) => i.status !== "storniert" && i.invoiceType !== "stornorechnung",
  );
  return {
    totalNet: active.reduce((sum, i) => sum + (i.netAmountCents ?? 0), 0),
    count: active.length,
  };
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanupSrIds) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanupApptIds) { try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ } }
  await cleanupCustomer(customerId);
  await runCleanup();
});

describe("Re-Rechnung darf §45b nicht doppelt verbrauchen — E2E (Task #1021)", () => {
  it("bill A → storno → re-bill A (re-book) → bill B: Ledger === aktive Rechnungen, ≤ Kapazität", async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

    customerId = await setupSinglePotCustomer(monthStart);

    // (1) Termin A: anlegen, dokumentieren (bucht §45b), abrechnen.
    const apptA = await createAppt(year, month, null, "A");
    await documentAppt(apptA.id, apptA.time);
    await createAndSignSr(year, month);
    const inv1 = await generate(year, month);
    expect(inv1.length, "erste Abrechnung erzeugt genau 1 Rechnung").toBe(1);
    expect(inv1[0].billingType, "Kasse-Rechnung erwartet").toBe("pflegekasse_gesetzlich");

    // Nach Dokumentation: §45b-Live-Consumption == Kosten von A.
    expect(await liveConsumption45bCents(), "A muss §45b live belegen").toBe(APPT_COST_CENTS);

    // (2) Rechnung von A stornieren → Cascade-Reversal macht A netto null.
    const storno = await apiPatch<any>(`/api/billing/${inv1[0].id}/status`, { status: "storniert" });
    expect(storno.status, `storno: ${JSON.stringify(storno.data)}`).toBe(200);
    // Stornorechnung zur Aufräumung vormerken.
    const afterStorno = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
    for (const i of (afterStorno.data as any[])) {
      if (i.invoiceType === "stornorechnung" && !cleanupInvoiceIds.includes(i.id)) cleanupInvoiceIds.push(i.id);
    }
    expect(await liveConsumption45bCents(), "Storno macht A netto null").toBe(0);

    // (3) A erneut abrechnen → generateInvoiceCore bucht A via Re-Book frisch nach.
    const inv2 = await generate(year, month);
    expect(inv2.length, "Re-Abrechnung erzeugt genau 1 Rechnung").toBe(1);
    expect(inv2[0].billingType, "Re-Rechnung bleibt Kasse (kein Selbstzahler-Fallback)").toBe("pflegekasse_gesetzlich");
    // Kern des Fixes: A ist nach dem Re-Book wieder live belegt.
    expect(await liveConsumption45bCents(), "Re-Book muss A wieder §45b live belegen").toBe(APPT_COST_CENTS);

    // (4) SPÄTEREN Termin B anlegen, dokumentieren (liest jetzt die reduzierte
    //     §45b-Verfügbarkeit), abrechnen.
    const apptB = await createAppt(year, month, apptA.date, "B");
    await documentAppt(apptB.id, apptB.time);
    await createAndSignSr(year, month);
    const inv3 = await generate(year, month);
    expect(inv3.length, "B-Abrechnung erzeugt genau 1 Rechnung").toBe(1);

    // === Doppel-Spend-Garantie ===
    const ledger45b = await liveConsumption45bCents();
    const { totalNet, count } = await activeInvoiceNetCents();

    // Genau zwei aktive Rechnungen: re-abgerechnetes A + B.
    expect(count, "genau zwei aktive Rechnungen (A re-billed + B)").toBe(2);

    // Ledger und Rechnungen sind deckungsgleich = A + B.
    expect(ledger45b, "Ledger-Live-§45b muss A + B sein").toBe(APPT_COST_CENTS * 2);
    expect(totalNet, "Σ aktive Rechnungen muss A + B sein").toBe(APPT_COST_CENTS * 2);
    expect(
      totalNet,
      "Kern-Regression: Σ aktive Rechnungen === Ledger-Live (kein Doppel-Spend)",
    ).toBe(ledger45b);

    // Der Topf wird nie über seine Kapazität hinaus belegt.
    expect(ledger45b, "§45b-Live darf Kapazität nicht überschreiten").toBeLessThanOrEqual(POT_CAPACITY_CENTS);
    expect(totalNet, "§45b über aktive Rechnungen darf Kapazität nicht überschreiten").toBeLessThanOrEqual(POT_CAPACITY_CENTS);
  }, 180_000);
});
