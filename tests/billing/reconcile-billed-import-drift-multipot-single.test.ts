/**
 * Task #1663 — Integrationstest: die GoBD-Reparatur (Storno + Neuausstellung,
 * `server/scripts/reconcile-billed-appointment-import-drift.ts`, Task #1651)
 * funktioniert auch für MEHR-TOPF-Kunden (§45b → §45a-Kaskade).
 *
 * Die Schwester-Suite `reconcile-billed-import-drift.test.ts` (Task #1653) deckt
 * den EINFACHEN Fall ab: EIN §45b-Topf → EINE Rechnung. Der hier getestete Pfad
 * ist fundamental anders:
 *
 *   - Der lange Termin erschöpft §45b (knapp gedeckelt) und kaskadiert in §45a
 *     (beide Kassen-Töpfe, steuerfrei) — echte MEHR-TOPF-Konsumtion.
 *   - Der Mehr-Topf-Lauf erzeugt N SPLIT-Rechnungen (eine pro Topf) mit
 *     gemeinsamer `billing_run_id` (`shared/domain/budget-invoice-split.ts`).
 *
 * Die Reparatur muss deshalb:
 *   1. ALLE Split-Rechnungen des Laufs stornieren (Cascade über die
 *      `billing_run_id`) — nie eine Geschwister-Rechnung vergessen; jede Original
 *      bekommt eine negierte Stornorechnung, die Line-Items bleiben unberührt.
 *   2. Den Monat neu ausstellen → wieder N Split-Rechnungen, und der PER-TOPF-
 *      Σ-Invariant hält: Σ(Netto aktiver Rechnungen eines Topfs) === Σ(Live-
 *      Consumption dieses Topfs im Ledger).
 *   3. Den signierten LN soft-stornieren + den Termin zur Neu-Doku ausweisen.
 *
 * Drift-Auslöser: identisch zur Schwester-Suite — nach dem Siegel wird eine
 * zusätzliche Consumption-Buchung (auf EINEM der Töpfe) mit `created_at` NACH dem
 * Siegel eingefügt (Signal A `consumptionRebookedAfterSeal`, budget-typ-agnostisch).
 *
 * Object-Storage-Gate: Storno-PDF-Persistierung + Neuausstellung schreiben echte
 * PDF-Objekte → die Suite skippt sauber ohne Object-Storage-Sidecar
 * (GitHub-Actions-CI-Muster, vgl. tests/helpers/object-storage.ts).
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { describe as objectStorageDescribe } from "../helpers/object-storage";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetTransactions,
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  users,
} from "@shared/schema";
import {
  reconcile,
  type Args,
} from "../../server/scripts/reconcile-billed-appointment-import-drift";
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
// Termin länger als das §45b-Maximum → Kaskade nach §45a ist garantiert.
const APPT_MINUTES = 240;
const APPT_COST_CENTS = (AB_HOURLY_CENTS * APPT_MINUTES) / 60; // 16800

const POT_45B = "entlastungsbetrag_45b";
const POT_45A = "umwandlung_45a";
// §45b knapp deckeln (initial + Monats-Limit) → Rest läuft nach §45a.
const POT_45B_CAP_CENTS = 1000;
const POT_45A_CAP_CENTS = 59880;

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abServiceId: number;
let superadminId: number;
let customerId: number;
let apptId: number;
let apptDate: string;
let serviceRecordId: number;
let originalInvoiceIds: number[] = [];
let originalBillingRunId: string | null = null;

const cleanupInvoiceIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
];

/** Kassen-Kunde (PG3) mit ZWEI Töpfen: §45b knapp gedeckelt (Prio 1) → §45a. */
async function setupMultiPotCustomer(monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ImportDriftMultiPot",
    nachname: `Reconcile-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `import-drift-multipot-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "5",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000081",
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

/** Legt einen langen Alltagsbegleitung-Termin in einem freien Werktags-Slot an. */
async function createAppt(year: number, month: number): Promise<{ id: number; date: string; time: string }> {
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
        notes: `ImportDriftMultiPot-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: abServiceId, durationMinutes: APPT_MINUTES }],
      });
      if (res.status === 201) return { id: res.data.id, date: dateStr, time };
    }
  }
  throw new Error("createAppt: kein freier Werktags-Slot im Monat gefunden");
}

async function documentAppt(id: number, time: string): Promise<void> {
  const res = await apiPost<unknown>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: abServiceId, actualDurationMinutes: APPT_MINUTES, details: "ImportDriftMultiPot-Test" }],
  });
  if (res.status !== 200) throw new Error(`document failed: ${res.status} ${JSON.stringify(res.data)}`);
}

/** Erstellt + signiert (Mitarbeiter + Kunde) den monatlichen Leistungsnachweis. */
async function createAndSignSr(year: number, month: number): Promise<number> {
  const cre = await apiPost<{ id: number }>("/api/service-records", {
    customerId,
    employeeId: auth.user.id,
    year,
    month,
  });
  expect(cre.status, `SR create: ${JSON.stringify(cre.data)}`).toBe(201);
  const srId = cre.data.id;
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<unknown>(`/api/service-records/${srId}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    expect(sig.status, `SR sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
  }
  return srId;
}

interface GenResult {
  isSplit: boolean;
  invoices: Array<{ id: number; billingRunId: string | null; budgetType: string | null; netAmountCents?: number }>;
}

async function generate(year: number, month: number): Promise<GenResult> {
  const gen = await apiPost<any>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const isSplit = !!gen.data?.splitInvoices;
  const invoices: GenResult["invoices"] = isSplit ? gen.data.invoices : [gen.data];
  for (const inv of invoices) if (inv?.id) cleanupInvoiceIds.push(inv.id);
  return { isSplit, invoices };
}

/** Summe der LIVE-Consumption im Ledger für EINEN Topf (Consumption minus reversierte). */
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

/** Distinct Töpfe mit LIVE-Consumption. */
async function livePots(): Promise<string[]> {
  const rows = await db.select({
    budgetType: budgetTransactions.budgetType,
    transactionType: budgetTransactions.transactionType,
    id: budgetTransactions.id,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.transactionType, "consumption"),
  ));
  const pots = new Set<string>();
  for (const r of rows) {
    if ((await liveConsumptionCents(r.budgetType)) > 0) pots.add(r.budgetType);
  }
  return [...pots];
}

/** Aktive (nicht-stornierte, keine Stornorechnungen) Rechnungen des Kunden. */
async function activeInvoices(): Promise<Array<{ id: number; netAmountCents: number | null; budgetType: string | null; billingType: string | null; status: string; invoiceType: string }>> {
  const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
  const rows = Array.isArray(list.data) ? list.data : [];
  return rows.filter((i) => i.status !== "storniert" && i.invoiceType !== "stornorechnung");
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

  const [sa] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isSuperAdmin, true), eq(users.isActive, true)))
    .limit(1);
  superadminId = sa?.id ?? auth.user.id;

  const { year, month } = billingReferenceMonth();
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

  customerId = await setupMultiPotCustomer(monthStart);

  // Realer Abrechnungs-Fluss: anlegen → dokumentieren (bucht §45b → §45a) → LN
  // signieren (= Siegel) → Rechnung erstellen (= N versiegelte Split-Rechnungen).
  const appt = await createAppt(year, month);
  apptId = appt.id;
  apptDate = appt.date;
  await documentAppt(apptId, appt.time);

  // Kaskade muss über >1 Topf laufen — sonst wäre der Test kein Mehr-Topf-Test.
  const pots = await livePots();
  expect(pots.length, `Buchung muss über mehrere Töpfe kaskadieren (gefunden: ${pots.join(",")})`).toBeGreaterThanOrEqual(2);
  expect(
    (await liveConsumptionCents(POT_45B)) + (await liveConsumptionCents(POT_45A)),
    "Σ Live-Consumption (§45b + §45a) == Termin-Kosten",
  ).toBe(APPT_COST_CENTS);

  serviceRecordId = await createAndSignSr(year, month);

  const gen = await generate(year, month);
  expect(gen.isSplit, "Mehr-Topf-Lauf muss Split-Rechnungen liefern").toBe(true);
  expect(gen.invoices.length, "Split muss >1 Rechnung erzeugen").toBeGreaterThanOrEqual(2);
  const runIds = new Set(gen.invoices.map((i) => i.billingRunId));
  expect(runIds.size, "alle Split-Rechnungen teilen dieselbe billingRunId").toBe(1);
  originalBillingRunId = [...runIds][0];
  expect(originalBillingRunId, "billingRunId muss gesetzt sein").toBeTruthy();
  originalInvoiceIds = gen.invoices.map((i) => i.id);

  // Drift-Injektion: eine zusätzliche Consumption (auf §45b) NACH dem Siegel —
  // so wie ein früherer Vor-Guard-Excel-Import den bereits abgerechneten Termin
  // still neu verbucht hätte. Feuert Signal A (budget-typ-agnostisch).
  const postSeal = new Date(Date.now() + 60 * 60 * 1000); // +1h ⇒ garantiert nach dem Siegel
  await db.insert(budgetTransactions).values({
    customerId,
    budgetType: POT_45B,
    transactionDate: apptDate,
    transactionType: "consumption",
    amountCents: -POT_45B_CAP_CENTS,
    alltagsbegleitungMinutes: APPT_MINUTES,
    alltagsbegleitungCents: POT_45B_CAP_CENTS,
    appointmentId: apptId,
    notes: "Test: simulierter Nach-Siegel-Import-Rebook (Task #1663, Mehr-Topf)",
    createdAt: postSeal,
  });
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  try { await apiDelete(`/api/service-records/${serviceRecordId}`); } catch { /* best-effort */ }
  try { await apiDelete(`/api/appointments/${apptId}`); } catch { /* best-effort */ }
  await cleanupCustomer(customerId);
  await runCleanup();
});

objectStorageDescribe("Import-Drift-Reparatur (Mehr-Topf §45b→§45a): Cascade-Storno + Split-Neuausstellung (Task #1663)", () => {
  it("Trockenlauf erkennt den Drift und löst ALLE Split-Rechnungen des Termins auf, schreibt aber NICHTS", async () => {
    const args: Args = {
      apply: false,
      customerIds: [],
      appointmentIds: [apptId],
      importLinkedOnly: false,
    };
    const summary = await reconcile(args);

    const flagged = summary.flagged.find((r) => r.appointmentId === apptId);
    expect(flagged, "Termin muss als Drift erkannt werden").toBeDefined();
    expect(flagged!.consumptionRebookedAfterSeal, "Signal A muss feuern").toBe(true);

    // Plan erfasst BEIDE Split-Rechnungen des Termins.
    const planItem = summary.plan.find((p) => p.appointmentId === apptId);
    expect(planItem, "Reparatur-Plan enthält den Termin").toBeDefined();
    for (const invId of originalInvoiceIds) {
      expect(planItem!.sealedInvoiceIds, `Split-Rechnung ${invId} muss im Plan sein`).toContain(invId);
    }
    expect(planItem!.signedServiceRecordIds).toContain(serviceRecordId);

    // KEINE Schreib-Effekte im Trockenlauf.
    expect(summary.stornoedInvoiceIds).toHaveLength(0);
    expect(summary.reissuedInvoiceIds).toHaveLength(0);
    expect(summary.softStornoedServiceRecordIds).toHaveLength(0);
    expect(summary.batchId).toBeUndefined();

    for (const invId of originalInvoiceIds) {
      const [inv] = await db.select({ status: invoicesTable.status })
        .from(invoicesTable).where(eq(invoicesTable.id, invId)).limit(1);
      expect(inv.status, `Rechnung ${invId} bleibt im Trockenlauf aktiv`).not.toBe("storniert");
    }
  }, 180_000);

  it("scharfer Lauf: ALLE Split-Rechnungen storniert (Cascade), Monat neu ausgestellt, PER-TOPF Σ === Ledger, LN soft-storniert", async () => {
    // Eingefrorene Original-Line-Items je Split-Rechnung VOR der Reparatur festhalten.
    const beforeLinesByInvoice = new Map<number, unknown[]>();
    for (const invId of originalInvoiceIds) {
      const lines = await db.select({
        id: invoiceLineItems.id,
        totalCents: invoiceLineItems.totalCents,
        durationMinutes: invoiceLineItems.durationMinutes,
        appointmentId: invoiceLineItems.appointmentId,
        serviceCode: invoiceLineItems.serviceCode,
      }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invId));
      expect(lines.length, `Original-Rechnung ${invId} hat Line-Items`).toBeGreaterThan(0);
      beforeLinesByInvoice.set(invId, lines);
    }

    const args: Args = {
      apply: true,
      customerIds: [],
      appointmentIds: [apptId],
      userId: superadminId,
      reason: "Integrationstest Import-Drift-Reparatur Mehr-Topf #1663",
      importLinkedOnly: false,
    };
    const summary = await reconcile(args);

    // --- Garantie 1: JEDE Split-Rechnung des Laufs ist storniert (Cascade),
    //     nie in-place editiert; je Original genau eine negierte Stornorechnung.
    const runInvoices = await db.select({
      id: invoicesTable.id,
      status: invoicesTable.status,
      invoiceType: invoicesTable.invoiceType,
      billingRunId: invoicesTable.billingRunId,
    }).from(invoicesTable).where(eq(invoicesTable.customerId, customerId));

    const runOriginals = runInvoices.filter(
      (i) => i.billingRunId === originalBillingRunId && i.invoiceType !== "stornorechnung",
    );
    expect(runOriginals.length, "beide Original-Split-Rechnungen weiterhin vorhanden").toBe(originalInvoiceIds.length);
    for (const inv of runOriginals) {
      expect(inv.status, `Split-Rechnung ${inv.id} muss nach Cascade-Storno 'storniert' sein`).toBe("storniert");
    }
    // Der Reparatur-Lauf meldet mind. eine explizit stornierte Rechnung
    // (Cascade-Geschwister werden vom Storno-Pfad selbst miterledigt).
    expect(summary.stornoedInvoiceIds.length, "mindestens eine Rechnung explizit storniert").toBeGreaterThan(0);
    expect(originalInvoiceIds, "storniertes Original gehört zum Lauf").toContain(summary.stornoedInvoiceIds[0]);

    // Je Original genau eine negierte Stornorechnung + Line-Items unverändert.
    for (const invId of originalInvoiceIds) {
      const stornos = await db.select({ id: invoicesTable.id })
        .from(invoicesTable).where(and(
          eq(invoicesTable.customerId, customerId),
          eq(invoicesTable.invoiceType, "stornorechnung"),
          eq(invoicesTable.stornierteRechnungId, invId),
        ));
      expect(stornos.length, `genau eine Stornorechnung zu Original ${invId}`).toBe(1);
      for (const s of stornos) cleanupInvoiceIds.push(s.id);

      const afterLines = await db.select({
        id: invoiceLineItems.id,
        totalCents: invoiceLineItems.totalCents,
        durationMinutes: invoiceLineItems.durationMinutes,
        appointmentId: invoiceLineItems.appointmentId,
        serviceCode: invoiceLineItems.serviceCode,
      }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invId));
      expect(afterLines, `Line-Items der Original-Rechnung ${invId} unverändert`).toEqual(beforeLinesByInvoice.get(invId));
    }

    // --- Garantie 2: Monat neu ausgestellt → wieder Split, PER-TOPF Σ === Ledger.
    expect(summary.reissuedInvoiceIds.length, "Neuausstellung erzeugt wieder >1 Rechnung (Split)").toBeGreaterThanOrEqual(2);
    for (const rid of summary.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);

    // Die frischen Rechnungen decken den frei gewordenen Termin ab.
    const reissuedApptIds = new Set<number>();
    for (const rid of summary.reissuedInvoiceIds) {
      const lines = await db.select({ appointmentId: invoiceLineItems.appointmentId })
        .from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, rid));
      for (const l of lines) if (l.appointmentId != null) reissuedApptIds.add(l.appointmentId);
    }
    expect(reissuedApptIds, "neu ausgestellte Rechnungen decken den Termin ab").toContain(apptId);

    // Neuer Lauf, EINE gemeinsame billingRunId für die frischen Split-Rechnungen.
    const active = await activeInvoices();
    const reissuedRunIds = new Set(
      active.filter((i) => summary.reissuedInvoiceIds.includes(i.id)).map((i) => (i as any).billingRunId),
    );
    expect(reissuedRunIds.size, "frische Split-Rechnungen teilen EINE billingRunId").toBe(1);

    // Kern-Invariant PER TOPF: Σ Netto aktiver Rechnungen === Live-Consumption.
    const live45b = await liveConsumptionCents(POT_45B);
    const live45a = await liveConsumptionCents(POT_45A);
    const net45b = active.filter((i) => i.budgetType === POT_45B).reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    const net45a = active.filter((i) => i.budgetType === POT_45A).reduce((s, i) => s + (i.netAmountCents ?? 0), 0);

    expect(net45b, "§45b: Σ aktive Rechnungen === Live-Ledger (kein Doppel-Spend)").toBe(live45b);
    expect(net45a, "§45a: Σ aktive Rechnungen === Live-Ledger (kein Doppel-Spend)").toBe(live45a);

    // Gesamt-Deckungsgleichheit + genau EIN Termin-Kostenäquivalent (der
    // injizierte Nach-Siegel-Drift wurde durch Storno reversiert, NICHT doppelt
    // abgerechnet).
    const totalNet = active.reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    expect(live45b + live45a, "Σ Live-Consumption == Termin-Kosten (kein doppelter Drift)").toBe(APPT_COST_CENTS);
    expect(totalNet, "Σ aktive Rechnungen === Σ Live-Ledger (gesamt)").toBe(live45b + live45a);

    // Cascade darf keinen Topf verlieren: beide Töpfe weiterhin belegt.
    expect(live45b, "§45b weiterhin belegt").toBeGreaterThan(0);
    expect(live45a, "§45a weiterhin belegt").toBeGreaterThan(0);

    // --- Garantie 3: signierter LN soft-storniert, KEIN Auto-Reset.
    expect(summary.softStornoedServiceRecordIds, "LN soft-storniert").toContain(serviceRecordId);
    const [ln] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, serviceRecordId)).limit(1);
    expect(ln.deletedAt, "LN hat deleted_at").not.toBeNull();

    const liveLns = await db.select({ id: monthlyServiceRecords.id })
      .from(monthlyServiceRecords).where(and(
        eq(monthlyServiceRecords.customerId, customerId),
        isNull(monthlyServiceRecords.deletedAt),
      ));
    expect(liveLns.length, "kein Auto-Reset des LN (Task #576)").toBe(0);

    // --- Garantie 4: Termin zur manuellen Neu-Dokumentation ausgewiesen.
    expect(summary.lnReDocRequiredAppointmentIds, "Termin zur Neu-Doku freigegeben").toContain(apptId);
  }, 180_000);
});
