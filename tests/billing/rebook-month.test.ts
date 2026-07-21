/**
 * Task #1785 — Monats-Umwidmung (Budgettopf-Umbuchung eines ganzen Monats).
 *
 * Deckt die Kern-Mechanik von `rebookCustomerMonth` (server/storage/budget/
 * rebook-storage.ts) sowie den Route-End-to-End-Pfad inkl. Neuerzeugung der
 * verwaisten Entwurfs-Rechnungen ab:
 *
 *   A) Kern (roh geseedete Verbrauchsbuchungen, deterministisch):
 *      A1 — ganzer Monat: alle Zeilen wandern in den Ziel-Topf, Σ bleibt erhalten
 *           (append-only Storno + Neubuchung, Original-Datum erhalten).
 *      A2 — datumsgenau: eine Zeile VOR `validFrom` des Ziel-Topfs bleibt stehen
 *           (`skipped`), nur die gültige Zeile wandert.
 *      A3 — Kapazitäts-Engpass: reicht der Ziel-Topf nicht, wirft die Umbuchung
 *           mit klarer deutscher Meldung und rollt die GESAMTE Umbuchung zurück.
 *
 *   B) Route + Draft-Regen (realistische Pipeline, DB-only ohne Objekt-Storage):
 *      B1 — POST /rebook-month bucht den Monat um, verwirft die verwaiste
 *           Entwurfs-Rechnung des alten Topfs und erzeugt sie neu (Audit-Spur).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  appointmentServices,
  auditLog,
  budgetTransactions,
  invoices,
} from "@shared/schema";
import {
  getRebookMonthPreview,
  rebookCustomerMonth,
} from "../../server/storage/budget/rebook-storage";
import { generateInvoiceCore } from "../../server/services/invoice-calc";
import { setupBudgetScenario } from "../helpers/budget-scenarios";
import { validSignatureDataUrl } from "../helpers/valid-signature";
import {
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  createTestEmployee,
  deactivateTestEmployee,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";

const YEAR = 2026;
const MONTH = 5; // Mai 2026 — komplett vergangen relativ zu „heute" (21.07.2026).
// Werktage im Mai 2026 (createAppt lehnt Wochenenden ab; 2026-05-01 ist Freitag).
const EARLY_DATE = `${YEAR}-05-06`; // Mittwoch
const LATE_DATE = `${YEAR}-05-20`; // Mittwoch

let userId: number;
let abServiceId: number;

const cleanupCustomerIds: number[] = [];
const cleanupEmployeeIds: number[] = [];
const cleanupApptIds: number[] = [];
const cleanupScenarioFns: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const auth = await getAuthCookie();
  userId = auth.user.id;
  const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
  abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;
});

afterAll(async () => {
  for (const fn of cleanupScenarioFns) {
    try { await fn(); } catch { /* best-effort */ }
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
  }
  for (const id of cleanupCustomerIds) {
    try { await cleanupCustomer(id); } catch { /* best-effort (GoBD) */ }
  }
  for (const id of cleanupEmployeeIds) {
    try { await deactivateTestEmployee(id); } catch { /* best-effort */ }
  }
  await runCleanup();
});

/** Kunde + Mitarbeiter + Zuweisung. */
async function createCustomerWithEmployee(): Promise<{ customerId: number; employeeId: number }> {
  const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
    vorname: "Rebook",
    nachname: `Month-${uniqueId()}`,
    geburtsdatum: "1941-02-02",
    email: `rebook-month-${uniqueId()}@test.local`,
    strasse: "Musterweg",
    nr: "3",
    plz: "01067",
    stadt: "Dresden",
    telefon: "+4917600000021",
    pflegegrad: 3,
    pflegegradSeit: "2024-01-01",
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: false,
  });
  expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
  const customerId = custRes.data.id;
  cleanupCustomerIds.push(customerId);

  const emp = await createTestEmployee({ nachnamePrefix: "Rebook_Month" });
  cleanupEmployeeIds.push(emp.id);
  const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
    primaryEmployeeId: emp.id,
    backupEmployeeId: null,
    backupEmployeeId2: null,
  });
  expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);
  return { customerId, employeeId: emp.id };
}

async function createAppt(customerId: number, employeeId: number, date: string, start: string, end: string): Promise<number> {
  const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
    customerId,
    date,
    scheduledStart: start,
    scheduledEnd: end,
    notes: `Rebook-Month-${uniqueId()}`,
    assignedEmployeeId: employeeId,
    services: [{ serviceId: abServiceId, durationMinutes: 30 }],
  });
  expect(res.status, `create appt: ${JSON.stringify(res.data)}`).toBe(201);
  cleanupApptIds.push(res.data.id);
  await db.update(appointmentServices)
    .set({ actualDurationMinutes: 30 })
    .where(eq(appointmentServices.appointmentId, res.data.id));
  return res.data.id;
}

/** Termin + rohe §39-Verbrauchsbuchung (Quelle der Umbuchung). */
async function seedRebookable(
  customerId: number,
  employeeId: number,
  date: string,
  start: string,
  amountCents: number,
): Promise<{ apptId: number; txId: number }> {
  const apptId = await createAppt(customerId, employeeId, date, start, "23:59");
  const [src] = await db.insert(budgetTransactions).values({
    customerId,
    budgetType: "ersatzpflege_39_42a",
    transactionDate: date,
    transactionType: "consumption",
    amountCents: -Math.abs(amountCents),
    appointmentId: apptId,
    notes: "§39 (Umbuchungs-Quelle)",
    createdByUserId: userId,
  }).returning({ id: budgetTransactions.id });
  return { apptId, txId: src.id };
}

async function fund45b(customerId: number, validFrom: string): Promise<void> {
  const init = await apiPost(`/api/budget/${customerId}/initial-budget`, {
    budgetType: "entlastungsbetrag_45b",
    currentMonthAmountCents: 13100,
    carryoverAmountCents: 0,
    budgetStartDate: validFrom,
  });
  expect([200, 201]).toContain(init.status);
}

/** Live-Verbrauchszeilen (nicht storniert) je Topf für einen Kunden. */
async function liveConsumptionByPot(customerId: number): Promise<Map<string, { count: number; sumAbs: number }>> {
  const rows = await db.select({
    id: budgetTransactions.id,
    budgetType: budgetTransactions.budgetType,
    amountCents: budgetTransactions.amountCents,
  })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.transactionType, "consumption"),
    ));
  const reversals = await db.select({ reversedTransactionId: budgetTransactions.reversedTransactionId, notes: budgetTransactions.notes })
    .from(budgetTransactions)
    .where(and(
      eq(budgetTransactions.customerId, customerId),
      eq(budgetTransactions.transactionType, "reversal"),
    ));
  const reversed = new Set<number>();
  for (const r of reversals) {
    if (r.reversedTransactionId != null) reversed.add(r.reversedTransactionId);
    const m = r.notes?.match(/Transaktion #(\d+)/);
    if (m) reversed.add(Number(m[1]));
  }
  const byPot = new Map<string, { count: number; sumAbs: number }>();
  for (const row of rows) {
    if (reversed.has(row.id)) continue;
    const cur = byPot.get(row.budgetType) ?? { count: 0, sumAbs: 0 };
    cur.count += 1;
    cur.sumAbs += Math.abs(row.amountCents);
    byPot.set(row.budgetType, cur);
  }
  return byPot;
}

describe("Monats-Umwidmung: Kern (Task #1785)", () => {
  it("A1 — bucht alle §39-Zeilen des Monats nach §45b um, Σ bleibt erhalten", async () => {
    const { customerId } = await createCustomerWithEmployee();
    await fund45b(customerId, `${YEAR}-05-01`);
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    const { txId: tx1 } = await seedRebookable(customerId, cleanupEmployeeIds[cleanupEmployeeIds.length - 1], EARLY_DATE, "09:00", 2380);
    const { txId: tx2 } = await seedRebookable(customerId, cleanupEmployeeIds[cleanupEmployeeIds.length - 1], LATE_DATE, "10:00", 3140);
    expect(tx1).toBeGreaterThan(0);
    expect(tx2).toBeGreaterThan(0);

    const before = await liveConsumptionByPot(customerId);
    const beforeSum = Array.from(before.values()).reduce((s, v) => s + v.sumAbs, 0);
    expect(before.get("ersatzpflege_39_42a")?.count).toBe(2);
    expect(beforeSum).toBe(2380 + 3140);

    const result = await rebookCustomerMonth({
      customerId, year: YEAR, month: MONTH,
      targetBudgetType: "entlastungsbetrag_45b", userId, isSuperAdmin: false,
    });
    expect(result.rebookedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.movedAmountCents).toBe(2380 + 3140);

    const after = await liveConsumptionByPot(customerId);
    const afterSum = Array.from(after.values()).reduce((s, v) => s + v.sumAbs, 0);
    // §39 ist storniert (keine Live-Zeile mehr), alles liegt jetzt in §45b.
    expect(after.get("ersatzpflege_39_42a")?.count ?? 0).toBe(0);
    expect(after.get("entlastungsbetrag_45b")?.count).toBe(2);
    // Σ-Erhaltung: Gesamtverbrauch unverändert, nur der Topf ist anders.
    expect(afterSum).toBe(beforeSum);
  }, 120_000);

  it("A2 — lässt eine Zeile VOR dem Ziel-validFrom stehen (skipped), bucht nur die gültige", async () => {
    const { customerId } = await createCustomerWithEmployee();
    await fund45b(customerId, `${YEAR}-05-01`);
    // §45b erst ab Monatsmitte gültig ⇒ Zeile am 06.05. ist datumsgenau ungültig.
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100, yearlyLimitCents: null, validFrom: `${YEAR}-05-15`, validTo: null },
        { budgetType: "umwandlung_45a", enabled: false, priority: 2, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    const empId = cleanupEmployeeIds[cleanupEmployeeIds.length - 1];
    const early = await seedRebookable(customerId, empId, EARLY_DATE, "09:00", 2380); // 06.05. → skip
    const late = await seedRebookable(customerId, empId, LATE_DATE, "10:00", 2380); // 20.05. → move

    const result = await rebookCustomerMonth({
      customerId, year: YEAR, month: MONTH,
      targetBudgetType: "entlastungsbetrag_45b", userId, isSuperAdmin: false,
    });
    expect(result.rebookedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.movedAmountCents).toBe(2380);
    expect(result.skipped[0].transactionId).toBe(early.txId);

    const after = await liveConsumptionByPot(customerId);
    // Frühe §39-Zeile bleibt stehen, späte ist nach §45b umgebucht.
    expect(after.get("ersatzpflege_39_42a")?.count).toBe(1);
    expect(after.get("entlastungsbetrag_45b")?.count).toBe(1);
    expect(late.apptId).toBeGreaterThan(0);
  }, 120_000);

  it("A3 — Kapazitäts-Engpass wirft deutsch und rollt die gesamte Umbuchung zurück", async () => {
    const { customerId } = await createCustomerWithEmployee();
    // Ziel §45a mit winzigem Cap (10 €) — deckt die 2×23,80 € NICHT.
    const typesRes = await apiPut(`/api/budget/${customerId}/type-settings`, {
      settings: [
        { budgetType: "entlastungsbetrag_45b", enabled: false, priority: 1, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 1000, yearlyLimitCents: null, validFrom: null, validTo: null },
        { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3, monthlyLimitCents: null, yearlyLimitCents: null, validFrom: null, validTo: null },
      ],
    });
    expect(typesRes.status, `type-settings: ${JSON.stringify(typesRes.data)}`).toBe(200);

    const empId = cleanupEmployeeIds[cleanupEmployeeIds.length - 1];
    await seedRebookable(customerId, empId, EARLY_DATE, "09:00", 2380);
    await seedRebookable(customerId, empId, LATE_DATE, "10:00", 2380);

    await expect(
      rebookCustomerMonth({
        customerId, year: YEAR, month: MONTH,
        targetBudgetType: "umwandlung_45a", userId, isSuperAdmin: false,
      }),
    ).rejects.toThrow(/nicht genug Budget/i);

    // Rollback: beide §39-Quellzeilen unverändert live, KEINE §45a-Zeile gebucht.
    const after = await liveConsumptionByPot(customerId);
    expect(after.get("ersatzpflege_39_42a")?.count).toBe(2);
    expect(after.get("umwandlung_45a")?.count ?? 0).toBe(0);
    // Kein Storno geschrieben (all-or-nothing).
    const reversals = await db.select({ id: budgetTransactions.id })
      .from(budgetTransactions)
      .where(and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.transactionType, "reversal"),
      ));
    expect(reversals.length).toBe(0);
  }, 120_000);
});

describe("Monats-Umwidmung: Route + Entwurfs-Regen (Task #1785)", () => {
  it("B1 — POST /rebook-month verwirft die verwaiste Entwurfs-Rechnung und erzeugt sie neu", async () => {
    // Realistische Pipeline: dokumentierte Termine buchen echten Verbrauch in
    // §45b (Priorität 1), §45a/§39 stehen als mögliche Ziel-Töpfe bereit.
    const scenario = await setupBudgetScenario({
      customerNamePrefix: "RebookMonthRegen",
      pflegegrad: 3,
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      initialBalance: { type: "entlastungsbetrag_45b", amountCents: 13100, validFrom: `${YEAR}-05-01` },
      types: [
        { type: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: 13100 },
        { type: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: 50000 },
        { type: "ersatzpflege_39_42a", enabled: true, priority: 3, yearlyLimitCents: 300000 },
      ],
      appointments: [
        { date: EARLY_DATE, scheduledStart: "09:00", services: [{ code: "alltagsbegleitung", durationMinutes: 30 }], document: true },
        { date: LATE_DATE, scheduledStart: "10:00", services: [{ code: "alltagsbegleitung", durationMinutes: 30 }], document: true },
      ],
    });
    cleanupScenarioFns.push(() => scenario.cleanup());
    const customerId = scenario.customerId;

    // Verbrauch liegt in §45b (Priorität 1, ausreichend gedeckt).
    const beforePot = await liveConsumptionByPot(customerId);
    expect(beforePot.get("entlastungsbetrag_45b")?.count).toBe(2);

    // (0) Leistungsnachweis (Sammel-LN) für den Monat erstellen + beidseitig
    // signieren. Pflegekasse (gesetzlich) rechnet nur mit Kundenunterschrift ab
    // (status='completed'), und generateInvoiceCore verlangt einen LN für den
    // Zeitraum (invoice-calc LN-Precondition). employeeId = Primär-Mitarbeiter
    // des Kunden ⇒ isPrimary=true ⇒ alle dokumentierten Kunden-Termine gedeckt.
    const srCreate = await apiPost<{ id: number }>("/api/service-records", {
      customerId,
      employeeId: scenario.employeeId,
      year: YEAR,
      month: MONTH,
    });
    expect(srCreate.status, `LN-Erstellung: ${JSON.stringify(srCreate.data)}`).toBe(201);
    const serviceRecordId = srCreate.data.id;
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost<unknown>(
        `/api/service-records/${serviceRecordId}/sign`,
        { signerType, signatureData: validSignatureDataUrl() },
      );
      expect(sig.status, `LN-Signatur (${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    // (1) Ursprüngliche Entwurfs-Rechnung(en) des Monats erzeugen (auf §45b).
    await generateInvoiceCore(
      { customerId, billingMonth: MONTH, billingYear: YEAR },
      { userId, testFaults: new Set<string>() },
    );
    const draftsBefore = await db.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(and(
        eq(invoices.customerId, customerId),
        eq(invoices.billingYear, YEAR),
        eq(invoices.billingMonth, MONTH),
        eq(invoices.status, "entwurf"),
        ne(invoices.invoiceType, "stornorechnung"),
      ));
    expect(draftsBefore.length, "Entwurfs-Rechnung(en) vor der Umbuchung").toBeGreaterThan(0);
    const originalNumbers = draftsBefore.map((d) => d.invoiceNumber);

    // (2) Vorschau: ein gültiges Ziel ≠ §45b mit ausreichender Kapazität finden.
    const preview = await getRebookMonthPreview({ customerId, year: YEAR, month: MONTH });
    expect(preview.source.totalAmountCents).toBeGreaterThan(0);
    const target = preview.eligibleTargets.find(
      (t) => t.eligible && t.budgetType !== "entlastungsbetrag_45b" && t.availableCents >= preview.source.totalAmountCents,
    );
    expect(target, `kein gültiger Ziel-Topf mit Kapazität: ${JSON.stringify(preview.eligibleTargets)}`).toBeTruthy();

    // (3) Route ausführen — Umbuchung + Draft-Regen in einem Rutsch.
    const res = await apiPost<{
      rebookedCount: number;
      movedAmountCents: number;
      draftRegen: { discardedInvoiceNumbers: string[]; regenerated: boolean };
    }>(`/api/budget/${customerId}/rebook-month`, {
      year: YEAR, month: MONTH, targetBudgetType: target!.budgetType,
    });
    expect(res.status, `rebook-month: ${JSON.stringify(res.data)}`).toBe(200);
    expect(res.data.rebookedCount).toBe(2);
    expect(res.data.draftRegen.regenerated).toBe(true);
    expect(res.data.draftRegen.discardedInvoiceNumbers.length).toBeGreaterThan(0);
    // Die verworfene Nummer war eine der ursprünglichen Entwurfs-Rechnungen.
    expect(originalNumbers).toEqual(
      expect.arrayContaining([res.data.draftRegen.discardedInvoiceNumbers[0]]),
    );

    // (4) Die verworfenen Entwurfs-ZEILEN (per id) sind hart gelöscht, und ein
    // NEUER Entwurf existiert für den Monat. Die Rechnungs-NUMMER darf dabei
    // erneut vergeben werden: der Entwurf wird per Hard-Delete verworfen
    // (draft-invoice-regen, FK-Cascade) und die lückenlose Periodennummerierung
    // gibt dem frisch erzeugten Entwurf i.d.R. dieselbe Nummer. Maßgeblich ist,
    // dass die alte Beleg-Zeile weg und eine frische Entwurfs-Zeile da ist.
    const originalIds = draftsBefore.map((d) => d.id);
    const draftsAfter = await db.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(and(
        eq(invoices.customerId, customerId),
        eq(invoices.billingYear, YEAR),
        eq(invoices.billingMonth, MONTH),
        eq(invoices.status, "entwurf"),
        ne(invoices.invoiceType, "stornorechnung"),
      ));
    const afterIds = draftsAfter.map((d) => d.id);
    expect(afterIds.length).toBeGreaterThan(0);
    for (const oldId of originalIds) {
      expect(afterIds).not.toContain(oldId);
    }

    // (5) Audit-Spur: Entwurf verworfen.
    const audits = await db.select({ id: auditLog.id })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_draft_discarded"),
        eq(auditLog.entityType, "invoice"),
      ));
    expect(audits.length).toBeGreaterThan(0);

    // Verbrauch liegt nach der Umbuchung im Ziel-Topf.
    const afterPot = await liveConsumptionByPot(customerId);
    expect(afterPot.get("entlastungsbetrag_45b")?.count ?? 0).toBe(0);
    expect(afterPot.get(target!.budgetType)?.count).toBe(2);
  }, 180_000);
});
