/**
 * Task #1028 — End-to-End: Re-abgerechnete Termine dürfen auch dann keinen Topf
 * doppelt verbrauchen, wenn die Kaskade aus einem gedeckelten Kassen-Topf in den
 * PRIVATEN Selbstzahler-Topf (uncapped, 19 % USt) überläuft.
 *
 * Die Schwester-Suite `rebill-no-double-spend-multipot-e2e.test.ts` (Task #1025)
 * deckt die reine Kassen-Kaskade §45b → §45a ab (beide steuerfrei, eine
 * billingRunId, alle Split-Rechnungen Kasse). Der hier getestete Pfad ist
 * fundamental anders:
 *
 *   - Der Kunde akzeptiert Privatzahlung (`acceptsPrivatePayment: true`). Ein
 *     gedeckelter §45a-Topf läuft in den privaten uncapped-Terminal-Topf über
 *     (`createCascadeConsumption({ privatePot })`, budgetType `"private"`).
 *   - Der Mehrtopf-Lauf erzeugt einen GEMISCHTEN Split: eine Kasse-Rechnung
 *     (§45a, steuerfrei) UND eine Selbstzahler-Rechnung (privat, 19 % USt,
 *     `billingType="selbstzahler"`, `vatRate=1900`) — siehe
 *     `generateInvoiceCore` (Selbstzahler-Reklassifikation + USt-Verteilung).
 *   - Der Storno→Re-Book-Round-Trip muss BEIDE Anteile wiederherstellen: die
 *     §45a-Consumption UND den privaten Rest (`rebookNetZeroAppointmentConsumption`
 *     hängt den privaten uncapped-Topf immer als Terminal an).
 *
 * Flow:
 *   1. Termin A (lang) anlegen, dokumentieren → Kaskade §45a (voll bis Cap) →
 *      privat (Rest), abrechnen → gemischter Split (1×§45a-Kasse +
 *      1×privat-Selbstzahler, gleiche billingRunId).
 *   2. EINE der Split-Rechnungen mit `cascadeRun: true` stornieren → alle
 *      Geschwister storniert, A in §45a UND privat netto null.
 *   3. A erneut abrechnen → Re-Book bucht A frisch nach (muss §45a UND privat
 *      wiederherstellen) → erneut gemischter Split.
 *   4. SPÄTEREN Termin B anlegen, dokumentieren (liest jetzt das nach dem
 *      Re-Book erschöpfte §45a → B läuft KOMPLETT privat), abrechnen → reine
 *      Selbstzahler-Rechnung.
 *
 * Kern-Assertion (fängt den Doppel-Spend-Bug) — PRO TOPF:
 *   Σ(Live-Consumption im Ledger des Topfs) === Σ(Netto der aktiven Rechnungen
 *   dieses Topfs), und die privaten Rechnungen bleiben 19 % USt / Selbstzahler.
 *
 * Ohne den Re-Book (Bug-Zustand) bliebe A in beiden Töpfen netto null → Ledger-
 * Live = nur B (komplett privat, weil §45a wieder frei wäre würde B in §45a
 * laufen) → pro Topf Ledger ≠ Rechnungen → Doppel-Belegung / Fehl-Attribution
 * des privaten Rests über zwei aktive Rechnungen.
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

// §45a ist knapp gedeckelt, damit ein langer Termin in den privaten Topf
// überläuft. §45b ist deaktiviert → die Kaskade beginnt bei §45a.
const POT_45A_CAP_CENTS = 5000;

// Termin A überläuft §45a → privat; Termin B (nach A erschöpftem §45a) läuft
// komplett privat.
const APPT_A_MINUTES = 90;
const APPT_A_COST_CENTS = (AB_HOURLY_CENTS * APPT_A_MINUTES) / 60; // 6300
const APPT_B_MINUTES = 30;
const APPT_B_COST_CENTS = (AB_HOURLY_CENTS * APPT_B_MINUTES) / 60; // 2100

// Erwartete Cascade-Aufteilung von Termin A.
const A_45A_CENTS = POT_45A_CAP_CENTS;                 // 5000 (§45a voll bis Cap)
const A_PRIVATE_CENTS = APPT_A_COST_CENTS - A_45A_CENTS; // 1300 (Rest → privat)

const POT_45A = "umwandlung_45a";
const POT_PRIVATE = "private";

function vat19(netCents: number): number {
  return Math.round((netCents * 1900) / 10000);
}

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

/** Legt einen Pflegekasse-Kunden MIT akzeptierter Privatzahlung
 *  (`acceptsPrivatePayment: true`) an: §45b deaktiviert, §45a (Prio 1) knapp
 *  gedeckelt, §39 aus. So läuft die Kaskade §45a → privat (uncapped Terminal). */
async function setupPrivateOverflowCustomer(monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "DoubleSpendPrivate",
    nachname: `Rebill-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `double-spend-private-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "7",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000079",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: true,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  const id = custRes.data.id;

  const assignRes = await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

  const init45a = await apiPost(`/api/budget/${id}/initial-budget`, {
    budgetType: POT_45A,
    currentMonthAmountCents: POT_45A_CAP_CENTS,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45a: ${JSON.stringify(init45a.data)}`).toContain(init45a.status);

  const typesRes = await apiPut(`/api/budget/${id}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: POT_45A, enabled: true, priority: 1, monthlyLimitCents: POT_45A_CAP_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
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
 *  weil die §45a-Verfügbarkeit beim Dokumentieren as-of dem Termindatum gelesen
 *  wird (Monats-Cap): B muss A's §45a-Verbrauch bereits sehen, sonst läge B
 *  fälschlich in §45a statt komplett privat. */
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
        notes: `DoubleSpendPrivate-${tag}-${uniqueId()}`,
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
    services: [{ serviceId: abServiceId, actualDurationMinutes: durationMinutes, details: "DoubleSpendPrivate-Test" }],
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

describe("Re-Rechnung darf bei §45a→PRIVAT-Überlauf keinen Topf doppelt verbrauchen — E2E (Task #1028)", () => {
  it("bill A (§45a-Kasse + Privat-Split) → cascade-storno → re-bill A (re-book beide Anteile) → bill B (komplett privat): pro Topf Ledger === aktive Rechnungen, Privat bleibt 19 % USt / Selbstzahler", async () => {
    const { year, month } = billingReferenceMonth();
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

    customerId = await setupPrivateOverflowCustomer(monthStart);

    // (1) Termin A: lang genug, um §45a (Cap) zu erschöpfen und in privat
    //     überzulaufen.
    const apptA = await createAppt(year, month, APPT_A_MINUTES, "A", "earliest");
    await documentAppt(apptA.id, apptA.time, APPT_A_MINUTES);
    await createAndSignSr(year, month);

    // Kaskade muss VOR der Abrechnung zwei echte Consumption-Zeilen erzeugt
    // haben (§45a + privat), sonst wäre das Szenario kein Überlauf-Test.
    expect(await liveConsumptionCents(POT_45A), "A muss §45a bis Cap belegen").toBe(A_45A_CENTS);
    expect(await liveConsumptionCents(POT_PRIVATE), "A muss in den privaten Topf überlaufen").toBe(A_PRIVATE_CENTS);

    const gen1 = await generate(year, month);
    expect(gen1.isSplit, "Mehrtopf-Lauf muss Split-Rechnungen liefern").toBe(true);
    expect(gen1.invoices.length, "Split = 1 Kasse-Rechnung (§45a) + 1 Selbstzahler-Rechnung (privat)").toBe(2);
    const runIds = new Set(gen1.invoices.map((i) => i.billingRunId));
    expect(runIds.size, "alle Split-Rechnungen teilen dieselbe billingRunId").toBe(1);

    const inv45aA = gen1.invoices.find((i) => i.budgetType === POT_45A);
    const invPrivateA = gen1.invoices.find((i) => i.billingType === "selbstzahler");
    expect(inv45aA?.netAmountCents, "§45a-Kasse-Rechnung Netto").toBe(A_45A_CENTS);
    expect(inv45aA?.billingType, "§45a-Anteil bleibt Kasse").toBe("pflegekasse_gesetzlich");
    expect(invPrivateA?.netAmountCents, "Privat-Rechnung Netto").toBe(A_PRIVATE_CENTS);
    expect(invPrivateA?.billingType, "Privat-Anteil ist Selbstzahler").toBe("selbstzahler");
    expect(invPrivateA?.vatRate, "Privat-Rechnung trägt 19 % USt").toBe(1900);
    expect(invPrivateA?.vatAmountCents, "Privat-Rechnung USt-Betrag = 19 % vom Netto").toBe(vat19(A_PRIVATE_CENTS));

    // (2) EINE Split-Rechnung mit Cascade stornieren → alle Geschwister
    //     storniert, A in BEIDEN Töpfen netto null.
    const storno = await apiPatch<any>(`/api/billing/${gen1.invoices[0].id}/status`, {
      status: "storniert",
      cascadeRun: true,
    });
    expect(storno.status, `cascade-storno: ${JSON.stringify(storno.data)}`).toBe(200);
    await trackStornoInvoices();

    const afterStorno = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
    const runOriginals = (afterStorno.data as any[]).filter(
      (i) => i.billingRunId === gen1.invoices[0].billingRunId && i.invoiceType !== "stornorechnung",
    );
    for (const i of runOriginals) {
      expect(i.status, `Rechnung ${i.id} muss nach Cascade-Storno 'storniert' sein`).toBe("storniert");
    }
    expect(await liveConsumptionCents(POT_45A), "Cascade-Storno macht §45a netto null").toBe(0);
    expect(await liveConsumptionCents(POT_PRIVATE), "Cascade-Storno macht privat netto null").toBe(0);

    // (3) A erneut abrechnen → Re-Book muss BEIDE Anteile wiederherstellen.
    const gen2 = await generate(year, month);
    expect(gen2.isSplit, "Re-Abrechnung von A bleibt gemischter Split").toBe(true);
    expect(gen2.invoices.length, "Re-Abrechnung = wieder 2 Rechnungen").toBe(2);
    expect(await liveConsumptionCents(POT_45A), "Re-Book stellt §45a wieder her").toBe(A_45A_CENTS);
    expect(await liveConsumptionCents(POT_PRIVATE), "Re-Book stellt den privaten Rest wieder her").toBe(A_PRIVATE_CENTS);

    // (4) SPÄTEREN Termin B: §45a ist (nach Re-Book) bis Cap erschöpft → B läuft
    //     komplett privat. Bewertet die nach dem Re-Book reduzierte
    //     §45a-Verfügbarkeit.
    const apptB = await createAppt(year, month, APPT_B_MINUTES, "B", "latest");
    await documentAppt(apptB.id, apptB.time, APPT_B_MINUTES);
    await createAndSignSr(year, month);
    const gen3 = await generate(year, month);
    // B berührt nur den privaten Topf → Single-Pot-Pfad (reine
    // Selbstzahler-Rechnung).
    expect(gen3.invoices.length, "B-Abrechnung erzeugt genau 1 Rechnung").toBe(1);
    expect(gen3.invoices[0].billingType, "B ist komplett Selbstzahler").toBe("selbstzahler");
    expect(gen3.invoices[0].netAmountCents, "B-Rechnung Netto = voller B-Betrag").toBe(APPT_B_COST_CENTS);
    expect(gen3.invoices[0].vatRate, "B-Rechnung trägt 19 % USt").toBe(1900);
    expect(gen3.invoices[0].vatAmountCents, "B-Rechnung USt-Betrag = 19 % vom Netto").toBe(vat19(APPT_B_COST_CENTS));

    // === Doppel-Spend-Garantie pro Topf ===
    const ledger45a = await liveConsumptionCents(POT_45A);
    const ledgerPrivate = await liveConsumptionCents(POT_PRIVATE);
    const active = await activeInvoices();

    // Genau drei aktive Rechnungen: re-abgerechnetes A (§45a + privat) + B (privat).
    expect(active.length, "genau 3 aktive Rechnungen (A§45a + A-privat + B-privat)").toBe(3);

    // Rechnungs-Netto pro Topf. Die §45a-Kasse-Rechnung trägt
    // budgetType=§45a/billingType=Kasse. Die privaten Anteile sind die
    // Selbstzahler-Rechnungen (A-privat + B-privat).
    const inv45a = active.filter((i) => i.billingType !== "selbstzahler");
    const invPrivate = active.filter((i) => i.billingType === "selbstzahler");
    const net45a = inv45a.reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    const netPrivate = invPrivate.reduce((s, i) => s + (i.netAmountCents ?? 0), 0);

    // Kern-Regression PRO TOPF: Σ aktive Rechnungen === Ledger-Live.
    expect(net45a, "§45a: Σ aktive Rechnungen === Ledger-Live (kein Doppel-Spend)").toBe(ledger45a);
    expect(netPrivate, "privat: Σ aktive Rechnungen === Ledger-Live (kein Doppel-Spend)").toBe(ledgerPrivate);

    // Erwartete absolute Werte: §45a = A(5000); privat = A-Überlauf(1300) + B(2100).
    expect(ledger45a, "Ledger-§45a = A-Anteil").toBe(A_45A_CENTS);
    expect(ledgerPrivate, "Ledger-privat = A-Überlauf + B").toBe(A_PRIVATE_CENTS + APPT_B_COST_CENTS);

    // §45a wird nicht über seinen Cap hinaus belegt; der private Topf ist uncapped.
    expect(ledger45a, "§45a-Live ≤ Cap").toBeLessThanOrEqual(POT_45A_CAP_CENTS);

    // Alle privaten Rechnungen bleiben 19 % USt / Selbstzahler.
    for (const i of invPrivate) {
      expect(i.vatRate, `Privat-Rechnung ${i.id} trägt 19 % USt`).toBe(1900);
      expect(i.vatAmountCents, `Privat-Rechnung ${i.id} USt = 19 % vom Netto`).toBe(vat19(i.netAmountCents ?? 0));
    }

    // Gesamt-Deckungsgleichheit als zusätzliche Sicherung.
    const totalNet = net45a + netPrivate;
    const totalLedger = ledger45a + ledgerPrivate;
    expect(totalLedger, "Gesamt-Ledger = A + B").toBe(APPT_A_COST_CENTS + APPT_B_COST_CENTS);
    expect(totalNet, "Gesamt aktive Rechnungen === Gesamt-Ledger").toBe(totalLedger);
  }, 180_000);
});
