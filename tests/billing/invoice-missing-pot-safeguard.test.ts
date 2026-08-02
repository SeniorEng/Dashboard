/**
 * Task #1096 — End-to-End-Absicherung der „Missing Budget Pot"-Invariante.
 *
 * Task #1094 hat in `generateInvoiceCore` (server/services/invoice-calc.ts) eine
 * laute Erstellungs-Zeit-Invariante eingezogen: Eine Kassen-Rechnung
 * (`pflegekasse_*`), deren Termine zu KEINEM eindeutig auflösbaren Budget-Topf
 * führen, MUSS mit einem `badRequest` (400) scheitern UND eine Audit-Zeile
 * `invoice_creation_pot_unresolved` schreiben — statt still mit der
 * §45b-Formulierung versiegelt zu werden.
 *
 * Die Pure-Logik-Tests (`tests/equality/invoice-single-pot-wording.test.ts`)
 * decken `resolveSinglePotBudgetType` + den Renderer ab. Es fehlte der
 * Integrationstest, der den ECHTEN Server-Pfad gegen eine Ephemeral-DB fährt:
 *
 *   (Negativ) Kassen-Kunde, Termin landet in einem signierten LN, wird aber auf
 *     `customer_no_show` gesetzt → für Kassen-Kunden entsteht kein Line-Item
 *     (keine Cancellation-Policy) → kein belegter Pot → Invariante feuert:
 *       (a) `generateInvoiceCore` wirft 400/badRequest,
 *       (b) eine `invoice_creation_pot_unresolved`-Audit-Zeile für den Kunden.
 *
 *   (Positiv) Normaler Single-§45b-Kassen-Kunde → genau EINE Rechnung wird
 *     erstellt und mit `budgetType='entlastungsbetrag_45b'` gestempelt.
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { appointments, auditLog, type Invoice } from "@shared/schema";
import { generateInvoiceCore } from "../../server/services/invoice-calc";
import { AppError } from "../../server/lib/errors";
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

const POT_CAPACITY_CENTS = 13100; // §45b gesetzliches Monats-Maximum
const APPT_MINUTES = 30;

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let abServiceId: number;

const cleanupCustomerIds: number[] = [];
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

const SEED_TIMES = [
  "00:00", "00:15", "00:30", "00:45", "01:00", "01:15", "01:30", "01:45",
  "02:00", "02:15", "02:30", "02:45", "03:00", "03:30", "04:00", "04:30",
  "05:00", "05:30", "20:00", "20:30", "21:00", "21:30", "22:00", "22:30",
];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Reiner Kassen-Kunde (PG3, KEIN Privatzahler) mit EINEM limitierten §45b-Topf
 *  (§45a/§39 deaktiviert → echter Single-Pot). */
async function setupSinglePotCustomer(monthStartIso: string): Promise<number> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "MissingPot",
    nachname: `Safeguard-${uniqueId()}`,
    geburtsdatum: "1940-02-11",
    email: `missing-pot-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "3",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000077",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  const id = custRes.data.id;
  cleanupCustomerIds.push(id);

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

/** Legt einen vergangenen Werktags-Alltagsbegleitung-Termin im Monat an. */
async function createAppt(customerId: number, year: number, month: number, tag: string): Promise<{ id: number; date: string; time: string }> {
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
        notes: `MissingPot-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: abServiceId, durationMinutes: APPT_MINUTES }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error(`createAppt(${tag}): kein freier Werktags-Slot im Monat gefunden`);
}

async function documentAppt(id: number, time: string): Promise<void> {
  const res = await apiPost<unknown>(`/api/appointments/${id}/document`, {
    actualStart: time,
    travelOriginType: "home",
    travelKilometers: 0,
    customerKilometers: 0,
    services: [{ serviceId: abServiceId, actualDurationMinutes: APPT_MINUTES, details: "MissingPot-Test" }],
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

function genCtx() {
  return { userId: auth.user.id, ipAddress: "127.0.0.1", testFaults: new Set<string>() };
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;
});

afterAll(async () => {
  // Rechnungen sind GoBD-unveränderlich (kein DELETE-Endpoint); die
  // per-Run-Ephemeral-DB wird ohnehin verworfen. cleanupInvoiceIds dient nur
  // der Nachvollziehbarkeit.
  void cleanupInvoiceIds;
  for (const id of cleanupSrIds) { try { await apiDelete(`/api/service-records/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanupApptIds) { try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ } }
  for (const id of cleanupCustomerIds) { await cleanupCustomer(id); }
  await runCleanup();
});

describe("Task #1096 — 'Missing Budget Pot'-Invariante (End-to-End)", () => {
  it("Negativ: Kassen-Rechnung ohne auflösbaren Topf → 400 + invoice_creation_pot_unresolved-Audit", async () => {
    const { year, month } = billingReferenceMonth();
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

    const customerId = await setupSinglePotCustomer(monthStart);

    // Termin anlegen, dokumentieren (→ landet im LN), LN signieren.
    const appt = await createAppt(customerId, year, month, "NoPot");
    await documentAppt(appt.id, appt.time);
    await createAndSignSr(customerId, year, month);

    // Den (im signierten LN verlinkten) Termin auf `customer_no_show` setzen.
    // Für Kassen-Kunden existiert keine Cancellation-Policy → es entsteht KEIN
    // Line-Item → kein belegter Budget-Topf. Genau dieser Zustand ist der
    // einzige, der eine Single-Pfad-Kassenrechnung ohne auflösbaren Topf erzeugt
    // (ein einzelner Privat-Pot würde zur Selbstzahler-Rechnung reklassifiziert).
    await db.update(appointments)
      .set({ status: "customer_no_show" })
      .where(eq(appointments.id, appt.id));

    // (a) generateInvoiceCore MUSS mit badRequest (400) scheitern.
    let thrown: unknown;
    try {
      await generateInvoiceCore({ customerId, billingMonth: month, billingYear: year }, genCtx());
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "generateInvoiceCore muss werfen").toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode, "Status muss 400/badRequest sein").toBe(400);

    // Keine Rechnung darf entstanden sein.
    const list = await apiGet<Invoice[]>(`/api/billing?customerId=${customerId}`);
    expect(Array.isArray(list.data) ? list.data.length : 0, "keine Rechnung erstellt").toBe(0);

    // (b) Eine invoice_creation_pot_unresolved-Audit-Zeile für den Kunden.
    const auditRows = await db.select({ id: auditLog.id, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_creation_pot_unresolved"),
        eq(auditLog.entityType, "customer"),
        eq(auditLog.entityId, customerId),
      ));
    expect(auditRows.length, "genau eine pot-unresolved-Audit-Zeile").toBe(1);
    const meta = auditRows[0].metadata as Record<string, unknown> | null;
    expect(meta?.billingType, "Audit-Metadaten halten den Kassen-billingType fest").toBe("pflegekasse_gesetzlich");
  }, 180_000);

  it("Positiv: Single-§45b-Kassenrechnung wird erstellt und mit budgetType gestempelt", async () => {
    const { year, month } = billingReferenceMonth();
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;

    const customerId = await setupSinglePotCustomer(monthStart);

    const appt = await createAppt(customerId, year, month, "OK");
    await documentAppt(appt.id, appt.time);
    await createAndSignSr(customerId, year, month);

    const result = await generateInvoiceCore(
      { customerId, billingMonth: month, billingYear: year },
      genCtx(),
    );

    // Single-Pot-Pfad: genau eine Rechnung (kein Split-Objekt).
    expect("splitInvoices" in result, "Single-Pot erzeugt KEIN Split-Ergebnis").toBe(false);
    const invoice = result as Invoice;
    if (invoice.id) cleanupInvoiceIds.push(invoice.id);

    expect(invoice.billingType, "Kasse-Rechnung erwartet").toBe("pflegekasse_gesetzlich");
    expect(invoice.budgetType, "mit echtem §45b-Topf gestempelt (kein null-Fallback)").toBe("entlastungsbetrag_45b");
    expect(invoice.netAmountCents, "Netto > 0").toBeGreaterThan(0);

    // Kein false-positive Audit-Eintrag auf dem Happy-Path.
    const auditRows = await db.select({ id: auditLog.id })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_creation_pot_unresolved"),
        eq(auditLog.entityType, "customer"),
        eq(auditLog.entityId, customerId),
      ));
    expect(auditRows.length, "kein pot-unresolved-Audit auf dem Happy-Path").toBe(0);
  }, 180_000);
});
