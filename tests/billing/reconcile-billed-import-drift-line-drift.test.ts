/**
 * Task #1657 — Integrationstest für die GoBD-Reparatur bei RECHNUNGS-LINE-DRIFT
 * (Signal B von `findBilledImportDriftRows`,
 * `server/scripts/audit-billed-appointment-import-drift.ts`).
 *
 * Der Schwester-Test `reconcile-billed-import-drift.test.ts` (Task #1653) belegt
 * die Reparatur ausschliesslich für Signal A (`consumptionRebookedAfterSeal` —
 * eine §45b-Consumption, die NACH dem Siegel neu gebucht wurde). Die zweite
 * Erkennungs-Klasse — Termin-Stammdaten (Datum / Service-Art / Dauer / km)
 * weichen NACH dem Versiegeln von den eingefrorenen Rechnungs-Line-Items ab
 * (`invoiceLineDrift` mit den Unterflags `driftDate`, `driftService`,
 * `driftDuration`, `driftKm`) — war bislang UNGETESTET. Genau diese
 * Reparatur-Pfade deckt diese Datei ab.
 *
 * Für jede der vier Drift-Unterarten wird derselbe Vier-Punkte-GoBD-Kontrakt
 * geprüft wie bei Signal A:
 *   1. Versiegelte Rechnung wird NIE in-place editiert — Original nur
 *      `storniert` + negierte Stornorechnung (append-only), Line-Items unberührt.
 *   2. Betroffener Monat wird neu ausgestellt und die frische Rechnung deckt
 *      sich mit dem Ledger (Σ aktive Rechnungen === Σ Live-§45b-Consumption);
 *      da hier echte Termindaten drifteten, spiegelt die Neu-Ausstellung die
 *      AKTUELLEN (gedrifteten) Werte wider.
 *   3. Signierter Leistungsnachweis wird soft-storniert (`deleted_at` +
 *      `service_record_deleted`-Audit) — OHNE automatische Neuerstellung.
 *   4. Der Termin wird zur manuellen Neu-Dokumentation ausgewiesen
 *      (`lnReDocRequiredAppointmentIds`).
 *
 * Drift-Injektion: Statt einer Nach-Siegel-Buchung (Signal A) wird hier — wie
 * ein früherer Vor-Guard-Excel-Import — die Termin-Stammdatenlage DIREKT in der
 * DB mutiert (Dauer / km / Datum / Service), NACHDEM Rechnung + LN versiegelt
 * sind. So driftet die IST-Datenlage von der eingefrorenen Rechnungs-
 * Momentaufnahme ab, OHNE eine Nach-Siegel-Consumption zu erzeugen (⇒ Signal A
 * bleibt aus, nur Signal B feuert).
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
  appointments,
  appointmentServices,
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
import { billingReferenceDate, billingReferenceMonth } from "../helpers/billing-month";

const AB_HOURLY_CENTS = 4200; // Alltagsbegleitung, siehe scripts/seed-test-reference-data.ts
const HW_HOURLY_CENTS = 3800; // Hauswirtschaft
const KM_RATE_CENTS = 35; // travel_km / customer_km
const POT_CAPACITY_CENTS = 13100; // §45b gesetzliches Monats-Maximum
const APPT_MINUTES = 30;
const APPT_COST_CENTS = (AB_HOURLY_CENTS * APPT_MINUTES) / 60; // 2100

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abServiceId: number;
let hwServiceId: number;
let superadminId: number;
let year: number;
let month: number;
let monthStart: string;

const createdCustomerIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
];

/** Kassen-Kunde (PG3, KEIN Privatzahler) mit EINEM limitierten §45b-Topf. */
async function setupSinglePotCustomer(): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "ImportDrift",
    nachname: `LineDrift-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `import-linedrift-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "3",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000079",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  const id = custRes.data.id;
  createdCustomerIds.push(id);

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
    budgetStartDate: monthStart,
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
async function createAppt(customerId: number): Promise<{ id: number; date: string; time: string }> {
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
        notes: `ImportDrift-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: abServiceId, durationMinutes: APPT_MINUTES }],
      });
      if (res.status === 201) return { id: res.data.id, date: dateStr, time };
    }
  }
  throw new Error("createAppt: kein freier Werktags-Slot im Monat gefunden");
}

/** Findet einen ANDEREN vergangenen Werktag im selben Monat (für den Datums-Drift). */
function alternateWeekdayInMonth(exclude: string): string {
  const today = billingReferenceDate();
  const lastDay = new Date(year, month, 0).getDate();
  for (let day = 1; day <= lastDay; day++) {
    const cand = new Date(year, month - 1, day);
    if (cand > today) continue;
    const dow = cand.getDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = ymd(cand);
    if (dateStr !== exclude) return dateStr;
  }
  throw new Error("alternateWeekdayInMonth: kein zweiter Werktag im Monat gefunden");
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
async function createAndSignSr(customerId: number): Promise<number> {
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

async function generate(customerId: number): Promise<any[]> {
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

interface DriftScenario {
  /** Beschreibung + Suite-Titel. */
  title: string;
  /** Erwartetes Unterflag von `invoiceLineDrift`, das feuern MUSS. */
  expectedFlag: "driftDuration" | "driftKm" | "driftDate" | "driftService";
  /** Direkte DB-Mutation NACH dem Siegel (= simulierter Vor-Guard-Import). */
  mutate: (apptId: number, apptDate: string) => Promise<void>;
  /**
   * §45b-Consumption, die die Neu-Ausstellung nach dem Drift buchen MUSS
   * (= aktuelle, gedriftete Termindaten). Deterministisch berechnet.
   */
  expectedReissuedCents: number;
}

const SCENARIOS: DriftScenario[] = [
  {
    title: "Dauer-Drift (actualDurationMinutes nach Siegel geändert)",
    expectedFlag: "driftDuration",
    mutate: async (apptId) => {
      await db
        .update(appointmentServices)
        .set({ actualDurationMinutes: 45 })
        .where(eq(appointmentServices.appointmentId, apptId));
    },
    expectedReissuedCents: (AB_HOURLY_CENTS * 45) / 60, // 3150
  },
  {
    title: "km-Drift (travelKilometers nach Siegel geändert)",
    expectedFlag: "driftKm",
    mutate: async (apptId) => {
      await db
        .update(appointments)
        .set({ travelKilometers: 5 })
        .where(eq(appointments.id, apptId));
    },
    expectedReissuedCents: APPT_COST_CENTS + 5 * KM_RATE_CENTS, // 2275
  },
  {
    title: "Service-Drift (serviceId nach Siegel geändert: AB → HW)",
    expectedFlag: "driftService",
    mutate: async (apptId) => {
      await db
        .update(appointmentServices)
        .set({ serviceId: hwServiceId })
        .where(eq(appointmentServices.appointmentId, apptId));
    },
    expectedReissuedCents: (HW_HOURLY_CENTS * APPT_MINUTES) / 60, // 1900
  },
  {
    title: "Datums-Drift (appointments.date nach Siegel geändert)",
    expectedFlag: "driftDate",
    mutate: async (apptId, apptDate) => {
      const altDate = alternateWeekdayInMonth(apptDate);
      await db
        .update(appointments)
        .set({ date: altDate })
        .where(eq(appointments.id, apptId));
    },
    expectedReissuedCents: APPT_COST_CENTS, // 2100 (Kosten unverändert, nur Datum)
  },
];

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;
  hwServiceId = services.data.find((s) => s.code === "hauswirtschaft")!.id;

  const [sa] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isSuperAdmin, true), eq(users.isActive, true)))
    .limit(1);
  superadminId = sa?.id ?? auth.user.id;

  ({ year, month } = billingReferenceMonth());
  monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) { try { await apiDelete(`/api/billing/${id}`); } catch { /* best-effort */ } }
  for (const id of createdCustomerIds) await cleanupCustomer(id);
  await runCleanup();
});

objectStorageDescribe("Import-Drift-Reparatur bei Rechnungs-Line-Drift (Signal B, Task #1657)", () => {
  for (const scenario of SCENARIOS) {
    it(
      `${scenario.title}: erkannt (nur Signal B), scharf repariert mit den 4 GoBD-Garantien`,
      async () => {
        // --- Realer Abrechnungs-Fluss: anlegen → dokumentieren (bucht §45b) →
        //     LN signieren (= Siegel) → Rechnung erstellen (= versiegeltes
        //     Artefakt). Danach die Stammdaten DIREKT mutieren (Vor-Guard-Import).
        const customerId = await setupSinglePotCustomer();
        const appt = await createAppt(customerId);
        const apptId = appt.id;
        await documentAppt(apptId, appt.time);
        const serviceRecordId = await createAndSignSr(customerId);
        const invoices = await generate(customerId);
        expect(invoices.length, "erste Abrechnung erzeugt genau 1 Rechnung").toBe(1);
        const originalInvoiceId = invoices[0].id;
        expect(await liveConsumption45bCents(customerId), "Dokumentation belegt §45b live").toBe(APPT_COST_CENTS);

        // Drift-Injektion: Stammdaten NACH dem Siegel direkt in der DB ändern.
        await scenario.mutate(apptId, appt.date);

        // --- Trockenlauf: Signal B feuert, Signal A NICHT, keine Schreib-Effekte.
        const dry = await reconcile({
          apply: false,
          customerIds: [],
          appointmentIds: [apptId],
          importLinkedOnly: false,
        });
        const flagged = dry.flagged.find((r) => r.appointmentId === apptId);
        expect(flagged, "Termin muss als Drift erkannt werden").toBeDefined();
        expect(flagged!.invoiceLineDrift, "Signal B (Line-Drift) muss feuern").toBe(true);
        expect(flagged![scenario.expectedFlag], `Unterflag ${scenario.expectedFlag} muss feuern`).toBe(true);
        expect(
          flagged!.consumptionRebookedAfterSeal,
          "Signal A darf NICHT feuern (keine Nach-Siegel-Consumption)",
        ).toBe(false);

        const planItem = dry.plan.find((p) => p.appointmentId === apptId);
        expect(planItem, "Reparatur-Plan enthält den Termin").toBeDefined();
        expect(planItem!.sealedInvoiceIds).toContain(originalInvoiceId);
        expect(planItem!.signedServiceRecordIds).toContain(serviceRecordId);

        expect(dry.stornoedInvoiceIds).toHaveLength(0);
        expect(dry.reissuedInvoiceIds).toHaveLength(0);
        expect(dry.softStornoedServiceRecordIds).toHaveLength(0);
        expect(dry.batchId, "kein Batch im Trockenlauf").toBeUndefined();

        // Original-Line-Items VOR der Reparatur festhalten.
        const beforeLines = await db.select({
          id: invoiceLineItems.id,
          totalCents: invoiceLineItems.totalCents,
          durationMinutes: invoiceLineItems.durationMinutes,
          appointmentId: invoiceLineItems.appointmentId,
        }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, originalInvoiceId));
        expect(beforeLines.length, "Original-Rechnung hat Line-Items").toBeGreaterThan(0);

        // --- Scharfer Lauf.
        const args: Args = {
          apply: true,
          customerIds: [],
          appointmentIds: [apptId],
          userId: superadminId,
          reason: `Integrationstest Import-Line-Drift-Reparatur (${scenario.expectedFlag}) #1657`,
          importLinkedOnly: false,
        };
        const summary = await reconcile(args);

        // --- Garantie 1: versiegelte Rechnung nur storniert, NIE in-place editiert.
        expect(summary.stornoedInvoiceIds, "Original-Rechnung storniert").toContain(originalInvoiceId);
        const [orig] = await db.select({ status: invoicesTable.status })
          .from(invoicesTable).where(eq(invoicesTable.id, originalInvoiceId)).limit(1);
        expect(orig.status, "Original ist storniert").toBe("storniert");

        const stornos = await db.select({ id: invoicesTable.id })
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
        expect(afterLines, "Original-Line-Items unverändert (append-only)").toEqual(beforeLines);

        // --- Garantie 2: Monat neu ausgestellt, Rechnung deckt sich mit Ledger.
        expect(summary.reissuedInvoiceIds.length, "mindestens eine neue Rechnung ausgestellt").toBeGreaterThan(0);
        for (const rid of summary.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);
        const reissued = summary.reissuedInvoiceIds[0];
        const reissuedLines = await db.select({ appointmentId: invoiceLineItems.appointmentId })
          .from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, reissued));
        expect(reissuedLines.map((l) => l.appointmentId), "neue Rechnung deckt den Termin ab").toContain(apptId);

        const live = await liveConsumption45bCents(customerId);
        const active = await activeInvoices(customerId);
        const activeNet = active.reduce((sum, i) => sum + (i.netAmountCents ?? 0), 0);
        expect(active.length, "genau eine aktive Rechnung (die neu ausgestellte)").toBe(1);
        // Kern-Invariante: Rechnung == Ledger (beide aus derselben frischen Buchung).
        expect(activeNet, "Σ aktive Rechnungen === Live-Ledger").toBe(live);
        // Die Neu-Ausstellung spiegelt die AKTUELLEN (gedrifteten) Termindaten.
        expect(live, "re-abgerechneter §45b-Verbrauch spiegelt die gedrifteten Termindaten").toBe(
          scenario.expectedReissuedCents,
        );

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
      },
      180_000,
    );
  }

  // --------------------------------------------------------------------------
  // KOMBINIERTER Drift (Task #1664): In einem echten Vor-Guard-Import driften
  // NICHT einzelne Felder isoliert, sondern MEHRERE Termin-Stammdaten auf
  // DEMSELBEN versiegelten Termin GLEICHZEITIG (z.B. ein längerer HW-Besuch an
  // einem anderen Tag mit zusätzlichen km). Die Erkennung ORt zwar die
  // Unterflags, aber die Neu-Ausstellung MUSS den VOLLSTÄNDIG kombinierten
  // neuen Zustand re-buchen — eine Reparatur, die nur EIN Feld aufgreift, würde
  // die neu ausgestellte Rechnung vom Ledger abweichen lassen, und KEIN
  // Einzelfeld-Test oben würde das bemerken. Dieser Test schliesst genau diese
  // Lücke: alle vier Drift-Arten feuern zusammen, und der re-abgerechnete
  // §45b-Verbrauch muss der voll kombinierten gedrifteten Kostenlage
  // entsprechen (HW @ 45 min + 5 travel-km).
  // --------------------------------------------------------------------------
  it(
    "Kombinierter Drift (Dauer + km + Service + Datum zugleich): alle 4 Unterflags feuern, Neu-Ausstellung deckt die voll kombinierte Kostenlage",
    async () => {
      // Erwartete voll kombinierte, gedriftete §45b-Kostenlage:
      //   Service AB→HW, Dauer 30→45 min ⇒ HW @ 45 min = 3800 * 45/60 = 2850
      //   + 5 travel-km * 35 ct                                     =  175
      //   ─────────────────────────────────────────────────────────────────
      //   Summe                                                     = 3025
      const COMBINED_REISSUED_CENTS = (HW_HOURLY_CENTS * 45) / 60 + 5 * KM_RATE_CENTS; // 3025

      // --- Realer Abrechnungs-Fluss (identisch zu den Einzelfeld-Szenarien).
      const customerId = await setupSinglePotCustomer();
      const appt = await createAppt(customerId);
      const apptId = appt.id;
      await documentAppt(apptId, appt.time);
      const serviceRecordId = await createAndSignSr(customerId);
      const invoices = await generate(customerId);
      expect(invoices.length, "erste Abrechnung erzeugt genau 1 Rechnung").toBe(1);
      const originalInvoiceId = invoices[0].id;
      expect(await liveConsumption45bCents(customerId), "Dokumentation belegt §45b live").toBe(APPT_COST_CENTS);

      // --- Kombinierte Drift-Injektion: ALLE vier Felder NACH dem Siegel
      //     gleichzeitig direkt in der DB mutieren (simulierter Vor-Guard-Import).
      const altDate = alternateWeekdayInMonth(appt.date);
      await db
        .update(appointmentServices)
        .set({ serviceId: hwServiceId, actualDurationMinutes: 45 })
        .where(eq(appointmentServices.appointmentId, apptId));
      await db
        .update(appointments)
        .set({ travelKilometers: 5, date: altDate })
        .where(eq(appointments.id, apptId));

      // --- Trockenlauf: Signal B feuert mit ALLEN vier Unterflags, Signal A nicht.
      const dry = await reconcile({
        apply: false,
        customerIds: [],
        appointmentIds: [apptId],
        importLinkedOnly: false,
      });
      const flagged = dry.flagged.find((r) => r.appointmentId === apptId);
      expect(flagged, "Termin muss als Drift erkannt werden").toBeDefined();
      expect(flagged!.invoiceLineDrift, "Signal B (Line-Drift) muss feuern").toBe(true);
      expect(flagged!.driftDuration, "Unterflag driftDuration muss feuern").toBe(true);
      expect(flagged!.driftKm, "Unterflag driftKm muss feuern").toBe(true);
      expect(flagged!.driftService, "Unterflag driftService muss feuern").toBe(true);
      expect(flagged!.driftDate, "Unterflag driftDate muss feuern").toBe(true);
      expect(
        flagged!.consumptionRebookedAfterSeal,
        "Signal A darf NICHT feuern (keine Nach-Siegel-Consumption)",
      ).toBe(false);

      const planItem = dry.plan.find((p) => p.appointmentId === apptId);
      expect(planItem, "Reparatur-Plan enthält den Termin").toBeDefined();
      expect(planItem!.sealedInvoiceIds).toContain(originalInvoiceId);
      expect(planItem!.signedServiceRecordIds).toContain(serviceRecordId);

      expect(dry.stornoedInvoiceIds).toHaveLength(0);
      expect(dry.reissuedInvoiceIds).toHaveLength(0);
      expect(dry.softStornoedServiceRecordIds).toHaveLength(0);
      expect(dry.batchId, "kein Batch im Trockenlauf").toBeUndefined();

      // Original-Line-Items VOR der Reparatur festhalten.
      const beforeLines = await db.select({
        id: invoiceLineItems.id,
        totalCents: invoiceLineItems.totalCents,
        durationMinutes: invoiceLineItems.durationMinutes,
        appointmentId: invoiceLineItems.appointmentId,
      }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, originalInvoiceId));
      expect(beforeLines.length, "Original-Rechnung hat Line-Items").toBeGreaterThan(0);

      // --- Scharfer Lauf.
      const args: Args = {
        apply: true,
        customerIds: [],
        appointmentIds: [apptId],
        userId: superadminId,
        reason: "Integrationstest kombinierter Import-Line-Drift (Dauer+km+Service+Datum) #1664",
        importLinkedOnly: false,
      };
      const summary = await reconcile(args);

      // --- Garantie 1: versiegelte Rechnung nur storniert, NIE in-place editiert.
      expect(summary.stornoedInvoiceIds, "Original-Rechnung storniert").toContain(originalInvoiceId);
      const [orig] = await db.select({ status: invoicesTable.status })
        .from(invoicesTable).where(eq(invoicesTable.id, originalInvoiceId)).limit(1);
      expect(orig.status, "Original ist storniert").toBe("storniert");

      const stornos = await db.select({ id: invoicesTable.id })
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
      expect(afterLines, "Original-Line-Items unverändert (append-only)").toEqual(beforeLines);

      // --- Garantie 2: Monat neu ausgestellt, Rechnung deckt sich mit Ledger.
      expect(summary.reissuedInvoiceIds.length, "mindestens eine neue Rechnung ausgestellt").toBeGreaterThan(0);
      for (const rid of summary.reissuedInvoiceIds) if (!cleanupInvoiceIds.includes(rid)) cleanupInvoiceIds.push(rid);
      const reissued = summary.reissuedInvoiceIds[0];
      const reissuedLines = await db.select({ appointmentId: invoiceLineItems.appointmentId })
        .from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, reissued));
      expect(reissuedLines.map((l) => l.appointmentId), "neue Rechnung deckt den Termin ab").toContain(apptId);

      const live = await liveConsumption45bCents(customerId);
      const active = await activeInvoices(customerId);
      const activeNet = active.reduce((sum, i) => sum + (i.netAmountCents ?? 0), 0);
      expect(active.length, "genau eine aktive Rechnung (die neu ausgestellte)").toBe(1);
      // Kern-Invariante: Rechnung == Ledger (beide aus derselben frischen Buchung).
      expect(activeNet, "Σ aktive Rechnungen === Live-Ledger").toBe(live);
      // Kern-Aussage dieses Tests: die Neu-Ausstellung spiegelt die VOLL
      // KOMBINIERTEN gedrifteten Termindaten — nicht nur ein einzelnes Feld.
      expect(
        live,
        "re-abgerechneter §45b-Verbrauch spiegelt die voll kombinierten gedrifteten Termindaten (HW @ 45 min + 5 km)",
      ).toBe(COMBINED_REISSUED_CENTS);

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
    },
    180_000,
  );
});
