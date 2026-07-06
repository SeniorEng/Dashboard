/**
 * Task #1666 — Idempotenz / Wiederanlauf-Sicherheit des GoBD-Reparatur-Skripts
 * `server/scripts/reconcile-billed-appointment-import-drift.ts`.
 *
 * In echten Produktions-Vorfällen wird die Reparatur MANUELL über viele Kunden
 * auf einmal gefahren (`reconcile({ apply: true, appointmentIds: [...] })`).
 * Bricht ein scharfer Lauf mittendrin ab (Kunde A repariert, beim nächsten
 * Kunden crasht ein PDF-/Pool-Timeout — ein dokumentiertes Risiko), wird ein
 * Operator den Lauf natürlich WIEDERHOLEN. Ein Wiederanlauf über einen Termin,
 * dessen Rechnung BEREITS storniert + neu ausgestellt ist, MUSS ein sicherer
 * No-Op sein: er darf die frisch neu ausgestellte Rechnung NICHT erneut
 * stornieren und den Ledger NICHT doppelt reversieren.
 *
 * Der bestehende Bulk-Test (Task #1658) injiziert seine Drift mit
 * `createdAt = Date.now() + 1h`. Das liegt zwar nach dem ORIGINAL-Siegel
 * (nötig, damit der ERSTE Lauf greift), aber künstlich auch nach dem NEUEN
 * Siegel (der neu ausgestellten Rechnung) — für einen Idempotenz-Nachweis
 * unrealistisch. In der Realität liegt die Drift zwischen altem und neuem
 * Siegel. Dieser Test stempelt die Drift daher realistisch (kurz NACH dem
 * Original-Rechnungs-Siegel, aber VOR der Reparatur), sodass der Wiederanlauf
 * exakt das Produktions-Timing nachbildet.
 *
 * Aufbau (2 Kunden, je genau EINE abgerechnete §45b-Leistung, beide mit
 * import-verknüpfter Nach-Siegel-Drift):
 *   X — wird im ERSTEN (partiellen) Lauf repariert.
 *   Y — bleibt im ersten Lauf ABSICHTLICH ausgelassen (Abbruch-Szenario:
 *        A fertig, B noch offen) und wird erst im Wiederanlauf repariert.
 *
 * Der Wiederanlauf adressiert BEIDE Termine (so, wie ein Operator den vollen
 * Fall-Liste erneut startet): X (schon fertig) muss ein No-Op bleiben, Y (noch
 * offen) wird nun repariert. Ein dritter Lauf über beide belegt vollständige
 * Idempotenz (nichts mehr zu tun).
 *
 * Object-Storage-Gate: Storno-PDF-Persistierung + Neuausstellung schreiben
 * echte PDF-Objekte → die Suite skippt sauber ohne Object-Storage-Sidecar
 * (GitHub-Actions-CI-Muster, vgl. tests/helpers/object-storage.ts).
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { describe as objectStorageDescribe } from "../helpers/object-storage";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  budgetTransactions,
  importBatches,
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  users,
} from "@shared/schema";
import { reconcile } from "../../server/scripts/reconcile-billed-appointment-import-drift";
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
}

const seeded: SeededCustomer[] = [];
const cleanupInvoiceIds: number[] = [];

/** Kassen-Kunde (PG3, KEIN Privatzahler) mit EINEM limitierten §45b-Topf. */
async function setupSinglePotCustomer(label: string, monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ImportDriftIdem",
    nachname: `${label}-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `import-drift-idem-${uniqueId()}@test.local`,
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
        notes: `ImportDriftIdem-${uniqueId()}`,
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
    services: [{ serviceId: abServiceId, actualDurationMinutes: APPT_MINUTES, details: "ImportDriftIdem-Test" }],
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

/** createdAt einer Rechnung — dient als „Siegel"-Zeit-Referenz für die Drift-Injektion. */
async function invoiceCreatedAt(invoiceId: number): Promise<Date> {
  const [row] = await db
    .select({ createdAt: invoicesTable.createdAt })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  if (!row?.createdAt) throw new Error(`invoiceCreatedAt: Rechnung #${invoiceId} ohne createdAt`);
  return new Date(row.createdAt as unknown as string);
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

/** Anzahl Stornorechnungen des Kunden. */
async function stornorechnungCount(customerId: number): Promise<number> {
  const rows = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.customerId, customerId),
      eq(invoicesTable.invoiceType, "stornorechnung"),
    ));
  return rows.length;
}

/**
 * Legt einen kompletten abgerechneten §45b-Termin an (Doku → LN-Signatur →
 * Rechnung) und injiziert eine REALISTISCH getimte Nach-Siegel-Import-Drift:
 * `createdAt` liegt kurz NACH dem Original-Rechnungs-Siegel (⇒ der erste Lauf
 * erkennt sie), aber VOR der Reparatur (⇒ nach der Neuausstellung liegt sie vor
 * dem neuen Siegel und darf NICHT erneut anschlagen).
 */
async function seedCustomer(
  label: string,
  monthStartIso: string,
  year: number,
  month: number,
): Promise<SeededCustomer> {
  const customerId = await setupSinglePotCustomer(label, monthStartIso);
  const appt = await createAppt(customerId, year, month);
  await documentAppt(appt.id, appt.time);
  const serviceRecordId = await createAndSignSr(customerId, year, month);
  const invoices = await generate(customerId, year, month);
  expect(invoices.length, `${label}: erste Abrechnung erzeugt genau 1 Rechnung`).toBe(1);
  const invoiceId = invoices[0].id;
  expect(await liveConsumption45bCents(customerId), `${label}: Dokumentation belegt §45b live`).toBe(APPT_COST_CENTS);

  // Drift-Injektion: eine zusätzliche §45b-Consumption kurz NACH dem Siegel —
  // so wie ein früherer Vor-Guard-Excel-Import den bereits abgerechneten Termin
  // still neu verbucht hätte. Der Zeitstempel wird REALISTISCH gewählt: 1 s nach
  // der Original-Rechnung (dem Siegel), aber garantiert vor der Reparatur, die
  // erst nach weiteren HTTP-Round-Trips läuft. So bildet der spätere
  // Wiederanlauf-Test das echte Produktions-Timing ab (Drift zwischen altem und
  // neuem Siegel), statt die Drift künstlich hinter das neue Siegel zu legen.
  const sealAt = await invoiceCreatedAt(invoiceId);
  const postSeal = new Date(sealAt.getTime() + 1000);
  await db.insert(budgetTransactions).values({
    customerId,
    budgetType: "entlastungsbetrag_45b",
    transactionDate: appt.date,
    transactionType: "consumption",
    amountCents: -APPT_COST_CENTS,
    alltagsbegleitungMinutes: APPT_MINUTES,
    alltagsbegleitungCents: APPT_COST_CENTS,
    appointmentId: appt.id,
    importBatchId,
    notes: `Test: simulierter Nach-Siegel-Import-Rebook (${label}, Task #1666)`,
    createdAt: postSeal,
  });

  const ctx: SeededCustomer = {
    label,
    customerId,
    apptId: appt.id,
    apptDate: appt.date,
    serviceRecordId,
    invoiceId,
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
    .values({ fileName: `import-drift-idem-${uniqueId()}.xlsx`, fileHash: uniqueId(), createdByUserId: superadminId })
    .returning({ id: importBatches.id });
  importBatchId = batch.id;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

  // Seriell seeden — dieselbe Mitarbeiter-Zuweisung teilt sich die Slots.
  await seedCustomer("X", monthStart, year, month);
  await seedCustomer("Y", monthStart, year, month);
}, 600_000);

afterAll(async () => {
  for (const id of cleanupInvoiceIds) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  for (const c of seeded) {
    try { await apiDelete(`/api/service-records/${c.serviceRecordId}`); } catch { /* best-effort */ }
    try { await apiDelete(`/api/appointments/${c.apptId}`); } catch { /* best-effort */ }
    await cleanupCustomer(c.customerId);
  }
});

/** Belegt, dass ein Kunde SAUBER repariert ist: genau 1 aktive Rechnung == Ledger, genau 1 Stornorechnung. */
async function assertRepaired(c: SeededCustomer): Promise<{ activeInvoiceId: number }> {
  const [orig] = await db.select({ status: invoicesTable.status })
    .from(invoicesTable).where(eq(invoicesTable.id, c.invoiceId)).limit(1);
  expect(orig.status, `${c.label}: Original storniert`).toBe("storniert");

  expect(await stornorechnungCount(c.customerId), `${c.label}: genau eine Stornorechnung`).toBe(1);

  const [ln] = await db.select({ deletedAt: monthlyServiceRecords.deletedAt })
    .from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, c.serviceRecordId)).limit(1);
  expect(ln.deletedAt, `${c.label}: LN soft-storniert`).not.toBeNull();

  const active = await activeInvoices(c.customerId);
  expect(active.length, `${c.label}: genau eine aktive (neu ausgestellte) Rechnung`).toBe(1);
  const live = await liveConsumption45bCents(c.customerId);
  const activeNet = active.reduce((sum, i) => sum + (i.netAmountCents ?? 0), 0);
  expect(activeNet, `${c.label}: Σ aktive Rechnungen === Live-Ledger`).toBe(live);
  expect(live, `${c.label}: re-abgerechneter §45b-Verbrauch == Termin-Kosten`).toBe(APPT_COST_CENTS);
  return { activeInvoiceId: active[0].id };
}

objectStorageDescribe("Import-Drift-Reparatur: Wiederanlauf-Idempotenz (Task #1666)", () => {
  it("Wiederanlauf nach Abbruch: repariert nur den offenen Kunden, doppelt-storniert den fertigen nicht", async () => {
    const X = byLabel("X");
    const Y = byLabel("Y");

    // --- Lauf 1 (PARTIELL): nur X — simuliert einen Abbruch, bevor Y dran war.
    const run1 = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [X.apptId],
      userId: superadminId,
      reason: "Integrationstest Idempotenz Lauf 1 (nur X) #1666",
      importLinkedOnly: true,
    });
    for (const rid of run1.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);

    expect(run1.stornoedInvoiceIds, "Lauf 1: nur X storniert").toEqual([X.invoiceId]);
    const xAfter1 = await assertRepaired(X);
    for (const s of await db.select({ id: invoicesTable.id }).from(invoicesTable)
      .where(and(eq(invoicesTable.customerId, X.customerId), eq(invoicesTable.invoiceType, "stornorechnung")))) {
      if (!cleanupInvoiceIds.includes(s.id)) cleanupInvoiceIds.push(s.id);
    }

    // Y ist bewusst UNANGETASTET (Original aktiv, Drift steht noch offen).
    const [yOrig] = await db.select({ status: invoicesTable.status })
      .from(invoicesTable).where(eq(invoicesTable.id, Y.invoiceId)).limit(1);
    expect(yOrig.status, "Y (out-of-scope) bleibt aktiv").not.toBe("storniert");
    expect(await stornorechnungCount(Y.customerId), "Y: noch keine Stornorechnung").toBe(0);

    // Snapshot des reparierten X VOR dem Wiederanlauf.
    const xReissuedId = xAfter1.activeInvoiceId;
    const xReissuedLinesBefore = await freezeLines(xReissuedId);
    const xLedgerBefore = await liveConsumption45bCents(X.customerId);

    // --- Lauf 2 (WIEDERANLAUF über die VOLLE Liste): X (schon fertig) + Y (offen).
    //     Ein Operator startet nach dem Abbruch die komplette Fall-Liste erneut.
    const run2 = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [X.apptId, Y.apptId],
      userId: superadminId,
      reason: "Integrationstest Idempotenz Wiederanlauf (X+Y) #1666",
      importLinkedOnly: true,
    });
    for (const rid of run2.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);
    for (const s of await db.select({ id: invoicesTable.id }).from(invoicesTable)
      .where(and(eq(invoicesTable.customerId, Y.customerId), eq(invoicesTable.invoiceType, "stornorechnung")))) {
      if (!cleanupInvoiceIds.includes(s.id)) cleanupInvoiceIds.push(s.id);
    }

    // Kernaussage: X wird NICHT erneut geflaggt/storniert; NUR Y wird repariert.
    const flagged2 = new Set(run2.flagged.map((r) => r.appointmentId));
    expect(flagged2.has(X.apptId), "Wiederanlauf: X (bereits repariert) NICHT erneut geflaggt").toBe(false);
    expect(flagged2.has(Y.apptId), "Wiederanlauf: Y (noch offen) erkannt").toBe(true);
    expect(run2.stornoedInvoiceIds, "Wiederanlauf: NUR Y storniert (X unberührt)").toEqual([Y.invoiceId]);
    expect(run2.stornoedInvoiceIds, "Wiederanlauf: reissuete X-Rechnung NICHT erneut storniert")
      .not.toContain(xReissuedId);

    // X bleibt byte-genau, ledger-stabil, genau EINE Stornorechnung (keine zweite).
    expect(await stornorechnungCount(X.customerId), "X: weiterhin genau eine Stornorechnung").toBe(1);
    const xActiveAfter2 = await activeInvoices(X.customerId);
    expect(xActiveAfter2.length, "X: weiterhin genau eine aktive Rechnung").toBe(1);
    expect(xActiveAfter2[0].id, "X: identische aktive Rechnung (nicht neu ausgestellt)").toBe(xReissuedId);
    expect(await freezeLines(xReissuedId), "X: Line-Items der neuen Rechnung unverändert").toEqual(xReissuedLinesBefore);
    expect(await liveConsumption45bCents(X.customerId), "X: Ledger unverändert (nicht doppelt reversiert)").toBe(xLedgerBefore);
    expect(xLedgerBefore, "X: Ledger == Termin-Kosten").toBe(APPT_COST_CENTS);

    // Y ist nun sauber repariert.
    await assertRepaired(Y);

    // --- Lauf 3 (VOLL-IDEMPOTENZ): beide erneut — jetzt komplett No-Op.
    const run3 = await reconcile({
      apply: true,
      customerIds: [],
      appointmentIds: [X.apptId, Y.apptId],
      userId: superadminId,
      reason: "Integrationstest Idempotenz Voll-No-Op (X+Y) #1666",
      importLinkedOnly: true,
    });
    const flagged3 = new Set(run3.flagged.map((r) => r.appointmentId));
    expect(flagged3.has(X.apptId), "Lauf 3: X nichts mehr zu tun").toBe(false);
    expect(flagged3.has(Y.apptId), "Lauf 3: Y nichts mehr zu tun").toBe(false);
    expect(run3.stornoedInvoiceIds, "Lauf 3: keine weiteren Stornos").toEqual([]);
    expect(run3.reissuedInvoiceIds, "Lauf 3: keine weiteren Neuausstellungen").toEqual([]);
    expect(run3.softStornoedServiceRecordIds, "Lauf 3: keine weiteren LN-Stornos").toEqual([]);

    // Beide Kunden bleiben stabil: genau 1 aktive Rechnung == Ledger, genau 1 Stornorechnung.
    for (const c of [X, Y]) {
      expect(await stornorechnungCount(c.customerId), `${c.label}: weiterhin genau eine Stornorechnung`).toBe(1);
      const active = await activeInvoices(c.customerId);
      expect(active.length, `${c.label}: weiterhin genau eine aktive Rechnung`).toBe(1);
      expect(await liveConsumption45bCents(c.customerId), `${c.label}: Ledger stabil == Termin-Kosten`).toBe(APPT_COST_CENTS);
    }
  }, 600_000);
});
