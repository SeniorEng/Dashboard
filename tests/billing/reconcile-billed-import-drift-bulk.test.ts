/**
 * Task #1658 — Bulk-/Scoping-Absicherung für das GoBD-Reparatur-Skript
 * `server/scripts/reconcile-billed-appointment-import-drift.ts` (Task #1651).
 *
 * Der Einzel-Termin-Test (Task #1653, reconcile-billed-import-drift.test.ts)
 * belegt die vier GoBD-Kern-Garantien für GENAU EINEN gezielt adressierten
 * Termin (`appointmentIds: [apptId]`). Ungeprüft blieben bisher die beiden
 * Wege, auf denen das Werkzeug in echten Produktions-Vorfällen tatsächlich
 * aufgerufen wird:
 *
 *   1. Mehr-Kunden-Scoping (`customerIds`) im Trockenlauf — findet die Drift
 *      NUR über die adressierten Kunden und lässt out-of-scope Kunden in Ruhe.
 *   2. Der `importLinkedOnly`-Filter — verengt die Treffer auf nachweislich
 *      import-verursachte Drift und lässt eine zwar driftende, aber NICHT
 *      import-verknüpfte Buchung unangetastet.
 *
 * Ein Scoping-Bug hätte zwei Gesichter: entweder eine driftende Rechnung
 * ÜBERSEHEN (korrupte Rechnung bleibt aktiv) oder eine GESUNDE Rechnung
 * fälschlich stornieren (Over-Reach). Dieser Test schließt beide aus, indem er
 * mehrere Kunden mit gemischtem Zustand aufsetzt und exakt prüft, welche
 * Rechnungen/LN repariert bzw. byte-genau unangetastet bleiben.
 *
 * Aufbau (4 Kunden, je genau EINE abgerechnete §45b-Leistung):
 *   A — Drift, IMPORT-verknüpft (Nach-Siegel-Consumption mit import_batch_id).
 *   B — Drift, IMPORT-verknüpft (2. Kunde ⇒ belegt Mehr-Kunden-Bulk-Reparatur).
 *   C — Drift, NICHT import-verknüpft (Nach-Siegel-Consumption ohne Batch).
 *   D — gesund (keine Nach-Siegel-Buchung, kein Line-Drift).
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
} from "../test-utils";
import { billingReferenceDate, billingReferenceMonth } from "../helpers/billing-month";

const AB_HOURLY_CENTS = 4200; // Alltagsbegleitung, siehe scripts/seed-test-reference-data.ts
const POT_CAPACITY_CENTS = 13100; // §45b gesetzliches Monats-Maximum
const APPT_MINUTES = 30;
const APPT_COST_CENTS = (AB_HOURLY_CENTS * APPT_MINUTES) / 60; // 2100

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abServiceId: number;
let superadminId: number;
let importBatchId: number;

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "06:00", "06:30", "07:00", "07:30", "08:00", "08:30",
];

interface LineSnapshot {
  id: number;
  totalCents: number;
  durationMinutes: number | null;
  appointmentId: number | null;
}

interface SeededCustomer {
  label: string;
  customerId: number;
  apptId: number;
  apptDate: string;
  serviceRecordId: number;
  invoiceId: number;
  frozenLines: LineSnapshot[];
  drift: boolean;
  importLinked: boolean;
}

const seeded: SeededCustomer[] = [];
const cleanupInvoiceIds: number[] = [];

/** Kassen-Kunde (PG3, KEIN Privatzahler) mit EINEM limitierten §45b-Topf. */
async function setupSinglePotCustomer(label: string, monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ImportDriftBulk",
    nachname: `${label}-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `import-drift-bulk-${uniqueId()}@test.local`,
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
  expect(custRes.status, `create customer ${label}: ${JSON.stringify(custRes.data)}`).toBe(201);
  const id = custRes.data.id;

  const assignRes = await apiPatch(`/api/admin/customers/${id}/assign`, {
    primaryEmployeeId: auth.user.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign ${label}: ${JSON.stringify(assignRes.data)}`).toBe(200);

  const init45b = await apiPost(`/api/budget/${id}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: POT_CAPACITY_CENTS,
    carryoverAmountCents: 0,
    budgetStartDate: monthStartIso,
  });
  expect([200, 201], `init §45b ${label}: ${JSON.stringify(init45b.data)}`).toContain(init45b.status);

  const typesRes = await apiPut(`/api/budget/${id}/type-settings`, {
    settings: [
      { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: POT_CAPACITY_CENTS, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
    ],
  });
  expect(typesRes.status, `type-settings ${label}: ${JSON.stringify(typesRes.data)}`).toBe(200);

  return id;
}

/** Legt einen Alltagsbegleitung-Termin in einem freien (vergangenen) Werktags-Slot an. */
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
        notes: `ImportDriftBulk-${uniqueId()}`,
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
    services: [{ serviceId: abServiceId, actualDurationMinutes: APPT_MINUTES, details: "ImportDriftBulk-Test" }],
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

/** Summe der LIVE §45b-Consumption im Ledger (Consumption minus reversierte). */
async function liveConsumption45bCents(customerId: number): Promise<number> {
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
async function activeInvoices(customerId: number): Promise<any[]> {
  const list = await apiGet<any[]>(`/api/billing?customerId=${customerId}`);
  const rows = Array.isArray(list.data) ? list.data : [];
  return rows.filter((i) => i.status !== "storniert" && i.invoiceType !== "stornorechnung");
}

/** Legt einen kompletten abgerechneten §45b-Termin an (Doku → LN-Signatur → Rechnung). */
async function seedCustomer(
  label: string,
  monthStartIso: string,
  year: number,
  month: number,
  opts: { drift: boolean; importLinked: boolean },
): Promise<SeededCustomer> {
  const customerId = await setupSinglePotCustomer(label, monthStartIso);
  const appt = await createAppt(customerId, year, month);
  await documentAppt(appt.id, appt.time);
  const serviceRecordId = await createAndSignSr(customerId, year, month);
  const invoices = await generate(customerId, year, month);
  expect(invoices.length, `${label}: erste Abrechnung erzeugt genau 1 Rechnung`).toBe(1);
  const invoiceId = invoices[0].id;
  expect(await liveConsumption45bCents(customerId), `${label}: Dokumentation belegt §45b live`).toBe(APPT_COST_CENTS);
  const frozenLines = await freezeLines(invoiceId);
  expect(frozenLines.length, `${label}: Original-Rechnung hat Line-Items`).toBeGreaterThan(0);

  if (opts.drift) {
    // Drift-Injektion: eine zusätzliche §45b-Consumption NACH dem Siegel — so wie
    // ein früherer Vor-Guard-Excel-Import den bereits abgerechneten Termin still
    // neu verbucht hätte. `created_at` liegt sicher nach LN-Signatur/Rechnung.
    // Nur import-verknüpfte Drift trägt eine `import_batch_id` (Signal für die
    // Import-Attribution der Erkennungs-SSoT).
    const postSeal = new Date(Date.now() + 60 * 60 * 1000); // +1h ⇒ garantiert nach dem Siegel
    await db.insert(budgetTransactions).values({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      transactionDate: appt.date,
      transactionType: "consumption",
      amountCents: -APPT_COST_CENTS,
      alltagsbegleitungMinutes: APPT_MINUTES,
      alltagsbegleitungCents: APPT_COST_CENTS,
      appointmentId: appt.id,
      importBatchId: opts.importLinked ? importBatchId : null,
      notes: `Test: simulierter Nach-Siegel-Import-Rebook (${label}, Task #1658)`,
      createdAt: postSeal,
    });
  }

  const ctx: SeededCustomer = {
    label,
    customerId,
    apptId: appt.id,
    apptDate: appt.date,
    serviceRecordId,
    invoiceId,
    frozenLines,
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

  // Realer Import-Batch als Beleg für die Import-Attribution.
  const [batch] = await db
    .insert(importBatches)
    .values({ fileName: `import-drift-bulk-${uniqueId()}.xlsx`, fileHash: uniqueId(), createdByUserId: superadminId })
    .returning({ id: importBatches.id });
  importBatchId = batch.id;

  const { year, month } = billingReferenceMonth();
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

  // Seriell seeden — dieselbe Mitarbeiter-Zuweisung teilt sich die Slots.
  await seedCustomer("A", monthStart, year, month, { drift: true, importLinked: true });
  await seedCustomer("B", monthStart, year, month, { drift: true, importLinked: true });
  await seedCustomer("C", monthStart, year, month, { drift: true, importLinked: false });
  await seedCustomer("D", monthStart, year, month, { drift: false, importLinked: false });
}, 600_000);

afterAll(async () => {
  for (const id of cleanupInvoiceIds) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  for (const c of seeded) {
    try { await apiDelete(`/api/service-records/${c.serviceRecordId}`); } catch { /* best-effort */ }
    try { await apiDelete(`/api/appointments/${c.apptId}`); } catch { /* best-effort */ }
    await cleanupCustomer(c.customerId);
  }
});

/** Belegt, dass die Rechnung + der signierte LN eines Kunden byte-genau unverändert aktiv sind. */
async function assertUntouched(c: SeededCustomer): Promise<void> {
  const [inv] = await db.select({ status: invoicesTable.status, invoiceType: invoicesTable.invoiceType })
    .from(invoicesTable).where(eq(invoicesTable.id, c.invoiceId)).limit(1);
  expect(inv.status, `${c.label}: Rechnung bleibt aktiv`).not.toBe("storniert");
  expect(inv.invoiceType, `${c.label}: keine Stornorechnung`).not.toBe("stornorechnung");

  const stornos = await db.select({ id: invoicesTable.id })
    .from(invoicesTable).where(and(
      eq(invoicesTable.customerId, c.customerId),
      eq(invoicesTable.invoiceType, "stornorechnung"),
    ));
  expect(stornos.length, `${c.label}: keine Stornorechnung erzeugt`).toBe(0);

  const afterLines = await freezeLines(c.invoiceId);
  expect(afterLines, `${c.label}: Line-Items byte-unverändert`).toEqual(c.frozenLines);

  const [ln] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
    .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, c.serviceRecordId)).limit(1);
  expect(ln.deletedAt, `${c.label}: LN ungelöscht`).toBeNull();
}

objectStorageDescribe("Import-Drift-Reparatur: Bulk-/Scoping-Sicherheit (Task #1658)", () => {
  it("Trockenlauf mit customerIds-Scope: findet NUR die Drift der adressierten Kunden", async () => {
    const A = byLabel("A");
    const B = byLabel("B");
    const C = byLabel("C");
    const D = byLabel("D");

    // Scope auf A (Drift) + D (gesund) — B und C liegen bewusst AUSSERHALB.
    const summary = await reconcile({
      apply: false,
      customerIds: [A.customerId, D.customerId],
      appointmentIds: [],
      importLinkedOnly: false,
    });

    const flaggedIds = new Set(summary.flagged.map((r) => r.appointmentId));
    expect(flaggedIds.has(A.apptId), "A (Drift, im Scope) erkannt").toBe(true);
    expect(flaggedIds.has(D.apptId), "D (gesund, im Scope) NICHT erkannt").toBe(false);
    expect(flaggedIds.has(B.apptId), "B (out-of-scope) NICHT erkannt").toBe(false);
    expect(flaggedIds.has(C.apptId), "C (out-of-scope) NICHT erkannt").toBe(false);

    // Kein Schreib-Effekt im Trockenlauf.
    expect(summary.stornoedInvoiceIds).toHaveLength(0);
    expect(summary.reissuedInvoiceIds).toHaveLength(0);
    expect(summary.softStornoedServiceRecordIds).toHaveLength(0);
    expect(summary.batchId).toBeUndefined();
  }, 180_000);

  it("Trockenlauf mit importLinkedOnly: verengt auf nachweislich import-verursachte Drift", async () => {
    const A = byLabel("A");
    const B = byLabel("B");
    const C = byLabel("C");

    // Ohne Filter: alle drei driftenden Kunden werden erkannt.
    const all = await reconcile({
      apply: false,
      customerIds: [A.customerId, B.customerId, C.customerId],
      appointmentIds: [],
      importLinkedOnly: false,
    });
    const allIds = new Set(all.flagged.map((r) => r.appointmentId));
    expect(allIds.has(A.apptId), "A ohne Filter erkannt").toBe(true);
    expect(allIds.has(B.apptId), "B ohne Filter erkannt").toBe(true);
    expect(allIds.has(C.apptId), "C ohne Filter erkannt").toBe(true);

    // Mit Filter: NUR die import-verknüpften A + B; C (kein Batch) fällt raus.
    const linked = await reconcile({
      apply: false,
      customerIds: [A.customerId, B.customerId, C.customerId],
      appointmentIds: [],
      importLinkedOnly: true,
    });
    const linkedIds = new Set(linked.flagged.map((r) => r.appointmentId));
    expect(linkedIds.has(A.apptId), "A (import-verknüpft) bleibt").toBe(true);
    expect(linkedIds.has(B.apptId), "B (import-verknüpft) bleibt").toBe(true);
    expect(linkedIds.has(C.apptId), "C (nicht import-verknüpft) gefiltert").toBe(false);

    // Import-Beleg trägt die Batch-ID der Injektion.
    const aRow = linked.flagged.find((r) => r.appointmentId === A.apptId)!;
    expect(aRow.importLinked, "A ist als import-verknüpft markiert").toBe(true);
    expect(aRow.importEvidence, "A trägt Batch-Beleg").toContain(String(importBatchId));
  }, 180_000);

  it("scharfer Bulk-Lauf: repariert exakt die import-verknüpfte Drift, lässt gesunde & gefilterte byte-genau in Ruhe", async () => {
    const A = byLabel("A");
    const B = byLabel("B");
    const C = byLabel("C");
    const D = byLabel("D");

    // Allowlist umfasst ALLE vier Termine; der Filter (importLinkedOnly) muss
    // C (Drift ohne Import-Beleg) UND D (gesund) trotz Allowlist ausschließen.
    const summary = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [A.apptId, B.apptId, C.apptId, D.apptId],
      userId: superadminId,
      reason: "Integrationstest Bulk-Import-Drift-Reparatur #1658",
      importLinkedOnly: true,
    });

    // --- Nur A + B wurden repariert (Mehr-Kunden-Bulk-Storno + Neuausstellung).
    expect(summary.stornoedInvoiceIds.sort(), "genau A+B storniert")
      .toEqual([A.invoiceId, B.invoiceId].sort());
    expect(summary.softStornoedServiceRecordIds.sort(), "genau A+B LN soft-storniert")
      .toEqual([A.serviceRecordId, B.serviceRecordId].sort());
    expect(summary.lnReDocRequiredAppointmentIds.sort(), "A+B zur Neu-Doku freigegeben")
      .toEqual([A.apptId, B.apptId].sort());
    expect(summary.reissuedInvoiceIds.length, "mindestens zwei neue Rechnungen (A+B)").toBeGreaterThanOrEqual(2);
    for (const rid of summary.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);

    // --- Garantien für die REPARIERTEN Kunden (A, B).
    for (const c of [A, B]) {
      const [orig] = await db.select({ status: invoicesTable.status })
        .from(invoicesTable).where(eq(invoicesTable.id, c.invoiceId)).limit(1);
      expect(orig.status, `${c.label}: Original storniert`).toBe("storniert");

      // Negierte Stornorechnung existiert, Original-Line-Items byte-unverändert.
      const stornos = await db.select({ id: invoicesTable.id })
        .from(invoicesTable).where(and(
          eq(invoicesTable.invoiceType, "stornorechnung"),
          eq(invoicesTable.stornierteRechnungId, c.invoiceId),
        ));
      expect(stornos.length, `${c.label}: genau eine Stornorechnung`).toBe(1);
      for (const s of stornos) cleanupInvoiceIds.push(s.id);

      const afterLines = await freezeLines(c.invoiceId);
      expect(afterLines, `${c.label}: Original-Line-Items unverändert (append-only)`).toEqual(c.frozenLines);

      // LN soft-storniert, KEIN Auto-Reset.
      const [ln] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
        .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, c.serviceRecordId)).limit(1);
      expect(ln.deletedAt, `${c.label}: LN soft-storniert`).not.toBeNull();
      const liveLns = await db.select({ id: monthlyServiceRecords.id })
        .from(monthlyServiceRecords).where(and(
          eq(monthlyServiceRecords.customerId, c.customerId),
          isNull(monthlyServiceRecords.deletedAt),
        ));
      expect(liveLns.length, `${c.label}: kein Auto-Reset des LN (Task #576)`).toBe(0);

      // Rechnung == Ledger nach der Neuausstellung.
      const live = await liveConsumption45bCents(c.customerId);
      const active = await activeInvoices(c.customerId);
      const activeNet = active.reduce((sum, i) => sum + (i.netAmountCents ?? 0), 0);
      expect(active.length, `${c.label}: genau eine aktive (neu ausgestellte) Rechnung`).toBe(1);
      expect(activeNet, `${c.label}: Σ aktive Rechnungen === Live-Ledger`).toBe(live);
      expect(live, `${c.label}: re-abgerechneter §45b-Verbrauch == Termin-Kosten`).toBe(APPT_COST_CENTS);
    }

    // --- C (Drift, gefiltert) UND D (gesund) bleiben byte-genau unangetastet.
    await assertUntouched(C);
    await assertUntouched(D);
  }, 300_000);
});
