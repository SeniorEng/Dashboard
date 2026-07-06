/**
 * Task #1653 — Integrationstest für das GoBD-Reparatur-Skript
 * `server/scripts/reconcile-billed-appointment-import-drift.ts` (Task #1651).
 *
 * Der Test treibt den scharfen `--apply`-Pfad DIREKT über die exportierte
 * `reconcile()`-Funktion (umgeht bewusst die CLI-Guards `assertProdDatabase()`
 * / `assertSuperadminOrThrow()`, die nur in `main()` liegen). Er belegt end-to-
 * end die vier GoBD-Kern-Garantien der Reparatur:
 *
 *   1. Versiegelte Rechnungen werden NIE in-place editiert — die Original-
 *      rechnung wird nur auf `storniert` gesetzt und eine negierte
 *      Stornorechnung angelegt (append-only); ihre Line-Items bleiben unberührt.
 *   2. Der betroffene Monat wird neu ausgestellt und die frische Rechnung deckt
 *      sich mit dem Ledger (Σ aktive Rechnungen === Σ Live-§45b-Consumption).
 *   3. Der signierte Leistungsnachweis wird soft-storniert (`deleted_at` gesetzt
 *      + `service_record_deleted`-Audit) — OHNE automatische Neuerstellung.
 *   4. Der Termin wird zur manuellen Neu-Dokumentation ausgewiesen
 *      (`lnReDocRequiredAppointmentIds`).
 *
 * Drift-Auslöser: Nach dem Versiegeln (LN-Signatur) wird — wie ein früherer
 * Vor-Guard-Excel-Import — eine zusätzliche §45b-Consumption-Buchung mit
 * `created_at` NACH dem Siegel eingefügt. Das feuert Signal A
 * (`consumptionRebookedAfterSeal`) der Erkennungs-SSoT, ohne die Termin-
 * Stammdaten zu verändern (⇒ genau EIN sauberer Re-Book beim Neu-Ausstellen).
 *
 * Object-Storage-Gate: Storno-PDF-Persistierung + Neu-Ausstellung schreiben
 * echte PDF-Objekte → die Suite skippt sauber ohne Object-Storage-Sidecar
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
let superadminId: number;
let customerId: number;
let apptId: number;
let apptDate: string;
let originalInvoiceId: number;
let serviceRecordId: number;

const cleanupInvoiceIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
];

/** Kassen-Kunde (PG3, KEIN Privatzahler) mit EINEM limitierten §45b-Topf. */
async function setupSinglePotCustomer(monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ImportDrift",
    nachname: `Reconcile-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `import-drift-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "3",
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

/** Legt einen Alltagsbegleitung-Termin in einem freien (vergangenen) Werktags-Slot an. */
async function createAppt(year: number, month: number): Promise<{ id: number; date: string; time: string }> {
  const today = new Date();
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
        notes: `ImportDrift-${uniqueId()}`,
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
    services: [{ serviceId: abServiceId, actualDurationMinutes: APPT_MINUTES, details: "ImportDrift-Test" }],
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

/** Aktive (nicht-stornierte, keine Stornorechnungen) Rechnungen des Kunden. */
async function activeInvoices(): Promise<any[]> {
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

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

  customerId = await setupSinglePotCustomer(monthStart);

  // Realer Abrechnungs-Fluss: anlegen → dokumentieren (bucht §45b) → LN
  // signieren (= Siegel) → Rechnung erstellen (= versiegeltes Artefakt).
  const appt = await createAppt(year, month);
  apptId = appt.id;
  apptDate = appt.date;
  await documentAppt(apptId, appt.time);
  serviceRecordId = await createAndSignSr(year, month);
  const invoices = await generate(year, month);
  expect(invoices.length, "erste Abrechnung erzeugt genau 1 Rechnung").toBe(1);
  originalInvoiceId = invoices[0].id;
  expect(await liveConsumption45bCents(), "Dokumentation belegt §45b live").toBe(APPT_COST_CENTS);

  // Drift-Injektion: eine zusätzliche §45b-Consumption NACH dem Siegel — so wie
  // ein früherer Vor-Guard-Excel-Import den bereits abgerechneten Termin still
  // neu verbucht hätte. `created_at` liegt sicher nach der LN-Signatur/Rechnung.
  const postSeal = new Date(Date.now() + 60 * 60 * 1000); // +1h ⇒ garantiert nach dem Siegel
  await db.insert(budgetTransactions).values({
    customerId,
    budgetType: "entlastungsbetrag_45b",
    transactionDate: apptDate,
    transactionType: "consumption",
    amountCents: -APPT_COST_CENTS,
    alltagsbegleitungMinutes: APPT_MINUTES,
    alltagsbegleitungCents: APPT_COST_CENTS,
    appointmentId: apptId,
    notes: "Test: simulierter Nach-Siegel-Import-Rebook (Task #1653)",
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

objectStorageDescribe("Import-Drift-Reparatur: Storno + Neuausstellung (Task #1653)", () => {
  it("Trockenlauf erkennt den Drift, schreibt aber NICHTS", async () => {
    const args: Args = {
      apply: false,
      customerIds: [],
      appointmentIds: [apptId],
      importLinkedOnly: false,
    };
    const summary = await reconcile(args);

    // Erkennung feuert (Signal A: Consumption nach Siegel rebucht).
    const flagged = summary.flagged.find((r) => r.appointmentId === apptId);
    expect(flagged, "Termin muss als Drift erkannt werden").toBeDefined();
    expect(flagged!.consumptionRebookedAfterSeal, "Signal A muss feuern").toBe(true);

    // Plan ist aufgelöst (Rechnung + signierter LN).
    const planItem = summary.plan.find((p) => p.appointmentId === apptId);
    expect(planItem, "Reparatur-Plan enthält den Termin").toBeDefined();
    expect(planItem!.sealedInvoiceIds).toContain(originalInvoiceId);
    expect(planItem!.signedServiceRecordIds).toContain(serviceRecordId);

    // KEINE Schreib-Effekte im Trockenlauf.
    expect(summary.stornoedInvoiceIds).toHaveLength(0);
    expect(summary.reissuedInvoiceIds).toHaveLength(0);
    expect(summary.softStornoedServiceRecordIds).toHaveLength(0);
    expect(summary.batchId, "kein Batch im Trockenlauf").toBeUndefined();

    // Original-Rechnung + LN unverändert.
    const [inv] = await db.select({ status: invoicesTable.status })
      .from(invoicesTable).where(eq(invoicesTable.id, originalInvoiceId)).limit(1);
    expect(inv.status, "Rechnung bleibt im Trockenlauf aktiv").not.toBe("storniert");
    const [ln] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, serviceRecordId)).limit(1);
    expect(ln.deletedAt, "LN bleibt im Trockenlauf ungelöscht").toBeNull();
  }, 180_000);

  it("scharfer Lauf: Storno + Neuausstellung, LN soft-storniert, Termin zur Neu-Doku freigegeben", async () => {
    // Eingefrorene Original-Line-Items VOR der Reparatur festhalten.
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
      reason: "Integrationstest Import-Drift-Reparatur #1653",
      importLinkedOnly: false,
    };
    const summary = await reconcile(args);

    // --- Garantie 1: versiegelte Rechnung nur storniert, NIE in-place editiert.
    expect(summary.stornoedInvoiceIds, "Original-Rechnung storniert").toContain(originalInvoiceId);
    const [orig] = await db.select({ status: invoicesTable.status, invoiceType: invoicesTable.invoiceType })
      .from(invoicesTable).where(eq(invoicesTable.id, originalInvoiceId)).limit(1);
    expect(orig.status, "Original ist storniert").toBe("storniert");

    // Eine negierte Stornorechnung existiert.
    const stornos = await db.select({ id: invoicesTable.id, netAmountCents: invoicesTable.netAmountCents })
      .from(invoicesTable).where(and(
        eq(invoicesTable.customerId, customerId),
        eq(invoicesTable.invoiceType, "stornorechnung"),
        eq(invoicesTable.stornierteRechnungId, originalInvoiceId),
      ));
    expect(stornos.length, "genau eine Stornorechnung zur Original").toBe(1);
    for (const s of stornos) cleanupInvoiceIds.push(s.id);

    // Line-Items der Original-Rechnung sind byte-gleich unverändert (append-only).
    const afterLines = await db.select({
      id: invoiceLineItems.id,
      totalCents: invoiceLineItems.totalCents,
      durationMinutes: invoiceLineItems.durationMinutes,
      appointmentId: invoiceLineItems.appointmentId,
    }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, originalInvoiceId));
    expect(afterLines, "Original-Line-Items unverändert").toEqual(beforeLines);

    // --- Garantie 2: Monat neu ausgestellt, Rechnung deckt sich mit Ledger.
    expect(summary.reissuedInvoiceIds.length, "mindestens eine neue Rechnung ausgestellt").toBeGreaterThan(0);
    const reissued = summary.reissuedInvoiceIds[0];
    // Die frische Rechnung deckt den frei gewordenen Termin ab.
    const reissuedLines = await db.select({ appointmentId: invoiceLineItems.appointmentId })
      .from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, reissued));
    expect(reissuedLines.map((l) => l.appointmentId), "neue Rechnung deckt den Termin ab").toContain(apptId);
    for (const rid of summary.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);

    // Σ aktive Rechnungen === Σ Live-§45b-Consumption (Rechnung == Ledger).
    const live = await liveConsumption45bCents();
    const active = await activeInvoices();
    const activeNet = active.reduce((sum, i) => sum + (i.netAmountCents ?? 0), 0);
    expect(active.length, "genau eine aktive Rechnung (die neu ausgestellte)").toBe(1);
    expect(activeNet, "Σ aktive Rechnungen === Live-Ledger").toBe(live);
    expect(live, "re-abgerechneter §45b-Verbrauch == Termin-Kosten").toBe(APPT_COST_CENTS);

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

    // KEINE neue (nicht-gelöschte) LN für Kunde/Monat automatisch erzeugt.
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
