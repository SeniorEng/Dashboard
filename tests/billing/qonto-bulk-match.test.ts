/**
 * Task #1710 — Manuelle Mehrfach-Zuordnung (Bulk-Match) einer Qonto-Zahlung zu
 * 2+ offenen Rechnungen über ein ad-hoc Sammel-Avis (format='manuell',
 * confidence='manual_bulk').
 *
 * Verifiziert:
 *  1. Bulk-Match verknüpft die Transaktion über `matched_payment_advice_id`,
 *     legt Avis + Items an, setzt alle Rechnungen auf 'bezahlt' und schreibt
 *     pro Rechnung eine `invoice_payment_reconciled`-Audit-Zeile (matchedBy =
 *     "manual_bulk") plus eine `advice_payment_reconciled`-Zeile.
 *  2. `/billing/open-for-match` blendet bereits beanspruchte Rechnungen aus.
 *  3. Idempotenz: erneuter Bulk-Match mit identischer Rechnungsmenge ist no-op.
 *  4. Guard: eine bereits (einzeln) gematchte Rechnung kann nicht gebulk-matcht
 *     werden.
 *  5. Unmatch eines ad-hoc Bulk-Avis soft-löscht das Avis, setzt die Rechnungen
 *     auf 'versendet' zurück und schreibt die Reversal-Audit-Zeilen.
 *  6. Schema-Validierung: weniger als 2 Rechnungen → 400.
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

async function insertCustomer(): Promise<number> {
  const tag = uniqueId();
  const [row] = await db.insert(customers).values({
    name: `QONTO-BULK-${tag}`,
    vorname: "Qonto",
    nachname: `Bulk-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  }).returning({ id: customers.id });
  return row.id;
}

async function insertInvoice(customerId: number, opts: { amountCents: number; suffix: string }): Promise<number> {
  const tag = uniqueId();
  const invoiceNumber = `QB-${opts.suffix}-${tag}`;
  const [row] = await db.insert(invoices).values({
    invoiceNumber,
    customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: 1,
    billingYear: 2026,
    recipientName: "Test",
    grossAmountCents: opts.amountCents,
    netAmountCents: opts.amountCents,
    status: "versendet",
  }).returning({ id: invoices.id });
  return row.id;
}

async function insertQontoTx(opts: { amountCents: number }): Promise<number> {
  const tag = uniqueId();
  const [row] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `qonto-bulk-test-${tag}`,
    amountCents: opts.amountCents,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt: new Date(),
  }).returning({ id: qontoTransactions.id });
  return row.id;
}

async function countAudit(action: string, entityType: string, entityId: number): Promise<number> {
  const rows = await db.select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, action),
      eq(auditLog.entityType, entityType),
      eq(auditLog.entityId, entityId),
    ));
  return rows.length;
}

beforeAll(async () => {
  seeded.customerId = await insertCustomer();
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
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(and(
        eq(auditLog.entityType, "payment_advice"),
        inArray(auditLog.entityId, seeded.adviceIds),
      ));
    });
  }
  if (seeded.qontoTxIds.length > 0) {
    await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, seeded.qontoTxIds));
  }
  if (seeded.adviceIds.length > 0) {
    await db.delete(paymentAdviceItems).where(inArray(paymentAdviceItems.paymentAdviceId, seeded.adviceIds));
    await db.delete(paymentAdvices).where(inArray(paymentAdvices.id, seeded.adviceIds));
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

describe("Task #1710 — Qonto Bulk-Match (manuelle Mehrfach-Zuordnung)", () => {
  it("verknüpft eine Zahlung mit 2 Rechnungen, legt Sammel-Avis an und schreibt Audits", async () => {
    const invA = await insertInvoice(seeded.customerId, { amountCents: 10000, suffix: "B1A" });
    const invB = await insertInvoice(seeded.customerId, { amountCents: 15000, suffix: "B1B" });
    const txId = await insertQontoTx({ amountCents: 25000 });
    seeded.invoiceIds.push(invA, invB);
    seeded.qontoTxIds.push(txId);

    const res = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, {
      invoiceIds: [invA, invB],
    });
    expect(res.status).toBe(200);

    const [tx] = await db.select({
      adviceId: qontoTransactions.matchedPaymentAdviceId,
      conf: qontoTransactions.matchConfidence,
      matchedInvoiceId: qontoTransactions.matchedInvoiceId,
    }).from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    expect(tx.adviceId).not.toBeNull();
    expect(tx.conf).toBe("manual_bulk");
    expect(tx.matchedInvoiceId).toBeNull();
    if (tx.adviceId) seeded.adviceIds.push(tx.adviceId);

    // Avis + Items korrekt.
    const [advice] = await db.select({ format: paymentAdvices.format, gross: paymentAdvices.gesamtBetragCents })
      .from(paymentAdvices).where(eq(paymentAdvices.id, tx.adviceId!));
    expect(advice.format).toBe("manuell");
    expect(advice.gross).toBe(25000);
    const items = await db.select({ inv: paymentAdviceItems.matchedInvoiceId, betrag: paymentAdviceItems.betragCents })
      .from(paymentAdviceItems).where(eq(paymentAdviceItems.paymentAdviceId, tx.adviceId!));
    expect(items.length).toBe(2);
    expect(new Set(items.map(i => i.inv))).toEqual(new Set([invA, invB]));

    // Rechnungen bezahlt.
    const invRows = await db.select({ id: invoices.id, status: invoices.status })
      .from(invoices).where(inArray(invoices.id, [invA, invB]));
    expect(invRows.every(r => r.status === "bezahlt")).toBe(true);

    // Audits: pro Rechnung eine reconciled-Zeile + eine advice-Zeile.
    expect(await countAudit("invoice_payment_reconciled", "invoice", invA)).toBe(1);
    expect(await countAudit("invoice_payment_reconciled", "invoice", invB)).toBe(1);
    expect(await countAudit("advice_payment_reconciled", "payment_advice", tx.adviceId!)).toBe(1);

    const [auditRow] = await db.select({ metadata: auditLog.metadata })
      .from(auditLog).where(and(
        eq(auditLog.action, "invoice_payment_reconciled"),
        eq(auditLog.entityType, "invoice"),
        eq(auditLog.entityId, invA),
      ));
    expect((auditRow.metadata as { matchedBy: string }).matchedBy).toBe("manual_bulk");
  });

  it("/billing/open-for-match blendet bereits beanspruchte Rechnungen aus", async () => {
    const invFree = await insertInvoice(seeded.customerId, { amountCents: 7000, suffix: "OFM-FREE" });
    const invA = await insertInvoice(seeded.customerId, { amountCents: 3000, suffix: "OFM-A" });
    const invB = await insertInvoice(seeded.customerId, { amountCents: 4000, suffix: "OFM-B" });
    const txId = await insertQontoTx({ amountCents: 7000 });
    seeded.invoiceIds.push(invFree, invA, invB);
    seeded.qontoTxIds.push(txId);

    const bulk = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, { invoiceIds: [invA, invB] });
    expect(bulk.status).toBe(200);
    const [tx] = await db.select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    if (tx.adviceId) seeded.adviceIds.push(tx.adviceId);

    const res = await apiGet<Array<{ id: number }>>(`/api/billing/open-for-match`);
    expect(res.status).toBe(200);
    const ids = new Set(res.data.map(inv => inv.id));
    expect(ids.has(invFree)).toBe(true);
    expect(ids.has(invA)).toBe(false);
    expect(ids.has(invB)).toBe(false);
  });

  it("erneuter Bulk-Match mit identischer Rechnungsmenge ist idempotent (no-op, keine doppelten Audits)", async () => {
    const invA = await insertInvoice(seeded.customerId, { amountCents: 5000, suffix: "ID-A" });
    const invB = await insertInvoice(seeded.customerId, { amountCents: 5000, suffix: "ID-B" });
    const txId = await insertQontoTx({ amountCents: 10000 });
    seeded.invoiceIds.push(invA, invB);
    seeded.qontoTxIds.push(txId);

    const first = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, { invoiceIds: [invA, invB] });
    expect(first.status).toBe(200);
    const [tx] = await db.select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    if (tx.adviceId) seeded.adviceIds.push(tx.adviceId);

    const second = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, { invoiceIds: [invB, invA] });
    expect(second.status).toBe(200);

    expect(await countAudit("invoice_payment_reconciled", "invoice", invA)).toBe(1);
    expect(await countAudit("invoice_payment_reconciled", "invoice", invB)).toBe(1);
  });

  it("Guard: eine bereits einzeln gematchte Rechnung kann nicht gebulk-matcht werden", async () => {
    const invMatched = await insertInvoice(seeded.customerId, { amountCents: 8000, suffix: "G-M" });
    const invOther = await insertInvoice(seeded.customerId, { amountCents: 2000, suffix: "G-O" });
    const singleTx = await insertQontoTx({ amountCents: 8000 });
    const bulkTx = await insertQontoTx({ amountCents: 10000 });
    seeded.invoiceIds.push(invMatched, invOther);
    seeded.qontoTxIds.push(singleTx, bulkTx);

    const single = await apiPost(`/api/admin/qonto/transactions/${singleTx}/match`, { invoiceId: invMatched });
    expect(single.status).toBe(200);

    const bulk = await apiPost(`/api/admin/qonto/transactions/${bulkTx}/bulk-match`, { invoiceIds: [invMatched, invOther] });
    expect(bulk.status).toBe(400);

    // invOther bleibt offen (Transaktion nicht verknüpft, kein Avis).
    const [tx] = await db.select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, bulkTx));
    expect(tx.adviceId).toBeNull();
    const [other] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invOther));
    expect(other.status).toBe("versendet");
  });

  it("Unmatch des ad-hoc Bulk-Avis soft-löscht das Avis und setzt Rechnungen auf versendet zurück", async () => {
    const invA = await insertInvoice(seeded.customerId, { amountCents: 6000, suffix: "UM-A" });
    const invB = await insertInvoice(seeded.customerId, { amountCents: 6000, suffix: "UM-B" });
    const txId = await insertQontoTx({ amountCents: 12000 });
    seeded.invoiceIds.push(invA, invB);
    seeded.qontoTxIds.push(txId);

    const bulk = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, { invoiceIds: [invA, invB] });
    expect(bulk.status).toBe(200);
    const [tx] = await db.select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    const adviceId = tx.adviceId!;
    seeded.adviceIds.push(adviceId);

    const unmatch = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatch.status).toBe(200);

    const [txAfter] = await db.select({
      adviceId: qontoTransactions.matchedPaymentAdviceId,
      conf: qontoTransactions.matchConfidence,
    }).from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    expect(txAfter.adviceId).toBeNull();
    expect(txAfter.conf).toBeNull();

    const [advice] = await db.select({ deletedAt: paymentAdvices.deletedAt })
      .from(paymentAdvices).where(eq(paymentAdvices.id, adviceId));
    expect(advice.deletedAt).not.toBeNull();

    const invRows = await db.select({ id: invoices.id, status: invoices.status, paidAt: invoices.paidAt })
      .from(invoices).where(inArray(invoices.id, [invA, invB]));
    expect(invRows.every(r => r.status === "versendet")).toBe(true);
    expect(invRows.every(r => r.paidAt === null)).toBe(true);

    expect(await countAudit("invoice_payment_unreconciled", "invoice", invA)).toBe(1);
    expect(await countAudit("invoice_payment_unreconciled", "invoice", invB)).toBe(1);
    expect(await countAudit("advice_payment_unreconciled", "payment_advice", adviceId)).toBe(1);
  });

  it("Schema-Validierung: weniger als 2 Rechnungen → 400", async () => {
    const inv = await insertInvoice(seeded.customerId, { amountCents: 1000, suffix: "V-1" });
    const txId = await insertQontoTx({ amountCents: 1000 });
    seeded.invoiceIds.push(inv);
    seeded.qontoTxIds.push(txId);

    const res = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, { invoiceIds: [inv] });
    expect(res.status).toBe(400);
  });
});
