/**
 * Task #1663 — Integrationstest: die GoBD-Reparatur (Storno + Neuausstellung,
 * `server/scripts/reconcile-billed-appointment-import-drift.ts`, Task #1651)
 * funktioniert auch für SELBSTZAHLER / Privatzahlungs-Kunden (privater Topf,
 * 19 % USt).
 *
 * Die Schwester-Suiten decken Kassen-Töpfe ab:
 *   - `reconcile-billed-import-drift.test.ts` (Task #1653): EIN §45b-Topf (steuerfrei).
 *   - `reconcile-billed-import-drift-multipot.test.ts` (Task #1663): §45b→§45a (steuerfrei).
 *
 * Der hier getestete Pfad ist fundamental anders: ein Selbstzahler bucht 100 %
 * in den PRIVATEN Topf (`budgetType="private"`), und die Rechnung ist eine
 * Selbstzahler-Rechnung mit 19 % USt (`billingType="selbstzahler"`,
 * `vatRate=1900`) — siehe `generateInvoiceCore` (USt-Verteilung).
 *
 * Die Reparatur muss deshalb:
 *   1. Die versiegelte Selbstzahler-Rechnung stornieren (append-only: Original
 *      auf `storniert`, negierte Stornorechnung, Line-Items unberührt).
 *   2. Den Monat neu ausstellen → wieder eine Selbstzahler-Rechnung mit 19 % USt,
 *      und Σ(Netto aktiver Rechnungen) === Σ(Live-Consumption im privaten Topf).
 *   3. Den signierten LN soft-stornieren + den Termin zur Neu-Doku ausweisen.
 *
 * Drift-Auslöser: identisch zu den Schwester-Suiten — nach dem Siegel eine
 * zusätzliche `private`-Consumption mit `created_at` NACH dem Siegel (Signal A
 * `consumptionRebookedAfterSeal`, budget-typ-agnostisch).
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
  auditLog,
  users,
} from "@shared/schema";
import {
  reconcile,
  type Args,
} from "../../server/scripts/reconcile-billed-appointment-import-drift";
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  getAuthCookie,
  uniqueId,
  cleanupCustomer,
  runCleanup,
} from "../test-utils";
import { billingReferenceDate, billingReferenceMonth } from "../helpers/billing-month";

const AB_HOURLY_CENTS = 4200; // Alltagsbegleitung, siehe scripts/seed-test-reference-data.ts
const APPT_MINUTES = 60;
const APPT_COST_CENTS = (AB_HOURLY_CENTS * APPT_MINUTES) / 60; // 4200 (Netto)
const POT_PRIVATE = "private";

/** 19 % USt auf einen Netto-Betrag (identisch zur Rechnungs-Logik). */
function vat19(netCents: number): number {
  return Math.round((netCents * 1900) / 10000);
}

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abServiceId: number;
let superadminId: number;
let customerId: number;
let apptId: number;
let apptDate: string;
let serviceRecordId: number;
let originalInvoiceId: number;

const cleanupInvoiceIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
];

/** Reiner Selbstzahler-Kunde: keine Kassen-Töpfe, 100 % Privat (19 % USt). */
async function setupSelfPayerCustomer(): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ImportDriftSelfPayer",
    nachname: `Reconcile-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `import-drift-selfpayer-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "9",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000082",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "selbstzahler",
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

  return id;
}

/** Legt einen Alltagsbegleitung-Termin in einem freien Werktags-Slot an. */
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
        notes: `ImportDriftSelfPayer-${uniqueId()}`,
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
    services: [{ serviceId: abServiceId, actualDurationMinutes: APPT_MINUTES, details: "ImportDriftSelfPayer-Test" }],
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

interface InvoiceRow {
  id: number;
  netAmountCents?: number | null;
  vatAmountCents?: number | null;
  vatRate?: number | null;
  billingType?: string | null;
  budgetType?: string | null;
  status?: string;
  invoiceType?: string;
}

async function generate(year: number, month: number): Promise<InvoiceRow[]> {
  const gen = await apiPost<any>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const invoices: InvoiceRow[] = gen.data?.splitInvoices ? gen.data.invoices : [gen.data];
  for (const inv of invoices) if (inv?.id) cleanupInvoiceIds.push(inv.id);
  return invoices;
}

/** Summe der LIVE-Consumption im privaten Topf (Consumption minus reversierte). */
async function livePrivateConsumptionCents(): Promise<number> {
  const consumptions = await db.select({
    id: budgetTransactions.id,
    amountCents: budgetTransactions.amountCents,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, POT_PRIVATE),
    eq(budgetTransactions.transactionType, "consumption"),
  ));
  const reversals = await db.select({
    ref: budgetTransactions.reversedTransactionId,
  }).from(budgetTransactions).where(and(
    eq(budgetTransactions.customerId, customerId),
    eq(budgetTransactions.budgetType, POT_PRIVATE),
    eq(budgetTransactions.transactionType, "reversal"),
  ));
  const reversedIds = new Set(reversals.map((r) => r.ref).filter((x): x is number => x !== null));
  return consumptions
    .filter((c) => !reversedIds.has(c.id))
    .reduce((sum, c) => sum + Math.abs(c.amountCents), 0);
}

/** Aktive (nicht-stornierte, keine Stornorechnungen) Rechnungen des Kunden. */
async function activeInvoices(): Promise<InvoiceRow[]> {
  const list = await apiGet<InvoiceRow[]>(`/api/billing?customerId=${customerId}`);
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

  customerId = await setupSelfPayerCustomer();

  // Realer Abrechnungs-Fluss: anlegen → dokumentieren (bucht 100 % privat) → LN
  // signieren (= Siegel) → Rechnung erstellen (Selbstzahler, 19 % USt).
  const appt = await createAppt(year, month);
  apptId = appt.id;
  apptDate = appt.date;
  await documentAppt(apptId, appt.time);

  // Konsumtion muss 100 % im privaten Topf liegen (kein Kassen-Topf).
  expect(await livePrivateConsumptionCents(), "Dokumentation belegt den privaten Topf").toBe(APPT_COST_CENTS);

  serviceRecordId = await createAndSignSr(year, month);

  const invoices = await generate(year, month);
  expect(invoices.length, "Selbstzahler = EINE Rechnung (kein Split)").toBe(1);
  originalInvoiceId = invoices[0].id;
  expect(invoices[0].billingType, "Rechnung ist Selbstzahler").toBe("selbstzahler");
  expect(invoices[0].netAmountCents, "Netto == Termin-Kosten").toBe(APPT_COST_CENTS);
  expect(invoices[0].vatRate, "Selbstzahler-Rechnung trägt 19 % USt").toBe(1900);
  expect(invoices[0].vatAmountCents, "USt = 19 % vom Netto").toBe(vat19(APPT_COST_CENTS));

  // Drift-Injektion: eine zusätzliche private Consumption NACH dem Siegel.
  const postSeal = new Date(Date.now() + 60 * 60 * 1000); // +1h ⇒ garantiert nach dem Siegel
  await db.insert(budgetTransactions).values({
    customerId,
    budgetType: POT_PRIVATE,
    transactionDate: apptDate,
    transactionType: "consumption",
    amountCents: -APPT_COST_CENTS,
    alltagsbegleitungMinutes: APPT_MINUTES,
    alltagsbegleitungCents: APPT_COST_CENTS,
    appointmentId: apptId,
    notes: "Test: simulierter Nach-Siegel-Import-Rebook (Task #1663, Selbstzahler)",
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

objectStorageDescribe("Import-Drift-Reparatur (Selbstzahler / privater Topf, 19 % USt): Storno + Neuausstellung (Task #1663)", () => {
  it("Trockenlauf erkennt den Drift, schreibt aber NICHTS", async () => {
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

    const planItem = summary.plan.find((p) => p.appointmentId === apptId);
    expect(planItem, "Reparatur-Plan enthält den Termin").toBeDefined();
    expect(planItem!.sealedInvoiceIds).toContain(originalInvoiceId);
    expect(planItem!.signedServiceRecordIds).toContain(serviceRecordId);

    expect(summary.stornoedInvoiceIds).toHaveLength(0);
    expect(summary.reissuedInvoiceIds).toHaveLength(0);
    expect(summary.softStornoedServiceRecordIds).toHaveLength(0);
    expect(summary.batchId).toBeUndefined();

    const [inv] = await db.select({ status: invoicesTable.status })
      .from(invoicesTable).where(eq(invoicesTable.id, originalInvoiceId)).limit(1);
    expect(inv.status, "Rechnung bleibt im Trockenlauf aktiv").not.toBe("storniert");
  }, 180_000);

  it("scharfer Lauf: Selbstzahler-Rechnung storniert + neu ausgestellt (19 % USt), Σ Netto === Live-Privat, LN soft-storniert", async () => {
    const beforeLines = await db.select({
      id: invoiceLineItems.id,
      totalCents: invoiceLineItems.totalCents,
      durationMinutes: invoiceLineItems.durationMinutes,
      appointmentId: invoiceLineItems.appointmentId,
    }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, originalInvoiceId));
    expect(beforeLines.length, "Original-Rechnung hat Line-Items").toBeGreaterThan(0);

    const args: Args = {
      apply: true,
      customerIds: [],
      appointmentIds: [apptId],
      userId: superadminId,
      reason: "Integrationstest Import-Drift-Reparatur Selbstzahler #1663",
      importLinkedOnly: false,
    };
    const summary = await reconcile(args);

    // --- Garantie 1: versiegelte Rechnung nur storniert, NIE in-place editiert.
    expect(summary.stornoedInvoiceIds, "Original-Rechnung storniert").toContain(originalInvoiceId);
    const [orig] = await db.select({ status: invoicesTable.status })
      .from(invoicesTable).where(eq(invoicesTable.id, originalInvoiceId)).limit(1);
    expect(orig.status, "Original ist storniert").toBe("storniert");

    const stornos = await db.select({ id: invoicesTable.id, vatRate: invoicesTable.vatRate, netAmountCents: invoicesTable.netAmountCents })
      .from(invoicesTable).where(and(
        eq(invoicesTable.customerId, customerId),
        eq(invoicesTable.invoiceType, "stornorechnung"),
        eq(invoicesTable.stornierteRechnungId, originalInvoiceId),
      ));
    expect(stornos.length, "genau eine Stornorechnung zur Original").toBe(1);
    for (const s of stornos) cleanupInvoiceIds.push(s.id);

    const afterLines = await db.select({
      id: invoiceLineItems.id,
      totalCents: invoiceLineItems.totalCents,
      durationMinutes: invoiceLineItems.durationMinutes,
      appointmentId: invoiceLineItems.appointmentId,
    }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, originalInvoiceId));
    expect(afterLines, "Original-Line-Items unverändert").toEqual(beforeLines);

    // --- Garantie 2: neu ausgestellte Selbstzahler-Rechnung mit 19 % USt,
    //     Σ Netto === Live-Consumption im privaten Topf.
    expect(summary.reissuedInvoiceIds.length, "mindestens eine neue Rechnung ausgestellt").toBeGreaterThan(0);
    for (const rid of summary.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);

    const reissued = summary.reissuedInvoiceIds[0];
    const reissuedLines = await db.select({ appointmentId: invoiceLineItems.appointmentId })
      .from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, reissued));
    expect(reissuedLines.map((l) => l.appointmentId), "neue Rechnung deckt den Termin ab").toContain(apptId);

    const live = await livePrivateConsumptionCents();
    const active = await activeInvoices();
    expect(active.length, "genau eine aktive Rechnung (die neu ausgestellte)").toBe(1);
    const reissuedInv = active[0];
    expect(reissuedInv.billingType, "neue Rechnung bleibt Selbstzahler").toBe("selbstzahler");
    expect(reissuedInv.vatRate, "neue Rechnung trägt 19 % USt").toBe(1900);
    expect(reissuedInv.vatAmountCents, "USt = 19 % vom Netto").toBe(vat19(reissuedInv.netAmountCents ?? 0));

    const activeNet = active.reduce((sum, i) => sum + (i.netAmountCents ?? 0), 0);
    expect(activeNet, "Σ aktive Rechnungen (Netto) === Live-Privat-Ledger").toBe(live);
    expect(live, "re-abgerechneter Privat-Verbrauch == Termin-Kosten (Drift reversiert, nicht doppelt)").toBe(APPT_COST_CENTS);

    // --- Garantie 3: signierter LN soft-storniert + Audit, KEINE Neuerstellung.
    expect(summary.softStornoedServiceRecordIds, "LN soft-storniert").toContain(serviceRecordId);
    const [ln] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, serviceRecordId)).limit(1);
    expect(ln.deletedAt, "LN hat deleted_at").not.toBeNull();

    const deletionAudit = await db.select({ id: auditLog.id, metadata: auditLog.metadata })
      .from(auditLog).where(and(
        eq(auditLog.action, "service_record_deleted"),
        eq(auditLog.entityType, "service_record"),
        eq(auditLog.entityId, serviceRecordId),
      ));
    expect(deletionAudit.length, "service_record_deleted-Audit geschrieben").toBeGreaterThan(0);
    const meta = (deletionAudit[0].metadata ?? {}) as Record<string, unknown>;
    expect(meta.task, "Audit trägt Task-Attribution").toBe("#1651");
    expect(meta.batchId, "Audit trägt Reparatur-Batch").toBe(summary.batchId);

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
