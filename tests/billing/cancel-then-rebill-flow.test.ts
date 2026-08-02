/**
 * Task #1013 — Integration: ECHTER Storno-dann-Neuabrechnung-Flow.
 *
 * Die Schwester-Regression `budget-split-reversed-consumption.test.ts` seedet
 * die stornierten Budget-Buchungen synthetisch per `db.insert`. Dieser Test
 * fährt stattdessen den realen User-Pfad komplett über die HTTP-API:
 *
 *   1. Termin anlegen (`POST /api/appointments/kundentermin`)
 *   2. Termin dokumentieren (`POST /api/appointments/:id/document`) → der
 *      Consumption-Engine bucht ECHTE `consumption`-Zeilen (Cascade über die
 *      Töpfe).
 *   3. Buchung stornieren (`POST /api/budget/transactions/:id/reverse`) → es
 *      wird eine ECHTE `reversal`-Zeile geschrieben, die via
 *      `reversedTransactionId` auf die Original-Konsumption zeigt. Der Termin
 *      bleibt `completed`/abrechenbar (reverse ändert KEINEN Termin-Status).
 *   4. Leistungsnachweis signieren + `POST /api/billing/generate`.
 *
 * Geprüft werden beide Phantom-Formen, die der Fix in
 * `getBudgetSplitForAppointments` (`server/services/invoice-data.ts`) abdeckt:
 *
 *  T1 (gemischt live + storniert): Termin überläuft §45b → §45a (zwei
 *     Consumption-Zeilen). Nur die §45a-Zeile wird storniert. Erwartung: GENAU
 *     EINE Kasse-Rechnung (alles auf §45b), KEINE Phantom-§45a-Folgerechnung,
 *     KEIN Selbstzahler-Anteil. (Der alte Bug hätte die stornierte §45a-Zeile
 *     mitgezählt → Mehrtopf-Split mit §45a-Phantom-Rechnung.)
 *
 *  T2 (Einzeltopf netto null): Termin passt komplett in §45b (eine
 *     Consumption-Zeile), die dann storniert wird (netto null). Erwartung:
 *     KEIN private/Selbstzahler-Fallback, sondern Re-Derivation aus der
 *     aktuellen Allocation zurück auf §45b → genau EINE Kasse-Rechnung.
 *     (Bricht `rederiveSplitFromCurrentAllocation` weg, fiele der Termin auf
 *     `private` → Selbstzahler-Rechnung mit 19% USt.)
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
import { billingReferenceDate, billingReferenceMonth } from "../helpers/billing-month";

const AB_HOURLY_CENTS = 4200; // Alltagsbegleitung, siehe scripts/seed-test-reference-data.ts

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abServiceId: number;

const cleanupCustomerIds: number[] = [];
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

/** Legt einen pflegekasse_gesetzlich-Kunden (PG3, kein Privatzahler) mit
 *  §45b (Prio 1) + §45a (Prio 2) an. `limit45bCents` steuert, ob ein Termin
 *  in §45b überläuft. */
async function setupCustomer(limit45bCents: number, monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Cancel",
    nachname: `Rebill-${uniqueId()}`,
    geburtsdatum: "1941-03-22",
    email: `cancel-rebill-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "7",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000099",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  const customerId = custRes.data.id;
  cleanupCustomerIds.push(customerId);

  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  const init45b = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: limit45bCents,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45b: ${JSON.stringify(init45b.data)}`).toContain(init45b.status);

  const init45a = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "umwandlung_45a",
    currentMonthAmountCents: 59880,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45a: ${JSON.stringify(init45a.data)}`).toContain(init45a.status);

  const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: limit45bCents, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 59880, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

  return customerId;
}

/** Sucht einen freien (vergangenen) Werktags-Slot im Monat und legt dort einen
 *  Alltagsbegleitung-Termin der gewünschten Dauer an. */
async function createAppt(customerId: number, year: number, month: number, durationMinutes: number): Promise<{ id: number; date: string; time: string }> {
  const today = billingReferenceDate();
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = lastDay; day >= 1; day--) {
    const cand = new Date(year, month - 1, day);
    if (cand > today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymd(cand);
    for (const time of SEED_TIMES) {
      const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
        customerId,
        date: dateStr,
        scheduledStart: time,
        notes: `CancelRebill-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: abServiceId, durationMinutes }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("createAppt: kein freier Werktags-Slot im Monat gefunden");
}

async function documentAppt(id: number, time: string, durationMinutes: number): Promise<void> {
  const res = await apiPost<unknown>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: abServiceId, actualDurationMinutes: durationMinutes, details: "Cancel-Rebill-Test" }],
  });
  if (res.status !== 200) throw new Error(`document failed: ${res.status} ${JSON.stringify(res.data)}`);
}

async function signServiceRecord(customerId: number, year: number, month: number): Promise<void> {
  const cre = await apiPost<{ id: number; status?: string }>("/api/service-records", {
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
}

/** Liest (read-only) die echte Consumption-Zeile eines Termins für einen Topf. */
async function findConsumptionTxId(appointmentId: number, budgetType: string): Promise<number | null> {
  const rows = await db
    .select({ id: budgetTransactions.id })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.appointmentId, appointmentId),
        eq(budgetTransactions.transactionType, "consumption"),
        eq(budgetTransactions.budgetType, budgetType),
      ),
    );
  return rows[0]?.id ?? null;
}

async function generate(customerId: number, year: number, month: number) {
  const gen = await apiPost<any>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const invoices: any[] = gen.data?.splitInvoices ? gen.data.invoices : [gen.data];
  for (const inv of invoices) if (inv?.id) cleanupInvoiceIds.push(inv.id);
  return { isSplit: !!gen.data?.splitInvoices, invoices };
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
  for (const id of cleanupCustomerIds) { try { await cleanupCustomer(id); } catch { /* best-effort */ } }
  await runCleanup();
});

describe("Storno-dann-Neuabrechnung — echter API-Flow (Task #1013)", () => {
  it("T1 — gemischt live(§45b) + storniert(§45a): genau EINE Kasse-Rechnung, keine §45a-Phantom-Rechnung", async () => {
    const { year, month } = billingReferenceMonth();
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

    // §45b niedrig (5000) → 90-min-AB-Termin (6300) läuft in §45a über.
    const customerId = await setupCustomer(5000, monthStart);
    const durationMinutes = 90;
    const apptCostCents = (AB_HOURLY_CENTS * durationMinutes) / 60; // 6300

    const appt = await createAppt(customerId, year, month, durationMinutes);
    await documentAppt(appt.id, appt.time, durationMinutes);

    // Cascade muss zwei echte Consumption-Zeilen erzeugt haben.
    const tx45b = await findConsumptionTxId(appt.id, "entlastungsbetrag_45b");
    const tx45a = await findConsumptionTxId(appt.id, "umwandlung_45a");
    expect(tx45b, "Cascade muss eine §45b-Konsumption gebucht haben").not.toBeNull();
    expect(tx45a, "Termin muss in §45a übergelaufen sein (zweite Konsumption)").not.toBeNull();

    // NUR die §45a-Belegung über die echte Storno-API zurücknehmen.
    const rev = await apiPost<any>(`/api/budget/transactions/${tx45a}/reverse`, {});
    expect(rev.status, `reverse §45a: ${JSON.stringify(rev.data)}`).toBe(201);

    await signServiceRecord(customerId, year, month);
    const { isSplit, invoices } = await generate(customerId, year, month);

    expect(invoices.length, `erwartet GENAU 1 Rechnung, bekam ${invoices.length}`).toBe(1);
    expect(isSplit, "kein Mehrtopf-Split erwartet (keine Phantom-§45a-Rechnung)").toBe(false);
    expect(
      invoices.some((i) => i.budgetType === "umwandlung_45a"),
      "Phantom-Bug: §45a-Folgerechnung für stornierten Topf erstellt",
    ).toBe(false);
    const inv = invoices[0];
    expect(inv.billingType, "Kasse-Rechnung erwartet, kein Selbstzahler").toBe("pflegekasse_gesetzlich");
    expect(inv.netAmountCents, "voller Termin-Betrag muss auf der einen §45b-Rechnung landen").toBe(apptCostCents);
  }, 120_000);

  it("T2 — Einzeltopf netto null (§45b storniert): Re-Derivation auf §45b, KEIN Selbstzahler-Fallback", async () => {
    const { year, month } = billingReferenceMonth();
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

    // §45b komfortabel (13100) → 30-min-AB-Termin (2100) passt komplett rein.
    const customerId = await setupCustomer(13100, monthStart);
    const durationMinutes = 30;
    const apptCostCents = (AB_HOURLY_CENTS * durationMinutes) / 60; // 2100

    const appt = await createAppt(customerId, year, month, durationMinutes);
    await documentAppt(appt.id, appt.time, durationMinutes);

    const tx45b = await findConsumptionTxId(appt.id, "entlastungsbetrag_45b");
    const tx45a = await findConsumptionTxId(appt.id, "umwandlung_45a");
    expect(tx45b, "Termin muss komplett in §45b gebucht sein").not.toBeNull();
    expect(tx45a, "Termin darf NICHT in §45a übergelaufen sein").toBeNull();

    // Einzige Belegung stornieren → netto null.
    const rev = await apiPost<any>(`/api/budget/transactions/${tx45b}/reverse`, {});
    expect(rev.status, `reverse §45b: ${JSON.stringify(rev.data)}`).toBe(201);

    await signServiceRecord(customerId, year, month);
    const { isSplit, invoices } = await generate(customerId, year, month);

    expect(invoices.length, `erwartet GENAU 1 Rechnung, bekam ${invoices.length}`).toBe(1);
    expect(isSplit, "kein Mehrtopf-Split erwartet").toBe(false);
    const inv = invoices[0];
    // Kern-Regression: Re-Derivation muss den Termin auf §45b (Kasse) legen,
    // NICHT auf private → sonst wäre die Rechnung ein Selbstzahler mit 19% USt.
    expect(inv.billingType, "Re-Derivation muss Kasse-Rechnung liefern, kein Selbstzahler-Fallback").toBe("pflegekasse_gesetzlich");
    expect(inv.vatRate, "Kasse-Rechnung muss 0% USt haben (kein 19%-Selbstzahler)").toBe(0);
    expect(inv.netAmountCents, "voller Termin-Betrag muss abgerechnet werden").toBe(apptCostCents);
  }, 120_000);
});
