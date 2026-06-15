/**
 * Task #1284 — Rechnungsstatus "avis_erhalten" zwischen "versendet" und "bezahlt".
 *
 * Lebenszyklus: Entwurf → Versendet → Avis erhalten → Bezahlt (+Storniert).
 *
 * Verifiziert:
 *  1. Avis-Treffer (beim Anlegen eines Zahlungsavis mit CSV) hebt eine zugeordnete
 *     "versendet"-Rechnung auf "avis_erhalten" (Audit `invoice_avis_received`).
 *  2. "Als bezahlt markieren" setzt die offenen (versendet/avis_erhalten) Rechnungen
 *     eines Avis auf "bezahlt"; paidAt stammt aus dem Zahlungsdatum des Avis
 *     (Audit `invoice_payment_reconciled`, matchedBy="avis").
 *  3. Qonto-Match akzeptiert eine "avis_erhalten"-Rechnung und setzt sie auf "bezahlt";
 *     Unmatch setzt sie auf "avis_erhalten" zurück, solange das Avis noch aktiv ist
 *     (kein Herabstufen unter den Avis-Stand).
 *  4. Löschen eines Avis nimmt den "avis_erhalten"-Status zurück (→ versendet,
 *     Audit `invoice_avis_reverted`); bereits "bezahlt" bleibt unangetastet.
 *  5. GET /payment-advices reichert pro Avis matchedInvoiceCount + unpaidMatchedCount an.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiPost, apiDelete, apiGet, uniqueId } from "../test-utils";
import { db } from "../../server/lib/db";
import {
  customers,
  invoices,
  qontoTransactions,
  paymentAdvices,
  paymentAdviceItems,
  auditLog,
} from "../../shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withGobdMutation } from "../helpers/gobd";

interface Seeded {
  customerId: number;
  invoiceIds: number[];
  qontoTxIds: number[];
  adviceIds: number[];
}

const seeded: Seeded = { customerId: 0, invoiceIds: [], qontoTxIds: [], adviceIds: [] };

let invoiceCounter = 9000 + Math.floor(Math.random() * 50000);

function nextInvoiceNumber(): string {
  invoiceCounter += 1;
  return `RE-2026-${invoiceCounter}`;
}

async function insertInvoice(opts: { amountCents: number; invoiceNumber: string }): Promise<number> {
  const [row] = await db.insert(invoices).values({
    invoiceNumber: opts.invoiceNumber,
    customerId: seeded.customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: 4,
    billingYear: 2026,
    recipientName: "Test",
    grossAmountCents: opts.amountCents,
    netAmountCents: opts.amountCents,
    status: "versendet",
  }).returning({ id: invoices.id });
  seeded.invoiceIds.push(row.id);
  return row.id;
}

async function insertQontoTx(opts: { amountCents: number }): Promise<number> {
  const tag = uniqueId();
  const [row] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `qonto-avis-test-${tag}`,
    amountCents: opts.amountCents,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt: new Date(),
  }).returning({ id: qontoTransactions.id });
  seeded.qontoTxIds.push(row.id);
  return row.id;
}

/**
 * Barmer-CSV (Zeilentypen 1/2/3 mit Semikolon). Pro Rechnungsnummer eine
 * "2;"-Position; das Zahlungsdatum kommt aus der "3;"-Summenzeile.
 */
function buildBarmerCsv(opts: {
  invoiceNumbers: string[];
  amountEuro: string;
  zahlungsDatum: string;
}): string {
  const lines = ["1;IK123456789"];
  for (const num of opts.invoiceNumbers) {
    lines.push(`2;Sammelueberweisung;${num};${opts.zahlungsDatum};${opts.amountEuro}`);
  }
  lines.push(`3;BELEG-${uniqueId()};${opts.zahlungsDatum};${opts.amountEuro};DE00123456780000000000`);
  return lines.join("\n");
}

async function createAdviceWithCsv(opts: {
  invoiceNumbers: string[];
  amountEuro: string;
  zahlungsDatum: string;
}): Promise<{ adviceId: number; matched: number }> {
  const csvContent = buildBarmerCsv(opts);
  const res = await apiPost<{ advice: { id: number }; matched: number }>(
    "/api/admin/qonto/payment-advices",
    { fileName: `avis-${uniqueId()}.csv`, csvContent },
  );
  expect(res.status).toBe(200);
  seeded.adviceIds.push(res.data.advice.id);
  return { adviceId: res.data.advice.id, matched: res.data.matched };
}

async function getInvoiceStatus(invoiceId: number): Promise<{ status: string; paidAt: Date | null }> {
  const [row] = await db.select({ status: invoices.status, paidAt: invoices.paidAt })
    .from(invoices).where(eq(invoices.id, invoiceId));
  return row;
}

async function countAudit(action: string, invoiceId: number): Promise<number> {
  const rows = await db.select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, action),
      eq(auditLog.entityType, "invoice"),
      eq(auditLog.entityId, invoiceId),
    ));
  return rows.length;
}

beforeAll(async () => {
  const tag = uniqueId();
  const [row] = await db.insert(customers).values({
    name: `AVIS-LIFECYCLE-${tag}`,
    vorname: "Avis",
    nachname: `Lifecycle-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  }).returning({ id: customers.id });
  seeded.customerId = row.id;
});

afterAll(async () => {
  if (seeded.invoiceIds.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(and(
        eq(auditLog.entityType, "invoice"),
        inArray(auditLog.entityId, seeded.invoiceIds),
      ));
    });
  }
  if (seeded.adviceIds.length > 0) {
    await db.delete(paymentAdviceItems).where(inArray(paymentAdviceItems.paymentAdviceId, seeded.adviceIds));
    await db.delete(paymentAdvices).where(inArray(paymentAdvices.id, seeded.adviceIds));
  }
  if (seeded.qontoTxIds.length > 0) {
    await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, seeded.qontoTxIds));
  }
  if (seeded.invoiceIds.length > 0) {
    await withGobdMutation((tx) =>
      tx.delete(invoices).where(inArray(invoices.id, seeded.invoiceIds)),
    );
  }
  if (seeded.customerId) {
    await db.delete(customers).where(eq(customers.id, seeded.customerId));
  }
});

describe("Task #1284 — avis_erhalten Lebenszyklus", () => {
  it("Avis-Treffer hebt versendet → avis_erhalten (Audit invoice_avis_received)", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 12345, invoiceNumber: num });

    const { matched } = await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "123,45",
      zahlungsDatum: "15.04.2026",
    });
    expect(matched).toBe(1);

    const inv = await getInvoiceStatus(invoiceId);
    expect(inv.status).toBe("avis_erhalten");
    expect(inv.paidAt).toBeNull();
    expect(await countAudit("invoice_avis_received", invoiceId)).toBe(1);
  });

  it("Bereits bezahlte Rechnung wird vom Avis-Treffer NICHT herabgestuft", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 22222, invoiceNumber: num });
    await withGobdMutation((tx) =>
      tx.update(invoices).set({ status: "bezahlt", paidAt: new Date() }).where(eq(invoices.id, invoiceId)),
    );

    const { matched } = await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "222,22",
      zahlungsDatum: "15.04.2026",
    });
    expect(matched).toBe(1); // Item wird zugeordnet …

    const inv = await getInvoiceStatus(invoiceId);
    expect(inv.status).toBe("bezahlt"); // … aber Status bleibt bezahlt.
    expect(await countAudit("invoice_avis_received", invoiceId)).toBe(0);
  });

  it("'Als bezahlt markieren' setzt avis_erhalten → bezahlt mit paidAt aus Zahlungsdatum", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 33333, invoiceNumber: num });
    const { adviceId } = await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "333,33",
      zahlungsDatum: "10.04.2026",
    });
    expect((await getInvoiceStatus(invoiceId)).status).toBe("avis_erhalten");

    const res = await apiPost<{ paid: number }>(`/api/admin/qonto/payment-advices/${adviceId}/mark-paid`, {});
    expect(res.status).toBe(200);
    expect(res.data.paid).toBe(1);

    const inv = await getInvoiceStatus(invoiceId);
    expect(inv.status).toBe("bezahlt");
    expect(inv.paidAt).not.toBeNull();
    // paidAt = Zahlungsdatum 2026-04-10 (lokal).
    expect(inv.paidAt!.getFullYear()).toBe(2026);
    expect(inv.paidAt!.getMonth()).toBe(3); // April (0-indexed)
    expect(inv.paidAt!.getDate()).toBe(10);
    expect(await countAudit("invoice_payment_reconciled", invoiceId)).toBe(1);

    // Idempotenz: erneutes mark-paid → nichts mehr offen.
    const again = await apiPost<{ paid: number }>(`/api/admin/qonto/payment-advices/${adviceId}/mark-paid`, {});
    expect(again.data.paid).toBe(0);
  });

  it("Qonto-Match akzeptiert avis_erhalten → bezahlt; Unmatch fällt auf avis_erhalten zurück", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 44444, invoiceNumber: num });
    await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "444,44",
      zahlungsDatum: "12.04.2026",
    });
    expect((await getInvoiceStatus(invoiceId)).status).toBe("avis_erhalten");

    const txId = await insertQontoTx({ amountCents: 44444 });
    const matchRes = await apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
    expect(matchRes.status).toBe(200);
    expect((await getInvoiceStatus(invoiceId)).status).toBe("bezahlt");

    // Unmatch: Avis ist noch aktiv → zurück auf avis_erhalten, nicht versendet.
    const unmatchRes = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatchRes.status).toBe(200);
    const inv = await getInvoiceStatus(invoiceId);
    expect(inv.status).toBe("avis_erhalten");
    expect(inv.paidAt).toBeNull();
  });

  it("Löschen des Avis nimmt avis_erhalten → versendet zurück (Audit invoice_avis_reverted)", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 55555, invoiceNumber: num });
    const { adviceId } = await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "555,55",
      zahlungsDatum: "14.04.2026",
    });
    expect((await getInvoiceStatus(invoiceId)).status).toBe("avis_erhalten");

    const delRes = await apiDelete(`/api/admin/qonto/payment-advices/${adviceId}`);
    expect(delRes.status).toBe(200);

    const inv = await getInvoiceStatus(invoiceId);
    expect(inv.status).toBe("versendet");
    expect(await countAudit("invoice_avis_reverted", invoiceId)).toBe(1);
  });

  it("Löschen des Avis lässt bereits bezahlte Rechnung unangetastet", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 66666, invoiceNumber: num });
    const { adviceId } = await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "666,66",
      zahlungsDatum: "16.04.2026",
    });
    // Avis als bezahlt markieren → bezahlt.
    await apiPost(`/api/admin/qonto/payment-advices/${adviceId}/mark-paid`, {});
    expect((await getInvoiceStatus(invoiceId)).status).toBe("bezahlt");

    const delRes = await apiDelete(`/api/admin/qonto/payment-advices/${adviceId}`);
    expect(delRes.status).toBe(200);

    expect((await getInvoiceStatus(invoiceId)).status).toBe("bezahlt");
    expect(await countAudit("invoice_avis_reverted", invoiceId)).toBe(0);
  });

  it("GET /payment-advices reichert matchedInvoiceCount + unpaidMatchedCount an", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    await insertInvoice({ amountCents: 7000, invoiceNumber: numA });
    await insertInvoice({ amountCents: 7000, invoiceNumber: numB });
    const { adviceId } = await createAdviceWithCsv({
      invoiceNumbers: [numA, numB],
      amountEuro: "70,00",
      zahlungsDatum: "18.04.2026",
    });

    const res = await apiGet<Array<{ id: number; matchedInvoiceCount: number; unpaidMatchedCount: number }>>(
      "/api/admin/qonto/payment-advices",
    );
    expect(res.status).toBe(200);
    const advice = res.data.find(a => a.id === adviceId);
    expect(advice).toBeDefined();
    expect(advice!.matchedInvoiceCount).toBe(2);
    expect(advice!.unpaidMatchedCount).toBe(2);

    // Nach mark-paid sinkt unpaidMatchedCount auf 0.
    await apiPost(`/api/admin/qonto/payment-advices/${adviceId}/mark-paid`, {});
    const res2 = await apiGet<Array<{ id: number; matchedInvoiceCount: number; unpaidMatchedCount: number }>>(
      "/api/admin/qonto/payment-advices",
    );
    const advice2 = res2.data.find(a => a.id === adviceId);
    expect(advice2!.matchedInvoiceCount).toBe(2);
    expect(advice2!.unpaidMatchedCount).toBe(0);
  });
});
