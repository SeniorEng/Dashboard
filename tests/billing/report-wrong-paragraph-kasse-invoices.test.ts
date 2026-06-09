/**
 * Task #1097 — Verifikation des read-only Reports, der historische
 * Kassenrechnungen mit FALSCHEM §-Paragraphen aufspürt
 * (`reportWrongParagraphKasseInvoices`).
 *
 * Vor Task #1094 wurden Single-Pot-Kassenrechnungen, die ausschließlich aus
 * EINEM Nicht-§45b-Topf bestanden (§45a oder §§39/42a), mit
 * `invoices.budget_type = NULL` versiegelt; der Renderer fiel dann auf die
 * §45b-Formulierung zurück (rechtlich falsch). Der Report findet genau diese
 * Bestandsrechnungen — read-only, ohne Re-Seal.
 *
 * Dieser Integrationstest seedet in eine ephemere DB mehrere
 * `budget_type=NULL` Kassenrechnungen mit unterschiedlichem lebendem
 * Budget-Split und prüft, dass GENAU die §45a-/§39-42a-only-Rechnungen
 * gemeldet werden, während §45b-only (korrekter Fallback), Mehrtopf
 * (mehrdeutig) und vollständig stornierte Töpfe NICHT gemeldet werden.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetTransactions, invoices as invoicesTable, users } from "@shared/schema";
import { reportWrongParagraphKasseInvoices } from "../../server/scripts/report-wrong-paragraph-kasse-invoices";
import { createInvoiceTx, getNextInvoiceNumberTx } from "../../server/storage/billing-storage";
import {
  apiGet,
  apiPost,
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
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

describe("reportWrongParagraphKasseInvoices — Bestands-Kassenrechnungen mit falschem §-Paragraphen", () => {
  let customerId: number;
  let employeeId: number;
  let abServiceId: number;
  let superadminId: number;

  // Rechnungen, die der Report melden MUSS (falscher §45b-Fallback).
  let invoice45aOnlyId: number; // §45a-only → FALSCH (gerendert §45b)
  let invoice3942aOnlyId: number; // §39/42a-only → FALSCH
  let invoice45aPlusPrivateId: number; // §45a + Privatanteil → FALSCH (single Kasse-Topf)

  // Rechnungen, die der Report NICHT melden darf.
  let invoice45bOnlyId: number; // §45b-only → Fallback korrekt
  let invoiceMultiPotId: number; // §45a + §45b → mehrdeutig
  let invoice45aReversedId: number; // §45a vollständig storniert → keine lebende Kasse-Konsumption

  const cleanupApptIds: number[] = [];

  async function createAppt(start: string, end: string): Promise<number> {
    const res = await apiPost<{ id: number }>("/api/appointments/kundentermin", {
      customerId,
      date: APPT_DATE,
      scheduledStart: start,
      scheduledEnd: end,
      notes: `WrongParagraph-${uniqueId()}`,
      assignedEmployeeId: employeeId,
      services: [{ serviceId: abServiceId, durationMinutes: 30 }],
    });
    expect(res.status, `create appt: ${JSON.stringify(res.data)}`).toBe(201);
    cleanupApptIds.push(res.data.id);
    return res.data.id;
  }

  async function seedConsumption(apptId: number, budgetType: string, cents: number): Promise<number> {
    const [row] = await db
      .insert(budgetTransactions)
      .values({
        customerId,
        budgetType,
        transactionDate: APPT_DATE,
        transactionType: "consumption",
        amountCents: -cents,
        appointmentId: apptId,
        notes: `WrongParagraph-Test: ${budgetType}`,
      })
      .returning({ id: budgetTransactions.id });
    return row.id;
  }

  async function seedReversal(apptId: number, budgetType: string, cents: number, origId: number) {
    await db.insert(budgetTransactions).values({
      customerId,
      budgetType,
      transactionDate: APPT_DATE,
      transactionType: "reversal",
      amountCents: cents,
      appointmentId: apptId,
      reversedTransactionId: origId,
      notes: `Storno von Transaktion #${origId}`,
    });
  }

  /** Erzeugt eine `budget_type=NULL` Kassenrechnung über die gegebenen Termine. */
  async function seedNullPotInvoice(
    apptIds: number[],
    grossCents: number,
    status = "versendet",
  ): Promise<number> {
    return db.transaction(async (tx) => {
      const num = await getNextInvoiceNumberTx(tx, YEAR);
      const inv = await createInvoiceTx(
        tx,
        {
          invoiceNumber: num,
          customerId,
          billingType: "pflegekasse_gesetzlich",
          invoiceType: "rechnung",
          billingMonth: MONTH,
          billingYear: YEAR,
          recipientName: "Pflegekasse Test",
          recipientAddress: "Kassenweg 1, 01067 Dresden",
          customerName: "WrongParagraph Test",
          pflegegrad: 3,
          netAmountCents: grossCents,
          vatAmountCents: 0,
          grossAmountCents: grossCents,
          vatRate: 0,
          status,
          budgetType: null, // Kern des Bugs: Single-Pot vor #1094 ohne budget_type
        },
        apptIds.map((apptId) => ({
          appointmentId: apptId,
          appointmentDate: APPT_DATE,
          serviceDescription: "Alltagsbegleitung",
          serviceCode: "alltagsbegleitung",
          durationMinutes: 30,
          unitPriceCents: Math.round(grossCents / apptIds.length),
          totalCents: Math.round(grossCents / apptIds.length),
          employeeName: "Erik",
        })),
        superadminId,
      );
      return inv.id;
    });
  }

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .limit(1);
    superadminId = admin?.id ?? auth.user.id;

    const services = await apiGet<Array<{ id: number; code: string | null }>>("/api/services/all");
    abServiceId = services.data.find((s) => s.code === "alltagsbegleitung")!.id;

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "WrongParagraph",
      nachname: `Report-${uniqueId()}`,
      geburtsdatum: "1941-03-08",
      email: `wrongpara-${uniqueId()}@test.local`,
      strasse: "Paragraphweg",
      nr: "45",
      plz: "01067",
      stadt: "Dresden",
      telefon: "+4917600000009",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: true,
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const emp = await createTestEmployee({ vorname: "Erik", nachnamePrefix: "WrongPara" });
    employeeId = emp.id;
    const assignRes = await apiPatch(`/api/admin/customers/${customerId}/assign`, {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    });
    expect(assignRes.status, `assign: ${JSON.stringify(assignRes.data)}`).toBe(200);

    // --- §45a-only (FALSCH) ---
    const appt45a = await createAppt("08:00", "08:30");
    await seedConsumption(appt45a, "umwandlung_45a", 2000);
    invoice45aOnlyId = await seedNullPotInvoice([appt45a], 2000);

    // --- §39/42a-only (FALSCH) ---
    const appt3942a = await createAppt("09:00", "09:30");
    await seedConsumption(appt3942a, "ersatzpflege_39_42a", 3000);
    invoice3942aOnlyId = await seedNullPotInvoice([appt3942a], 3000);

    // --- §45a + Privatanteil (FALSCH: ein Kasse-Topf, Privat egal) ---
    const apptMixedPriv = await createAppt("10:00", "10:30");
    await seedConsumption(apptMixedPriv, "umwandlung_45a", 2500);
    await seedConsumption(apptMixedPriv, "private", 500);
    invoice45aPlusPrivateId = await seedNullPotInvoice([apptMixedPriv], 3000);

    // --- §45b-only (KORREKT: Fallback passt) ---
    const appt45b = await createAppt("11:00", "11:30");
    await seedConsumption(appt45b, "entlastungsbetrag_45b", 4000);
    invoice45bOnlyId = await seedNullPotInvoice([appt45b], 4000);

    // --- §45a + §45b (MEHRDEUTIG: zwei Kasse-Töpfe) ---
    const apptMulti = await createAppt("12:00", "12:30");
    await seedConsumption(apptMulti, "umwandlung_45a", 1500);
    await seedConsumption(apptMulti, "entlastungsbetrag_45b", 1500);
    invoiceMultiPotId = await seedNullPotInvoice([apptMulti], 3000);

    // --- §45a vollständig storniert (keine lebende Kasse-Konsumption) ---
    const apptReversed = await createAppt("13:00", "13:30");
    const reversedTxn = await seedConsumption(apptReversed, "umwandlung_45a", 1800);
    await seedReversal(apptReversed, "umwandlung_45a", 1800, reversedTxn);
    invoice45aReversedId = await seedNullPotInvoice([apptReversed], 1800);
  }, 180_000);

  afterAll(async () => {
    for (const id of cleanupApptIds) {
      try { await apiDelete(`/api/appointments/${id}`); } catch { /* best-effort */ }
    }
    await cleanupCustomer(customerId);
    await deactivateTestEmployee(employeeId);
    await runCleanup();
  });

  it("meldet genau die §45a-/§39-42a-Single-Pot-Rechnungen (inkl. Privat-Beimischung)", async () => {
    const summary = await reportWrongParagraphKasseInvoices({
      customerIds: [customerId],
      includeDrafts: false,
      json: true,
    });

    const flaggedIds = new Set(summary.findings.map((f) => f.invoiceId));
    expect(flaggedIds.has(invoice45aOnlyId)).toBe(true);
    expect(flaggedIds.has(invoice3942aOnlyId)).toBe(true);
    expect(flaggedIds.has(invoice45aPlusPrivateId)).toBe(true);

    // NICHT betroffen.
    expect(flaggedIds.has(invoice45bOnlyId)).toBe(false);
    expect(flaggedIds.has(invoiceMultiPotId)).toBe(false);
    expect(flaggedIds.has(invoice45aReversedId)).toBe(false);

    // Mehrtopf-Rechnung separat als mehrdeutig gezählt.
    expect(summary.ambiguousMultiPotCount).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("ordnet jedem Finding den TATSÄCHLICHEN Topf zu (nicht §45b)", async () => {
    const summary = await reportWrongParagraphKasseInvoices({
      customerIds: [customerId],
      includeDrafts: false,
      json: true,
    });
    const byId = new Map(summary.findings.map((f) => [f.invoiceId, f]));

    expect(byId.get(invoice45aOnlyId)?.actualPotKey).toBe("umwandlung_45a");
    expect(byId.get(invoice45aOnlyId)?.actualPotConsumptionCents).toBe(2000);

    expect(byId.get(invoice3942aOnlyId)?.actualPotKey).toBe("ersatzpflege_39_42a");
    expect(byId.get(invoice3942aOnlyId)?.actualPotConsumptionCents).toBe(3000);

    const mixed = byId.get(invoice45aPlusPrivateId);
    expect(mixed?.actualPotKey).toBe("umwandlung_45a");
    expect(mixed?.actualPotConsumptionCents).toBe(2500);
    expect(mixed?.privateConsumptionCents).toBe(500);

    for (const f of summary.findings) {
      expect(f.actualPotKey).not.toBe("entlastungsbetrag_45b");
    }
  }, 120_000);

  it("blendet Entwürfe standardmäßig aus, nimmt sie mit --include-drafts auf", async () => {
    const apptDraft = await createAppt("14:00", "14:30");
    await seedConsumption(apptDraft, "umwandlung_45a", 1200);
    const draftInvoiceId = await seedNullPotInvoice([apptDraft], 1200, "entwurf");

    const withoutDrafts = await reportWrongParagraphKasseInvoices({
      customerIds: [customerId],
      includeDrafts: false,
      json: true,
    });
    expect(withoutDrafts.findings.some((f) => f.invoiceId === draftInvoiceId)).toBe(false);

    const withDrafts = await reportWrongParagraphKasseInvoices({
      customerIds: [customerId],
      includeDrafts: true,
      json: true,
    });
    const draftFinding = withDrafts.findings.find((f) => f.invoiceId === draftInvoiceId);
    expect(draftFinding).toBeDefined();
    expect(draftFinding?.isDraft).toBe(true);
  }, 120_000);
});
