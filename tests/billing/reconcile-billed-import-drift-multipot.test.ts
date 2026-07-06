/**
 * Task #1665 — Bulk-Reparatur storniert JEDE Topf-Geschwister-Rechnung eines
 * Kunden mit gesplitteten Budgets (Mehr-Topf).
 *
 * Der Bulk-/Scoping-Test (Task #1658, reconcile-billed-import-drift-bulk.test.ts)
 * seedet Kunden mit GENAU EINEM §45b-Topf — jeder driftende Termin bildet
 * dort auf GENAU EINE Rechnung ab. In der Produktion erzeugt ein Mehr-Topf-
 * Kunde (§45b + §45a, ggf. + privat/Selbstzahler) pro Abrechnungslauf MEHRERE
 * Rechnungen (Invoice-per-Pot-Split, verbunden über `invoices.billing_run_id`;
 * siehe `shared/domain/budget-invoice-split.ts`).
 *
 * Der Storno-Pfad des Reparatur-Skripts (`stornoInvoiceCascade`,
 * `cascadeRun: true`) soll ALLE Topf-Geschwister eines Laufs mit-stornieren.
 * Bislang war das für einen Mehr-Topf-Kunden im BULK-Lauf UNBELEGT. Eine
 * Cascade-Lücke hinterließe eine noch LEBENDE Geschwister-Rechnung, die auf
 * einen bereits frei-gebuchten Termin verweist — ein GoBD-Korrektheitsbruch
 * (der Termin würde über die tote Original- UND die lebende Geschwister-
 * Rechnung doppelt ausgewiesen).
 *
 * Feinheit, die dieser Test absichert
 * -----------------------------------
 * `resolveSealedInvoiceIds` findet für den driftenden Termin BEIDE Geschwister-
 * Rechnungen (beide tragen ein Line-Item mit derselben `appointmentId`). Die
 * Storno-Schleife des Skripts verarbeitet die ERSTE via
 * `stornoInvoiceCascade(cascadeRun: true)` — dieser Aufruf storniert die Wurzel
 * UND cascadet auf die Geschwister desselben `billing_run_id`. Die zweite ID
 * ist danach bereits `storniert` und wird in der Schleife übersprungen. Folge:
 * `summary.stornoedInvoiceIds` enthält NUR die Wurzel; die Geschwister-Rechnung
 * wurde per Cascade erledigt. Deshalb prüft dieser Test den DB-Status ALLER
 * Geschwister (nicht nur das Summary-Array).
 *
 * Aufbau (2 Mehr-Topf-Kunden, je ein langer §45b→§45a-Cascade-Termin):
 *   M — Drift, IMPORT-verknüpft ⇒ MUSS repariert werden (beide Töpfe storniert).
 *   H — gesund (keine Nach-Siegel-Buchung) ⇒ beide Töpfe bleiben byte-genau aktiv.
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

const AB_HOURLY_CENTS = 4200; // Alltagsbegleitung, siehe scripts/seed-test-reference-data.ts

// §45b ist knapp limitiert, damit der lange Termin in §45a überläuft ⇒ 2 Töpfe.
const POT_45B_CAP_CENTS = 5000;
const POT_45A_CAP_CENTS = 59880;

const APPT_MINUTES = 90;
const APPT_COST_CENTS = (AB_HOURLY_CENTS * APPT_MINUTES) / 60; // 6300
const A_45B_CENTS = POT_45B_CAP_CENTS; // 5000 (§45b voll)
const A_45A_CENTS = APPT_COST_CENTS - A_45B_CENTS; // 1300 (Rest → §45a)

const POT_45B = "entlastungsbetrag_45b";
const POT_45A = "umwandlung_45a";

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
  billingRunId: string | null;
  netAmountCents: number;
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

/** Reiner Kassen-Kunde (PG3, KEIN Privatzahler) mit ZWEI Töpfen: §45b (Prio 1,
 *  knapp limitiert) + §45a (Prio 2, großzügig). §39 aus ⇒ echte §45b→§45a-
 *  Cascade ohne Privat-Anteil. */
async function setupMultiPotCustomer(label: string, monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ImportDriftMultiPot",
    nachname: `${label}-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `import-drift-multipot-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "7",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000078",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer ${label}: ${JSON.stringify(custRes.data)}`).toBe(201);
  const id = custRes.data.id;

  const assignRes = await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign ${label}: ${JSON.stringify(assignRes.data)}`).toBe(200);

  const init45b = await apiPost(`/api/budget/${id}/initial-budget`, {
    budgetType: POT_45B,
    currentMonthAmountCents: POT_45B_CAP_CENTS,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45b ${label}: ${JSON.stringify(init45b.data)}`).toContain(init45b.status);

  const init45a = await apiPost(`/api/budget/${id}/initial-budget`, {
    budgetType: POT_45A,
    currentMonthAmountCents: POT_45A_CAP_CENTS,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45a ${label}: ${JSON.stringify(init45a.data)}`).toContain(init45a.status);

  const typesRes = await apiPut(`/api/budget/${id}/type-settings`, {
    settings: [
      { budgetType: POT_45B, enabled: true, priority: 1, monthlyLimitCents: POT_45B_CAP_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: POT_45A, enabled: true, priority: 2, monthlyLimitCents: POT_45A_CAP_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings ${label}: ${JSON.stringify(typesRes.data)}`).toBe(200);

  return id;
}

/** Legt einen langen Alltagsbegleitung-Termin in einem freien (vergangenen)
 *  Werktags-Slot an. */
async function createAppt(customerId: number, year: number, month: number): Promise<{ id: number; date: string; time: string }> {
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

/** Legt einen kompletten abgerechneten §45b→§45a-Cascade-Termin an
 *  (Doku → LN-Signatur → Split-Rechnungen). */
async function seedCustomer(
  label: string,
  monthStartIso: string,
  year: number,
  month: number,
  opts: { drift: boolean; importLinked: boolean },
): Promise<SeededCustomer> {
  const customerId = await setupMultiPotCustomer(label, monthStartIso);
  const appt = await createAppt(customerId, year, month);
  await documentAppt(appt.id, appt.time);

  // Cascade muss VOR der Abrechnung zwei echte Consumption-Zeilen erzeugt haben.
  expect(await liveConsumptionCents(customerId, POT_45B), `${label}: §45b voll belegt`).toBe(A_45B_CENTS);
  expect(await liveConsumptionCents(customerId, POT_45A), `${label}: §45a-Überlauf`).toBe(A_45A_CENTS);

  const serviceRecordId = await createAndSignSr(customerId, year, month);
  const rawInvoices = await generate(customerId, year, month);
  expect(rawInvoices.length, `${label}: Mehr-Topf-Lauf erzeugt 2 Split-Rechnungen`).toBe(2);
  const runIds = new Set(rawInvoices.map((i) => i.billingRunId));
  expect(runIds.size, `${label}: beide Split-Rechnungen teilen eine billingRunId`).toBe(1);
  expect([...runIds][0], `${label}: billingRunId gesetzt`).toBeTruthy();

  const invoices: SplitInvoiceSnapshot[] = [];
  for (const inv of rawInvoices) {
    const frozenLines = await freezeLines(inv.id);
    expect(frozenLines.length, `${label}: Split-Rechnung ${inv.id} hat Line-Items`).toBeGreaterThan(0);
    invoices.push({
      id: inv.id,
      budgetType: inv.budgetType ?? null,
      billingRunId: inv.billingRunId ?? null,
      netAmountCents: inv.netAmountCents ?? 0,
      frozenLines,
    });
  }

  if (opts.drift) {
    // Drift-Injektion: eine zusätzliche §45b-Consumption NACH dem Siegel — so wie
    // ein früherer Vor-Guard-Excel-Import den bereits abgerechneten Termin still
    // neu verbucht hätte. `created_at` liegt sicher nach LN-Signatur/Rechnung.
    const postSeal = new Date(Date.now() + 60 * 60 * 1000); // +1h ⇒ garantiert nach dem Siegel
    await db.insert(budgetTransactions).values({
      customerId,
      budgetType: POT_45B,
      transactionDate: appt.date,
      transactionType: "consumption",
      amountCents: -A_45B_CENTS,
      alltagsbegleitungMinutes: APPT_MINUTES,
      alltagsbegleitungCents: A_45B_CENTS,
      appointmentId: appt.id,
      importBatchId: opts.importLinked ? importBatchId : null,
      notes: `Test: simulierter Nach-Siegel-Import-Rebook (${label}, Task #1665)`,
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
    .values({ fileName: `import-drift-multipot-${uniqueId()}.xlsx`, fileHash: uniqueId(), createdByUserId: superadminId })
    .returning({ id: importBatches.id });
  importBatchId = batch.id;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

  // Seriell seeden — dieselbe Mitarbeiter-Zuweisung teilt sich die Slots.
  await seedCustomer("M", monthStart, year, month, { drift: true, importLinked: true });
  await seedCustomer("H", monthStart, year, month, { drift: false, importLinked: false });
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

objectStorageDescribe("Import-Drift-Reparatur: Bulk storniert ALLE Topf-Geschwister (Split-Budget, Task #1665)", () => {
  it("scharfer Bulk-Lauf: BEIDE Split-Rechnungen des driftenden Mehr-Topf-Kunden werden storniert; gesunder Mehr-Topf-Kunde bleibt byte-genau aktiv", async () => {
    const M = byLabel("M");
    const H = byLabel("H");

    // Vorbedingung: M hat genau zwei aktive Geschwister-Rechnungen (§45b + §45a).
    expect(M.invoices.length, "M: genau 2 Split-Rechnungen geseedet").toBe(2);
    const mRunId = M.invoices[0].billingRunId;
    expect(M.invoices.every((i) => i.billingRunId === mRunId), "M: beide Geschwister teilen die billingRunId").toBe(true);

    // Allowlist umfasst BEIDE Termine; H (gesund) darf trotz Allowlist NICHT
    // repariert werden (kein Drift ⇒ nicht geflaggt). importLinkedOnly verengt
    // zusätzlich auf die nachweislich import-verursachte Drift von M.
    const summary = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [M.apptId, H.apptId],
      userId: superadminId,
      reason: "Integrationstest Bulk-Import-Drift-Reparatur Split-Budget #1665",
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

    // Das Summary-Array enthält bewusst NUR die als Wurzel stornierte Rechnung —
    // die Geschwister-Rechnung wird per Cascade (billing_run_id) mit-storniert
    // und beim zweiten Schleifendurchlauf als bereits `storniert` übersprungen.
    expect(summary.stornoedInvoiceIds.length, "Summary listet nur die Storno-Wurzel (1 von 2)").toBe(1);
    expect(M.invoices.map((i) => i.id), "die Wurzel ist eine der beiden M-Rechnungen")
      .toContain(summary.stornoedInvoiceIds[0]);

    // --- KERN-GARANTIE: JEDE Geschwister-Rechnung von M ist `storniert`, keine
    //     bleibt lebend auf den frei-gebuchten Termin verweisend. Die
    //     Original-Line-Items bleiben byte-unverändert (append-only).
    let originalGrossSum = 0;
    for (const inv of M.invoices) {
      const [row] = await db
        .select({ status: invoicesTable.status, gross: invoicesTable.grossAmountCents })
        .from(invoicesTable).where(eq(invoicesTable.id, inv.id)).limit(1);
      expect(row.status, `M: Split-Rechnung ${inv.id} (${inv.budgetType}) ist storniert`).toBe("storniert");
      originalGrossSum += row.gross;

      const afterLines = await freezeLines(inv.id);
      expect(afterLines, `M: Line-Items der Rechnung ${inv.id} unverändert`).toEqual(inv.frozenLines);
    }

    // Der Cascade-Storno legt pro Original GENAU eine negierte Stornorechnung an
    // (Haupt-Storno + Geschwister-Storno = 2). Beide verweisen per Konvention auf
    // die Storno-WURZEL (`stornierteRechnungId = rootInvoiceId`, vgl.
    // server/services/invoice-storno.ts) — NICHT auf das jeweils eigene Original.
    // Deshalb wird über die Wurzel gezählt, nicht pro Einzel-Rechnung.
    const rootInvoiceId = summary.stornoedInvoiceIds[0];
    const mStornos = await db
      .select({ id: invoicesTable.id, gross: invoicesTable.grossAmountCents })
      .from(invoicesTable).where(and(
        eq(invoicesTable.invoiceType, "stornorechnung"),
        eq(invoicesTable.stornierteRechnungId, rootInvoiceId),
      ));
    expect(mStornos.length, "M: genau 2 Stornorechnungen (eine je Topf-Original)").toBe(2);
    for (const s of mStornos) cleanupInvoiceIds.push(s.id);

    // Die Summe der negierten Storno-Beträge deckt BEIDE Töpfe vollständig ab —
    // der Cascade entwertet nicht nur die direkt getroffene, sondern jede
    // Geschwister-Rechnung des Laufs.
    const stornoGrossSum = mStornos.reduce((sum, s) => sum + s.gross, 0);
    expect(stornoGrossSum, "M: Storno-Summe negiert beide Original-Töpfe").toBe(-originalGrossSum);

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

    const live45b = await liveConsumptionCents(M.customerId, POT_45B);
    const live45a = await liveConsumptionCents(M.customerId, POT_45A);
    expect(live45b, "M: §45b nach Re-Book == Termin-Anteil").toBe(A_45B_CENTS);
    expect(live45a, "M: §45a nach Re-Book == Überlauf-Anteil").toBe(A_45A_CENTS);

    const active = await activeInvoices(M.customerId);
    expect(active.length, "M: genau 2 aktive (neu ausgestellte) Rechnungen").toBe(2);
    const activeNet45b = active.filter((i) => i.budgetType === POT_45B).reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    const activeNet45a = active.filter((i) => i.budgetType !== POT_45B).reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    expect(activeNet45b, "M: Σ aktive §45b-Rechnungen === Live-Ledger").toBe(live45b);
    expect(activeNet45a, "M: Σ aktive §45a-Rechnungen === Live-Ledger").toBe(live45a);

    // --- H (gesund) bleibt in BEIDEN Töpfen byte-genau unangetastet.
    await assertUntouched(H);
  }, 300_000);
});
