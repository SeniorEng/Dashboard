/**
 * Task #1025 — End-to-End: Re-abgerechnete Termine dürfen auch über MEHRERE
 * Budget-Töpfe (§45b → §45a Cascade) keinen Topf doppelt verbrauchen.
 *
 * Die Schwester-Suite `rebill-no-double-spend-e2e.test.ts` (Task #1021) deckt
 * den Single-Pot-Fall ab (nur §45b). Bei einem Mehrtopf-Lauf wird die
 * Rechnung pro Topf gesplittet (`generateInvoiceCore` → N Rechnungen mit
 * gemeinsamer `billingRunId`, Task #759); der Storno läuft als Cascade über
 * die Geschwister-Rechnungen (`cascadeRun: true`), und der Re-Book
 * (`rebookNetZeroAppointmentConsumption`, Task #1014) muss die Consumption in
 * JEDEN betroffenen Topf zurückbuchen. Es fehlte ein End-to-End-Test, der das
 * volle Doppel-Spend-Szenario für mehrere Töpfe über die öffentlichen
 * Billing-Routen fährt:
 *
 *   1. Termin A (lang) anlegen, dokumentieren → Cascade §45b (voll) → §45a
 *      (Rest), abrechnen → Split-Rechnungen (1×§45b + 1×§45a, gleiche
 *      billingRunId).
 *   2. EINE der Split-Rechnungen mit `cascadeRun: true` stornieren → alle
 *      Geschwister storniert, A in BEIDEN Töpfen netto null.
 *   3. A erneut abrechnen → Re-Book bucht A frisch nach (muss BEIDE Töpfe
 *      wiederherstellen) → erneut Split-Rechnungen.
 *   4. SPÄTEREN Termin B anlegen, dokumentieren (liest jetzt die nach dem
 *      Re-Book reduzierte §45b-Verfügbarkeit → §45b erschöpft → komplett §45a),
 *      abrechnen.
 *
 * Kern-Assertion (fängt den Mehrtopf-Doppel-Spend-Bug) — PRO TOPF:
 *   Σ(Live-Consumption im Ledger des Topfs) === Σ(Netto der aktiven Rechnungen
 *   dieses Topfs), und jeder Topf ≤ seiner Kapazität.
 *
 * Ohne den Re-Book (Bug-Zustand) bliebe A in beiden Töpfen netto null →
 * Ledger-Live = nur B (komplett §45b verfügbar) → B liefe NICHT in §45a über,
 * während die re-abgerechneten A-Rechnungen §45b UND §45a ausweisen → pro Topf
 * Ledger ≠ Rechnungen → Doppel-Belegung über zwei aktive Rechnungen.
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

// §45b ist knapp limitiert, damit ein langer Termin in §45a überläuft.
const POT_45B_CAP_CENTS = 5000;
const POT_45A_CAP_CENTS = 59880;

// Termin A überläuft §45b → §45a; Termin B (nach A erschöpftem §45b) läuft
// komplett in §45a.
const APPT_A_MINUTES = 90;
const APPT_A_COST_CENTS = (AB_HOURLY_CENTS * APPT_A_MINUTES) / 60; // 6300
const APPT_B_MINUTES = 30;
const APPT_B_COST_CENTS = (AB_HOURLY_CENTS * APPT_B_MINUTES) / 60; // 2100

// Erwartete Cascade-Aufteilung von Termin A.
const A_45B_CENTS = POT_45B_CAP_CENTS;               // 5000 (§45b voll)
const A_45A_CENTS = APPT_A_COST_CENTS - A_45B_CENTS; // 1300 (Rest → §45a)

const POT_45B = "entlastungsbetrag_45b";
const POT_45A = "umwandlung_45a";

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

/** Legt einen reinen Kassen-Kunden (PG3, KEIN Privatzahler) mit ZWEI Töpfen
 *  an: §45b (Prio 1, knapp limitiert) + §45a (Prio 2, großzügig). §39 aus →
 *  echte §45b→§45a-Cascade ohne Privat-Anteil. */
async function setupMultiPotCustomer(monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "DoubleSpendMulti",
    nachname: `Rebill-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `double-spend-multi-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "5",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000078",
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
    budgetType: POT_45B,
    currentMonthAmountCents: POT_45B_CAP_CENTS,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45b: ${JSON.stringify(init45b.data)}`).toContain(init45b.status);

  const init45a = await apiPost(`/api/budget/${id}/initial-budget`, {
    budgetType: POT_45A,
    currentMonthAmountCents: POT_45A_CAP_CENTS,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45a: ${JSON.stringify(init45a.data)}`).toContain(init45a.status);

  const typesRes = await apiPut(`/api/budget/${id}/type-settings`, {
    settings: [
      { budgetType: POT_45B, enabled: true, priority: 1, monthlyLimitCents: POT_45B_CAP_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: POT_45A, enabled: true, priority: 2, monthlyLimitCents: POT_45A_CAP_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

  return id;
}

/** Sucht einen freien (vergangenen) Werktags-Slot im Monat und legt dort einen
 *  Alltagsbegleitung-Termin der gewünschten Dauer an.
 *
 *  `order` steuert die Tages-Suchrichtung: "earliest" (aufsteigend) für Termin
 *  A, "latest" (absteigend) für Termin B. Damit gilt dateB >= dateA — kritisch,
 *  weil die §45b-Verfügbarkeit beim Dokumentieren as-of dem Termindatum gelesen
 *  wird (transactionDate <= asOfDate): B muss A's §45b-Verbrauch bereits sehen,
 *  sonst läge B fälschlich in §45b statt §45a. */
async function createAppt(
  year: number,
  month: number,
  durationMinutes: number,
  tag: string,
  order: "earliest" | "latest",
): Promise<{ id: number; date: string; time: string }> {
  const today = billingReferenceDate();
  const lastDay = new Date(year, month, 0).getDate();
  const days = order === "latest"
    ? Array.from({ length: lastDay }, (_, i) => lastDay - i)
    : Array.from({ length: lastDay }, (_, i) => i + 1);
  for (const day of days) {
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
        notes: `DoubleSpendMulti-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: abServiceId, durationMinutes }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(`createAppt(${tag}): kein freier Werktags-Slot im Monat gefunden`);
}

async function documentAppt(id: number, time: string, durationMinutes: number): Promise<void> {
  const res = await apiPost<unknown>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: abServiceId, actualDurationMinutes: durationMinutes, details: "DoubleSpendMulti-Test" }],
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

async function generate(year: number, month: number): Promise<{ isSplit: boolean; invoices: any[] }> {
  const gen = await apiPost<any>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const isSplit = !!gen.data?.splitInvoices;
  const invoices: any[] = isSplit ? gen.data.invoices : [gen.data];
  for (const inv of invoices) if (inv?.id) cleanupInvoiceIds.push(inv.id);
  return { isSplit, invoices };
}

/** Summe der LIVE-Consumption im Ledger für EINEN Topf (Consumption minus
 *  reversierte). */
async function liveConsumptionCents(budgetType: string): Promise<number> {
  const consumptions = await db.select({
    id: budgetTransactions.id,
    amountCents: budgetTransactions.amountCents,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, budgetType),
    eq(budgetTransactions.transactionType, "consumption"),
  ));
  const reversals = await db.select({
    ref: budgetTransactions.reversedTransactionId,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, budgetType),
    eq(budgetTransactions.transactionType, "reversal"),
  ));
  const reversedIds = new Set(reversals.map((r) => r.ref).filter((x): x is number => x !== null));
  return consumptions
    .filter((c) => !reversedIds.has(c.id))
    .reduce((sum, c) => sum + Math.abs(c.amountCents), 0);
}

/** Aktive (nicht stornierte, keine Stornorechnungen) Rechnungen des Kunden. */
async function activeInvoices(): Promise<any[]> {
  const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
  const rows = Array.isArray(list.data) ? list.data : [];
  return rows.filter(
    (i) => i.status !== "storniert" && i.invoiceType !== "stornorechnung",
  );
}

/** Merkt entstandene Stornorechnungen für die Aufräumung vor. */
async function trackStornoInvoices(): Promise<void> {
  const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
  for (const i of (list.data as any[])) {
    if (i.invoiceType === "stornorechnung" && !cleanupInvoiceIds.includes(i.id)) {
      cleanupInvoiceIds.push(i.id);
    }
  }
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
  if (customerId) await cleanupCustomer(customerId);
  await runCleanup();
});

describe("Re-Rechnung darf bei MEHREREN Töpfen keinen Topf doppelt verbrauchen — E2E (Task #1025)", () => {
  it("bill A (§45b→§45a Split) → cascade-storno → re-bill A (re-book beide Töpfe) → bill B: pro Topf Ledger === aktive Rechnungen, ≤ Kapazität", async () => {
    const { year, month } = billingReferenceMonth();
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

    customerId = await setupMultiPotCustomer(monthStart);

    // (1) Termin A: lang genug, um §45b zu erschöpfen und in §45a überzulaufen.
    const apptA = await createAppt(year, month, APPT_A_MINUTES, "A", "earliest");
    await documentAppt(apptA.id, apptA.time, APPT_A_MINUTES);
    await createAndSignSr(year, month);

    // Cascade muss VOR der Abrechnung zwei echte Consumption-Zeilen erzeugt
    // haben (sonst wäre das Szenario kein Mehrtopf-Test).
    expect(await liveConsumptionCents(POT_45B), "A muss §45b voll belegen").toBe(A_45B_CENTS);
    expect(await liveConsumptionCents(POT_45A), "A muss in §45a überlaufen").toBe(A_45A_CENTS);

    const gen1 = await generate(year, month);
    expect(gen1.isSplit, "Mehrtopf-Lauf muss Split-Rechnungen liefern").toBe(true);
    expect(gen1.invoices.length, "Split = 1 Rechnung pro Topf (§45b + §45a)").toBe(2);
    const runIds = new Set(gen1.invoices.map((i) => i.billingRunId));
    expect(runIds.size, "alle Split-Rechnungen teilen dieselbe billingRunId").toBe(1);
    const inv45bA = gen1.invoices.find((i) => i.budgetType === POT_45B);
    const inv45aA = gen1.invoices.find((i) => i.budgetType === POT_45A);
    expect(inv45bA?.netAmountCents, "§45b-Split-Rechnung Netto").toBe(A_45B_CENTS);
    expect(inv45aA?.netAmountCents, "§45a-Split-Rechnung Netto").toBe(A_45A_CENTS);

    // (2) EINE Split-Rechnung mit Cascade stornieren → alle Geschwister
    //     storniert, A in BEIDEN Töpfen netto null.
    const storno = await apiPatch<any>(`/api/billing/${gen1.invoices[0].id}/status`, {
      status: "storniert",
      cascadeRun: true,
    });
    expect(storno.status, `cascade-storno: ${JSON.stringify(storno.data)}`).toBe(200);
    await trackStornoInvoices();

    // Beide Original-Rechnungen des Laufs sind jetzt storniert.
    const afterStorno = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
    const runOriginals = (afterStorno.data as any[]).filter(
      (i) => i.billingRunId === gen1.invoices[0].billingRunId && i.invoiceType !== "stornorechnung",
    );
    for (const i of runOriginals) {
      expect(i.status, `Rechnung ${i.id} muss nach Cascade-Storno 'storniert' sein`).toBe("storniert");
    }
    expect(await liveConsumptionCents(POT_45B), "Cascade-Storno macht §45b netto null").toBe(0);
    expect(await liveConsumptionCents(POT_45A), "Cascade-Storno macht §45a netto null").toBe(0);

    // (3) A erneut abrechnen → Re-Book muss BEIDE Töpfe wiederherstellen.
    const gen2 = await generate(year, month);
    expect(gen2.isSplit, "Re-Abrechnung von A bleibt Mehrtopf-Split").toBe(true);
    expect(gen2.invoices.length, "Re-Abrechnung = wieder 2 Rechnungen").toBe(2);
    expect(await liveConsumptionCents(POT_45B), "Re-Book stellt §45b wieder her").toBe(A_45B_CENTS);
    expect(await liveConsumptionCents(POT_45A), "Re-Book stellt §45a wieder her").toBe(A_45A_CENTS);

    // (4) SPÄTEREN Termin B: §45b ist (nach Re-Book) erschöpft → B läuft
    //     komplett in §45a. Bewertet die nach dem Re-Book reduzierte
    //     §45b-Verfügbarkeit.
    const apptB = await createAppt(year, month, APPT_B_MINUTES, "B", "latest");
    await documentAppt(apptB.id, apptB.time, APPT_B_MINUTES);
    await createAndSignSr(year, month);
    const gen3 = await generate(year, month);
    // B berührt nur §45a → Single-Pot-Pfad (eine §45a-Kasse-Rechnung).
    expect(gen3.invoices.length, "B-Abrechnung erzeugt genau 1 Rechnung").toBe(1);
    expect(gen3.invoices[0].billingType, "B bleibt Kasse-Rechnung").toBe("pflegekasse_gesetzlich");
    expect(gen3.invoices[0].netAmountCents, "B-Rechnung Netto = voller B-Betrag").toBe(APPT_B_COST_CENTS);

    // === Mehrtopf-Doppel-Spend-Garantie ===
    const ledger45b = await liveConsumptionCents(POT_45B);
    const ledger45a = await liveConsumptionCents(POT_45A);
    const active = await activeInvoices();

    // Genau drei aktive Rechnungen: re-abgerechnetes A (§45b + §45a) + B (§45a).
    expect(active.length, "genau 3 aktive Rechnungen (A§45b + A§45a + B§45a)").toBe(3);

    // Rechnungs-Netto pro Topf. Die §45b-Split-Rechnung trägt budgetType=§45b.
    // Die §45a-Anteile verteilen sich auf die §45a-Split-Rechnung (A,
    // budgetType=§45a) UND die ungetaggte Single-Pot-Kasse-Rechnung (B): in
    // diesem kontrollierten Szenario sind §45b/§45a die EINZIGEN aktiven Töpfe,
    // also gehört jede aktive Kasse-Rechnung ohne §45b-Tag zu §45a.
    const inv45b = active.filter((i) => i.budgetType === POT_45B);
    const inv45a = active.filter((i) => i.budgetType !== POT_45B);
    const net45b = inv45b.reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    const net45a = inv45a.reduce((s, i) => s + (i.netAmountCents ?? 0), 0);

    // Kern-Regression PRO TOPF: Σ aktive Rechnungen === Ledger-Live.
    expect(net45b, "§45b: Σ aktive Rechnungen === Ledger-Live (kein Doppel-Spend)").toBe(ledger45b);
    expect(net45a, "§45a: Σ aktive Rechnungen === Ledger-Live (kein Doppel-Spend)").toBe(ledger45a);

    // Erwartete absolute Werte: §45b = A(5000); §45a = A-Überlauf(1300) + B(2100).
    expect(ledger45b, "Ledger-§45b = A-Anteil").toBe(A_45B_CENTS);
    expect(ledger45a, "Ledger-§45a = A-Überlauf + B").toBe(A_45A_CENTS + APPT_B_COST_CENTS);

    // Kein Topf wird über seine Kapazität hinaus belegt.
    expect(ledger45b, "§45b-Live ≤ Kapazität").toBeLessThanOrEqual(POT_45B_CAP_CENTS);
    expect(ledger45a, "§45a-Live ≤ Kapazität").toBeLessThanOrEqual(POT_45A_CAP_CENTS);

    // Gesamt-Deckungsgleichheit als zusätzliche Sicherung.
    const totalNet = net45b + net45a;
    const totalLedger = ledger45b + ledger45a;
    expect(totalLedger, "Gesamt-Ledger = A + B").toBe(APPT_A_COST_CENTS + APPT_B_COST_CENTS);
    expect(totalNet, "Gesamt aktive Rechnungen === Gesamt-Ledger").toBe(totalLedger);
  }, 180_000);
});
