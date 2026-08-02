/**
 * Task #1668 — Bulk-Reparatur storniert JEDE Topf-Geschwister-Rechnung eines
 * Kunden mit GEMISCHTEM Split (gedeckelter Kassen-Topf + privater
 * Selbstzahler-Rest).
 *
 * Die Schwester-Suite `reconcile-billed-import-drift-multipot.test.ts`
 * (Task #1665) belegt den Cascade-Storno + die Neuausstellung für einen Lauf aus
 * ZWEI GESETZLICHEN Töpfen (§45b + §45a, beide steuerfrei, alle Split-Rechnungen
 * Kasse). Die andere häufige Split-Form in Produktion ist ein GESETZLICHER Topf
 * PLUS ein privater/Selbstzahler-Rest — er wird als separate Rechnung mit
 * ABWEICHENDER USt-Behandlung abgerechnet (19 % statt steuerfrei; siehe
 * `generateInvoiceCore` Selbstzahler-Reklassifikation + USt-Verteilung). Für
 * diese GEMISCHTE Split-Form fehlte der Nachweis, dass der Cascade-Storn des
 * Reparatur-Skripts auch die private Geschwister-Rechnung vollständig entwertet
 * UND korrekt (weiterhin 19 % / Selbstzahler) neu ausstellt.
 *
 * Eine Cascade-Lücke ließe die LEBENDE private Rechnung auf einen bereits
 * frei-gebuchten Termin verweisen — ein GoBD-Korrektheitsbruch (der Termin wäre
 * über die tote Kassen- UND die lebende Selbstzahler-Rechnung doppelt
 * ausgewiesen, zusätzlich mit falscher USt).
 *
 * Feinheit, die dieser Test absichert (identisch zu Task #1665)
 * ------------------------------------------------------------
 * `resolveSealedInvoiceIds` findet für den driftenden Termin BEIDE Geschwister-
 * Rechnungen (beide tragen ein Line-Item mit derselben `appointmentId`). Die
 * Storno-Schleife verarbeitet die ERSTE via `stornoInvoiceCascade(cascadeRun:
 * true)` — dieser Aufruf storniert die Wurzel UND cascadet auf die Geschwister
 * desselben `billing_run_id`. Die zweite ID ist danach bereits `storniert` und
 * wird übersprungen. Folge: `summary.stornoedInvoiceIds` enthält NUR die Wurzel;
 * deshalb prüft dieser Test den DB-Status ALLER Geschwister.
 *
 * Aufbau (2 gemischte Split-Kunden, je ein langer §45a→privat-Cascade-Termin):
 *   M — Drift, IMPORT-verknüpft ⇒ MUSS repariert werden (beide Rechnungen storniert).
 *   H — gesund (keine Nach-Siegel-Buchung) ⇒ beide Rechnungen bleiben byte-genau aktiv.
 *
 * Object-Storage-Gate: Storno-PDF-Persistierung + Neu-Ausstellung schreiben echte
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
  importBatches,
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  users,
} from "@shared/schema";
import {
  reconcile,
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
} from "../test-utils";
import { billingReferenceDate, billingReferenceMonth } from "../helpers/billing-month";

const AB_HOURLY_CENTS = 4200; // Alltagsbegleitung, siehe scripts/seed-test-reference-data.ts

// §45a ist knapp gedeckelt, damit der lange Termin in den privaten Topf
// überläuft. §45b ist deaktiviert → die Kaskade beginnt bei §45a.
const POT_45A_CAP_CENTS = 5000;

const APPT_MINUTES = 90;
const APPT_COST_CENTS = (AB_HOURLY_CENTS * APPT_MINUTES) / 60; // 6300
const A_45A_CENTS = POT_45A_CAP_CENTS; // 5000 (§45a voll bis Cap)
const A_PRIVATE_CENTS = APPT_COST_CENTS - A_45A_CENTS; // 1300 (Rest → privat)

const POT_45A = "umwandlung_45a";
const POT_PRIVATE = "private";

function vat19(netCents: number): number {
  return Math.round((netCents * 1900) / 10000);
}

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abServiceId: number;
let superadminId: number;
let importBatchId: number;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Weit gespreizte Slots — 90-Minuten-Termine desselben Mitarbeiters dürfen
// sich nicht überlappen.
const SEED_TIMES = [
  "00:00", "02:00", "04:00", "06:00", "08:00", "10:00",
  "12:00", "14:00", "16:00", "18:00", "20:00", "22:00",
];

interface LineSnapshot {
  id: number;
  totalCents: number;
  durationMinutes: number | null;
  appointmentId: number | null;
}

interface SplitInvoiceSnapshot {
  id: number;
  budgetType: string | null;
  billingType: string | null;
  billingRunId: string | null;
  netAmountCents: number;
  vatRate: number | null;
  frozenLines: LineSnapshot[];
}

interface SeededCustomer {
  label: string;
  customerId: number;
  apptId: number;
  apptDate: string;
  serviceRecordId: number;
  invoices: SplitInvoiceSnapshot[];
  drift: boolean;
  importLinked: boolean;
}

const seeded: SeededCustomer[] = [];
const cleanupInvoiceIds: number[] = [];

/** Pflegekasse-Kunde MIT akzeptierter Privatzahlung
 *  (`acceptsPrivatePayment: true`): §45b deaktiviert, §45a (Prio 1) knapp
 *  gedeckelt, §39 aus. So läuft die Kaskade §45a → privat (uncapped Terminal)
 *  ⇒ GEMISCHTER Split (1×§45a-Kasse + 1×privat-Selbstzahler). */
async function setupPrivateOverflowCustomer(label: string, monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ImportDriftPrivateOverflow",
    nachname: `${label}-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `import-drift-private-${uniqueId()}@test.local`,
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
  expect(custRes.status, `create customer ${label}: ${JSON.stringify(custRes.data)}`).toBe(201);
  const id = custRes.data.id;

  const assignRes = await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign ${label}: ${JSON.stringify(assignRes.data)}`).toBe(200);

  const init45a = await apiPost(`/api/budget/${id}/initial-budget`, {
    budgetType: POT_45A,
    currentMonthAmountCents: POT_45A_CAP_CENTS,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45a ${label}: ${JSON.stringify(init45a.data)}`).toContain(init45a.status);

  const typesRes = await apiPut(`/api/budget/${id}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: POT_45A, enabled: true, priority: 1, monthlyLimitCents: POT_45A_CAP_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings ${label}: ${JSON.stringify(typesRes.data)}`).toBe(200);

  return id;
}

/** Legt einen langen Alltagsbegleitung-Termin in einem freien (vergangenen)
 *  Werktags-Slot an. */
async function createAppt(customerId: number, year: number, month: number): Promise<{ id: number; date: string; time: string }> {
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
        notes: `ImportDriftPrivateOverflow-${uniqueId()}`,
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
    services: [{ serviceId: abServiceId, actualDurationMinutes: APPT_MINUTES, details: "ImportDriftPrivateOverflow-Test" }],
  });
  if (res.status !== 200) throw new Error(`document failed: ${res.status} ${JSON.stringify(res.data)}`);
}

/** Erstellt + signiert (Mitarbeiter + Kunde) den monatlichen Leistungsnachweis. */
async function createAndSignSr(customerId: number, year: number, month: number): Promise<number> {
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

async function generate(customerId: number, year: number, month: number): Promise<any[]> {
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

async function freezeLines(invoiceId: number): Promise<LineSnapshot[]> {
  return db
    .select({
      id: invoiceLineItems.id,
      totalCents: invoiceLineItems.totalCents,
      durationMinutes: invoiceLineItems.durationMinutes,
      appointmentId: invoiceLineItems.appointmentId,
    })
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId));
}

/** Summe der LIVE-Consumption im Ledger für EINEN Topf (Consumption minus
 *  reversierte). */
async function liveConsumptionCents(customerId: number, budgetType: string): Promise<number> {
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

/** Aktive (nicht-stornierte, keine Stornorechnungen) Rechnungen des Kunden. */
async function activeInvoices(customerId: number): Promise<any[]> {
  const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
  const rows = Array.isArray(list.data) ? list.data : [];
  return rows.filter((i) => i.status !== "storniert" && i.invoiceType !== "stornorechnung");
}

/** Legt einen kompletten abgerechneten §45a→privat-Cascade-Termin an
 *  (Doku → LN-Signatur → GEMISCHTE Split-Rechnungen). */
async function seedCustomer(
  label: string,
  monthStartIso: string,
  year: number,
  month: number,
  opts: { drift: boolean; importLinked: boolean },
): Promise<SeededCustomer> {
  const customerId = await setupPrivateOverflowCustomer(label, monthStartIso);
  const appt = await createAppt(customerId, year, month);
  await documentAppt(appt.id, appt.time);

  // Cascade muss VOR der Abrechnung zwei echte Consumption-Zeilen erzeugt haben
  // (§45a bis Cap + privater Rest).
  expect(await liveConsumptionCents(customerId, POT_45A), `${label}: §45a bis Cap belegt`).toBe(A_45A_CENTS);
  expect(await liveConsumptionCents(customerId, POT_PRIVATE), `${label}: privater Überlauf`).toBe(A_PRIVATE_CENTS);

  const serviceRecordId = await createAndSignSr(customerId, year, month);
  const rawInvoices = await generate(customerId, year, month);
  expect(rawInvoices.length, `${label}: gemischter Lauf erzeugt 2 Split-Rechnungen`).toBe(2);
  const runIds = new Set(rawInvoices.map((i) => i.billingRunId));
  expect(runIds.size, `${label}: beide Split-Rechnungen teilen eine billingRunId`).toBe(1);
  expect([...runIds][0], `${label}: billingRunId gesetzt`).toBeTruthy();

  // Vorbedingung: der Split IST gemischt — eine Kasse-Rechnung (§45a, steuerfrei)
  // + eine Selbstzahler-Rechnung (privat, 19 % USt).
  const kasseInv = rawInvoices.find((i) => i.budgetType === POT_45A);
  const privateInv = rawInvoices.find((i) => i.billingType === "selbstzahler");
  expect(kasseInv, `${label}: §45a-Kasse-Rechnung vorhanden`).toBeDefined();
  expect(privateInv, `${label}: private Selbstzahler-Rechnung vorhanden`).toBeDefined();
  expect(kasseInv!.billingType, `${label}: §45a-Anteil bleibt Kasse`).toBe("pflegekasse_gesetzlich");
  expect(kasseInv!.netAmountCents, `${label}: §45a-Netto`).toBe(A_45A_CENTS);
  expect(privateInv!.netAmountCents, `${label}: Privat-Netto`).toBe(A_PRIVATE_CENTS);
  expect(privateInv!.vatRate, `${label}: Privat-Rechnung 19 % USt`).toBe(1900);
  expect(privateInv!.vatAmountCents, `${label}: Privat-USt = 19 % vom Netto`).toBe(vat19(A_PRIVATE_CENTS));

  const invoices: SplitInvoiceSnapshot[] = [];
  for (const inv of rawInvoices) {
    const frozenLines = await freezeLines(inv.id);
    expect(frozenLines.length, `${label}: Split-Rechnung ${inv.id} hat Line-Items`).toBeGreaterThan(0);
    invoices.push({
      id: inv.id,
      budgetType: inv.budgetType ?? null,
      billingType: inv.billingType ?? null,
      billingRunId: inv.billingRunId ?? null,
      netAmountCents: inv.netAmountCents ?? 0,
      vatRate: inv.vatRate ?? null,
      frozenLines,
    });
  }

  if (opts.drift) {
    // Drift-Injektion: eine zusätzliche §45a-Consumption NACH dem Siegel — so wie
    // ein früherer Vor-Guard-Excel-Import den bereits abgerechneten Termin still
    // neu verbucht hätte. `created_at` liegt sicher nach LN-Signatur/Rechnung.
    const postSeal = new Date(Date.now() + 60 * 60 * 1000); // +1h ⇒ garantiert nach dem Siegel
    await db.insert(budgetTransactions).values({
      customerId,
      budgetType: POT_45A,
      transactionDate: appt.date,
      transactionType: "consumption",
      amountCents: -A_45A_CENTS,
      alltagsbegleitungMinutes: APPT_MINUTES,
      alltagsbegleitungCents: A_45A_CENTS,
      appointmentId: appt.id,
      importBatchId: opts.importLinked ? importBatchId : null,
      notes: `Test: simulierter Nach-Siegel-Import-Rebook (${label}, Task #1668)`,
      createdAt: postSeal,
    });
  }

  const ctx: SeededCustomer = {
    label,
    customerId,
    apptId: appt.id,
    apptDate: appt.date,
    serviceRecordId,
    invoices,
    drift: opts.drift,
    importLinked: opts.importLinked,
  };
  seeded.push(ctx);
  return ctx;
}

function byLabel(label: string): SeededCustomer {
  const c = seeded.find((s) => s.label === label);
  if (!c) throw new Error(`Kunde ${label} nicht geseedet`);
  return c;
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

  const [batch] = await db
    .insert(importBatches)
    .values({ fileName: `import-drift-private-${uniqueId()}.xlsx`, fileHash: uniqueId(), createdByUserId: superadminId })
    .returning({ id: importBatches.id });
  importBatchId = batch.id;

  const { year, month } = billingReferenceMonth();
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

  // Seriell seeden — dieselbe Mitarbeiter-Zuweisung teilt sich die Slots.
  await seedCustomer("M", monthStart, year, month, { drift: true, importLinked: true });
  await seedCustomer("H", monthStart, year, month, { drift: false, importLinked: false });
  // N — Nach-Siegel-Drift, aber NICHT import-verknüpft (kein Import-Batch auf der
  // Buchung). Der Sicherheits-Gegenpol zu M: eine MANUELL abgerechnete Split-
  // Rechnung mit Drift darf von einem import-scoped Reparatur-Lauf
  // (importLinkedOnly: true) NICHT storniert werden.
  await seedCustomer("N", monthStart, year, month, { drift: true, importLinked: false });
}, 600_000);

afterAll(async () => {
  for (const id of cleanupInvoiceIds) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  for (const c of seeded) {
    try { await apiDelete(`/api/service-records/${c.serviceRecordId}`); } catch { /* best-effort */ }
    try { await apiDelete(`/api/appointments/${c.apptId}`); } catch { /* best-effort */ }
    await cleanupCustomer(c.customerId);
  }
});

/** Belegt, dass ALLE Split-Rechnungen + der signierte LN eines Kunden byte-genau
 *  unverändert aktiv sind (kein Over-Reach der Bulk-Reparatur). */
async function assertUntouched(c: SeededCustomer): Promise<void> {
  for (const inv of c.invoices) {
    const [row] = await db.select({ status: invoicesTable.status, invoiceType: invoicesTable.invoiceType })
      .from(invoicesTable).where(eq(invoicesTable.id, inv.id)).limit(1);
    expect(row.status, `${c.label}: Rechnung ${inv.id} bleibt aktiv`).not.toBe("storniert");
    expect(row.invoiceType, `${c.label}: Rechnung ${inv.id} keine Stornorechnung`).not.toBe("stornorechnung");

    const afterLines = await freezeLines(inv.id);
    expect(afterLines, `${c.label}: Line-Items der Rechnung ${inv.id} byte-unverändert`).toEqual(inv.frozenLines);
  }

  const stornos = await db.select({ id: invoicesTable.id })
    .from(invoicesTable).where(and(
      eq(invoicesTable.customerId, c.customerId),
      eq(invoicesTable.invoiceType, "stornorechnung"),
    ));
  expect(stornos.length, `${c.label}: keine Stornorechnung erzeugt`).toBe(0);

  const [ln] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
    .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, c.serviceRecordId)).limit(1);
  expect(ln.deletedAt, `${c.label}: LN ungelöscht`).toBeNull();
}

objectStorageDescribe("Import-Drift-Reparatur: Bulk storniert ALLE Topf-Geschwister (gemischter Kasse+Selbstzahler-Split, Task #1668)", () => {
  it("scharfer Bulk-Lauf: BEIDE Split-Rechnungen (§45a-Kasse + privat-Selbstzahler) des driftenden Kunden werden storniert & korrekt neu ausgestellt; gesunder Kunde bleibt byte-genau aktiv", async () => {
    const M = byLabel("M");
    const H = byLabel("H");

    // Vorbedingung: M hat genau zwei aktive Geschwister-Rechnungen (§45a + privat).
    expect(M.invoices.length, "M: genau 2 Split-Rechnungen geseedet").toBe(2);
    const mRunId = M.invoices[0].billingRunId;
    expect(M.invoices.every((i) => i.billingRunId === mRunId), "M: beide Geschwister teilen die billingRunId").toBe(true);
    expect(M.invoices.some((i) => i.billingType === "selbstzahler"), "M: eine private Selbstzahler-Rechnung vorhanden").toBe(true);
    expect(M.invoices.some((i) => i.budgetType === POT_45A), "M: eine §45a-Kasse-Rechnung vorhanden").toBe(true);

    // Allowlist umfasst BEIDE Termine; H (gesund) darf trotz Allowlist NICHT
    // repariert werden. importLinkedOnly verengt zusätzlich auf die nachweislich
    // import-verursachte Drift von M.
    const summary = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [M.apptId, H.apptId],
      userId: superadminId,
      reason: "Integrationstest Bulk-Import-Drift-Reparatur gemischter Split #1668",
      importLinkedOnly: true,
    });

    // --- Nur M wurde geflaggt/repariert.
    const flaggedIds = new Set(summary.flagged.map((r) => r.appointmentId));
    expect(flaggedIds.has(M.apptId), "M (Drift) erkannt").toBe(true);
    expect(flaggedIds.has(H.apptId), "H (gesund) NICHT erkannt").toBe(false);

    // Der Reparatur-Plan von M löst BEIDE Geschwister-Rechnungen auf.
    const mPlan = summary.plan.find((p) => p.appointmentId === M.apptId);
    expect(mPlan, "Plan enthält M's Termin").toBeDefined();
    expect(mPlan!.sealedInvoiceIds.sort(), "Plan verweist auf BEIDE Split-Rechnungen von M")
      .toEqual(M.invoices.map((i) => i.id).sort());

    // Summary-Array enthält bewusst NUR die als Wurzel stornierte Rechnung — die
    // Geschwister-Rechnung wird per Cascade (billing_run_id) mit-storniert.
    expect(summary.stornoedInvoiceIds.length, "Summary listet nur die Storno-Wurzel (1 von 2)").toBe(1);
    expect(M.invoices.map((i) => i.id), "die Wurzel ist eine der beiden M-Rechnungen")
      .toContain(summary.stornoedInvoiceIds[0]);

    // --- KERN-GARANTIE: JEDE Geschwister-Rechnung von M ist `storniert` — auch
    //     die private Selbstzahler-Rechnung. Original-Line-Items byte-unverändert.
    let originalGrossSum = 0;
    for (const inv of M.invoices) {
      const [row] = await db
        .select({ status: invoicesTable.status, gross: invoicesTable.grossAmountCents, billingType: invoicesTable.billingType })
        .from(invoicesTable).where(eq(invoicesTable.id, inv.id)).limit(1);
      expect(row.status, `M: Split-Rechnung ${inv.id} (${inv.budgetType ?? inv.billingType}) ist storniert`).toBe("storniert");
      originalGrossSum += row.gross;

      const afterLines = await freezeLines(inv.id);
      expect(afterLines, `M: Line-Items der Rechnung ${inv.id} unverändert`).toEqual(inv.frozenLines);
    }

    // Der Cascade-Storno legt pro Original GENAU eine negierte Stornorechnung an
    // (Haupt-Storno + Geschwister-Storno = 2). Beide verweisen per Konvention auf
    // die Storno-WURZEL (`stornierteRechnungId = rootInvoiceId`, vgl.
    // server/services/invoice-storno.ts) — deshalb wird über die Wurzel gezählt.
    const rootInvoiceId = summary.stornoedInvoiceIds[0];
    const mStornos = await db
      .select({ id: invoicesTable.id, gross: invoicesTable.grossAmountCents })
      .from(invoicesTable).where(and(
        eq(invoicesTable.invoiceType, "stornorechnung"),
        eq(invoicesTable.stornierteRechnungId, rootInvoiceId),
      ));
    expect(mStornos.length, "M: genau 2 Stornorechnungen (§45a-Kasse + privat)").toBe(2);
    for (const s of mStornos) cleanupInvoiceIds.push(s.id);

    // Die Summe der negierten Storno-Beträge deckt BEIDE Rechnungen vollständig
    // ab (inkl. der 19-%-USt der privaten Rechnung) — der Cascade entwertet nicht
    // nur die direkt getroffene, sondern jede Geschwister-Rechnung des Laufs.
    const stornoGrossSum = mStornos.reduce((sum, s) => sum + s.gross, 0);
    expect(stornoGrossSum, "M: Storno-Summe negiert Kasse- UND Privat-Brutto").toBe(-originalGrossSum);

    // Keine der beiden Original-Rechnungen bleibt aktiv (positiver Gegen-Check).
    const mActiveOriginalIds = (await activeInvoices(M.customerId)).map((i) => i.id);
    for (const inv of M.invoices) {
      expect(mActiveOriginalIds, `M: Original ${inv.id} nicht mehr aktiv`).not.toContain(inv.id);
    }

    // --- LN von M soft-storniert, KEIN Auto-Reset, Termin zur Neu-Doku frei.
    const [ln] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, M.serviceRecordId)).limit(1);
    expect(ln.deletedAt, "M: LN soft-storniert").not.toBeNull();
    expect(summary.lnReDocRequiredAppointmentIds, "M: Termin zur Neu-Doku freigegeben").toContain(M.apptId);
    const liveLns = await db.select({ id: monthlyServiceRecords.id })
      .from(monthlyServiceRecords).where(and(
        eq(monthlyServiceRecords.customerId, M.customerId),
        isNull(monthlyServiceRecords.deletedAt),
      ));
    expect(liveLns.length, "M: kein Auto-Reset des LN (Task #576)").toBe(0);

    // --- Neuausstellung: Monat frisch abgerechnet, pro Topf Rechnung == Ledger.
    for (const rid of summary.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);
    expect(summary.reissuedInvoiceIds.length, "M: Neuausstellung liefert 2 Split-Rechnungen").toBeGreaterThanOrEqual(2);

    const live45a = await liveConsumptionCents(M.customerId, POT_45A);
    const livePrivate = await liveConsumptionCents(M.customerId, POT_PRIVATE);
    expect(live45a, "M: §45a nach Re-Book == Cap-Anteil").toBe(A_45A_CENTS);
    expect(livePrivate, "M: privat nach Re-Book == Überlauf-Anteil").toBe(A_PRIVATE_CENTS);

    const active = await activeInvoices(M.customerId);
    expect(active.length, "M: genau 2 aktive (neu ausgestellte) Rechnungen").toBe(2);

    // Value conservation PRO TOPF: die §45a-Kasse-Rechnung trägt
    // billingType=Kasse; der private Anteil ist die Selbstzahler-Rechnung.
    const active45a = active.filter((i) => i.billingType !== "selbstzahler");
    const activePrivate = active.filter((i) => i.billingType === "selbstzahler");
    const activeNet45a = active45a.reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    const activeNetPrivate = activePrivate.reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    expect(activeNet45a, "M: Σ aktive §45a-Rechnungen === Live-Ledger").toBe(live45a);
    expect(activeNetPrivate, "M: Σ aktive Privat-Rechnungen === Live-Ledger").toBe(livePrivate);

    // Die neu ausgestellte private Rechnung bleibt korrekt Selbstzahler / 19 % USt.
    expect(activePrivate.length, "M: genau eine neue Privat-Rechnung").toBe(1);
    for (const i of activePrivate) {
      expect(i.vatRate, `M: neue Privat-Rechnung ${i.id} trägt 19 % USt`).toBe(1900);
      expect(i.vatAmountCents, `M: neue Privat-Rechnung ${i.id} USt = 19 % vom Netto`).toBe(vat19(i.netAmountCents ?? 0));
    }

    // --- H (gesund) bleibt in BEIDEN Rechnungen byte-genau unangetastet.
    await assertUntouched(H);
  }, 300_000);

  it("importLinkedOnly:true überspringt NICHT-import-verknüpfte Drift (manueller Split bleibt unangetastet); importLinkedOnly:false repariert sie dann vollständig (Task #1673)", async () => {
    const N = byLabel("N");

    // Vorbedingung: N hat einen echten Nach-Siegel-Drift (zusätzliche
    // §45a-Consumption), aber OHNE Import-Batch/Audit → `importLinked === false`.
    expect(N.invoices.length, "N: genau 2 Split-Rechnungen geseedet").toBe(2);
    expect(N.drift, "N: Drift injiziert").toBe(true);
    expect(N.importLinked, "N: Drift NICHT import-verknüpft").toBe(false);
    expect(N.invoices.some((i) => i.billingType === "selbstzahler"), "N: private Selbstzahler-Rechnung vorhanden").toBe(true);
    expect(N.invoices.some((i) => i.budgetType === POT_45A), "N: §45a-Kasse-Rechnung vorhanden").toBe(true);

    // --- SCHRITT 1: import-scoped Lauf (importLinkedOnly: true) MUSS N überspringen.
    const skipSummary = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [N.apptId],
      userId: superadminId,
      reason: "Integrationstest: import-scoped Lauf darf manuellen Split nicht anfassen #1673",
      importLinkedOnly: true,
    });

    // Der Drift wird zwar erkannt, aber durch den Import-Attributions-Filter
    // herausgefiltert → weder geflaggt noch im Plan noch storniert.
    const skipFlagged = new Set(skipSummary.flagged.map((r) => r.appointmentId));
    expect(skipFlagged.has(N.apptId), "N: bei importLinkedOnly:true NICHT geflaggt").toBe(false);
    expect(skipSummary.plan.some((p) => p.appointmentId === N.apptId), "N: nicht im Reparatur-Plan").toBe(false);
    expect(skipSummary.stornoedInvoiceIds.length, "N: keine Rechnung storniert").toBe(0);
    expect(skipSummary.reissuedInvoiceIds.length, "N: keine Rechnung neu ausgestellt").toBe(0);
    expect(skipSummary.softStornoedServiceRecordIds.length, "N: kein LN soft-storniert").toBe(0);

    // KERN-GARANTIE: BEIDE Split-Rechnungen + LN von N sind byte-genau unverändert
    // aktiv, es existiert keine Stornorechnung.
    await assertUntouched(N);

    // --- SCHRITT 2: voller Lauf (importLinkedOnly: false) repariert N doch.
    const repairSummary = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [N.apptId],
      userId: superadminId,
      reason: "Integrationstest: voller Lauf repariert auch manuellen Split #1673",
      importLinkedOnly: false,
    });

    const repFlagged = new Set(repairSummary.flagged.map((r) => r.appointmentId));
    expect(repFlagged.has(N.apptId), "N: bei importLinkedOnly:false erkannt").toBe(true);

    const nPlan = repairSummary.plan.find((p) => p.appointmentId === N.apptId);
    expect(nPlan, "N: im Reparatur-Plan").toBeDefined();
    expect(nPlan!.sealedInvoiceIds.sort(), "N: Plan verweist auf BEIDE Split-Rechnungen")
      .toEqual(N.invoices.map((i) => i.id).sort());

    // Beide Original-Rechnungen (§45a-Kasse + privat-Selbstzahler) sind jetzt
    // storniert; Original-Line-Items byte-unverändert.
    let originalGrossSum = 0;
    for (const inv of N.invoices) {
      const [row] = await db
        .select({ status: invoicesTable.status, gross: invoicesTable.grossAmountCents })
        .from(invoicesTable).where(eq(invoicesTable.id, inv.id)).limit(1);
      expect(row.status, `N: Split-Rechnung ${inv.id} (${inv.budgetType ?? inv.billingType}) ist storniert`).toBe("storniert");
      originalGrossSum += row.gross;
      const afterLines = await freezeLines(inv.id);
      expect(afterLines, `N: Line-Items der Rechnung ${inv.id} unverändert`).toEqual(inv.frozenLines);
    }

    // Cascade-Storno: pro Original genau eine negierte Stornorechnung (2 gesamt),
    // beide auf die Storno-WURZEL verweisend. Σ negiert das gesamte Brutto.
    const rootInvoiceId = repairSummary.stornoedInvoiceIds[0];
    expect(N.invoices.map((i) => i.id), "N: Storno-Wurzel ist eine der beiden Rechnungen")
      .toContain(rootInvoiceId);
    const nStornos = await db
      .select({ id: invoicesTable.id, gross: invoicesTable.grossAmountCents })
      .from(invoicesTable).where(and(
        eq(invoicesTable.invoiceType, "stornorechnung"),
        eq(invoicesTable.stornierteRechnungId, rootInvoiceId),
      ));
    expect(nStornos.length, "N: genau 2 Stornorechnungen (§45a-Kasse + privat)").toBe(2);
    for (const s of nStornos) cleanupInvoiceIds.push(s.id);
    const stornoGrossSum = nStornos.reduce((sum, s) => sum + s.gross, 0);
    expect(stornoGrossSum, "N: Storno-Summe negiert Kasse- UND Privat-Brutto").toBe(-originalGrossSum);

    // Keine der beiden Original-Rechnungen bleibt aktiv.
    const nActiveOriginalIds = (await activeInvoices(N.customerId)).map((i) => i.id);
    for (const inv of N.invoices) {
      expect(nActiveOriginalIds, `N: Original ${inv.id} nicht mehr aktiv`).not.toContain(inv.id);
    }

    // LN soft-storniert, Termin zur Neu-Doku freigegeben.
    const [nLn] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
      .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, N.serviceRecordId)).limit(1);
    expect(nLn.deletedAt, "N: LN soft-storniert").not.toBeNull();
    expect(repairSummary.lnReDocRequiredAppointmentIds, "N: Termin zur Neu-Doku freigegeben").toContain(N.apptId);

    // Neuausstellung: Monat frisch abgerechnet, Value-Conservation pro Topf.
    for (const rid of repairSummary.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);
    expect(repairSummary.reissuedInvoiceIds.length, "N: Neuausstellung liefert 2 Split-Rechnungen").toBeGreaterThanOrEqual(2);

    const live45a = await liveConsumptionCents(N.customerId, POT_45A);
    const livePrivate = await liveConsumptionCents(N.customerId, POT_PRIVATE);
    expect(live45a, "N: §45a nach Re-Book == Cap-Anteil").toBe(A_45A_CENTS);
    expect(livePrivate, "N: privat nach Re-Book == Überlauf-Anteil").toBe(A_PRIVATE_CENTS);

    const active = await activeInvoices(N.customerId);
    expect(active.length, "N: genau 2 aktive (neu ausgestellte) Rechnungen").toBe(2);
    const activeNet45a = active.filter((i) => i.billingType !== "selbstzahler").reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    const activeNetPrivate = active.filter((i) => i.billingType === "selbstzahler").reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    expect(activeNet45a, "N: Σ aktive §45a-Rechnungen === Live-Ledger").toBe(live45a);
    expect(activeNetPrivate, "N: Σ aktive Privat-Rechnungen === Live-Ledger").toBe(livePrivate);
  }, 300_000);
});
