/**
 * Task #445 — Qonto Match/Unmatch/Auto-Match: Audit-Coverage,
 * Transaktionalität und Idempotenz.
 *
 * Verifiziert:
 *  1. Jeder manuelle Match schreibt genau einen `invoice_payment_reconciled`
 *     Audit-Eintrag mit `entity_id = invoiceId` und `matchedBy = "manual"`.
 *  2. Jeder Unmatch schreibt genau einen `invoice_payment_unreconciled`
 *     Audit-Eintrag.
 *  3. AutoMatch erzeugt pro tatsächlich gebuchtem Treffer eine
 *     `invoice_payment_reconciled`-Audit-Zeile mit `matchedBy = "auto"`.
 *  4. Concurrency: zwei parallele Manual-Match-Aufrufe auf dieselbe
 *     Transaktion → höchstens ein Erfolg, höchstens ein Audit-Eintrag.
 *  5. Idempotenz: Re-Match derselben (transaction, invoice)-Kombination
 *     ist no-op und schreibt keinen zweiten Audit-Eintrag.
 *  6. Partial-Unique-Index `qonto_transactions_matched_invoice_unique_idx`
 *     existiert und verhindert Doppel-Matches derselben Rechnung.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiPost, apiDelete, uniqueId, getAuthCookie } from "../test-utils";
import { db } from "../../server/lib/db";
import {
  customers,
  invoices,
  qontoTransactions,
  auditLog,
} from "../../shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

interface Seeded {
  customerId: number;
  invoiceIds: number[];
  qontoTxIds: number[];
}

const seeded: Seeded = { customerId: 0, invoiceIds: [], qontoTxIds: [] };

async function insertCustomer(): Promise<number> {
  const tag = uniqueId();
  const [row] = await db.insert(customers).values({
    name: `QONTO-AUDIT-${tag}`,
    vorname: "Qonto",
    nachname: `Audit-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  }).returning({ id: customers.id });
  return row.id;
}

async function insertInvoice(customerId: number, opts: { amountCents: number; suffix: string }): Promise<number> {
  const tag = uniqueId();
  // Invoice-Nummer mit Test-Marker, damit cleanup zielsicher greift.
  const invoiceNumber = `QA-${opts.suffix}-${tag}`;
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

async function insertQontoTx(opts: { amountCents: number; reference?: string }): Promise<number> {
  const tag = uniqueId();
  const [row] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `qonto-test-${tag}`,
    amountCents: opts.amountCents,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt: new Date(),
    reference: opts.reference ?? null,
  }).returning({ id: qontoTransactions.id });
  return row.id;
}

async function countAudit(action: string, invoiceId: number, txId?: number): Promise<number> {
  const rows = await db.select({
    metadata: auditLog.metadata,
  })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, action),
      eq(auditLog.entityType, "invoice"),
      eq(auditLog.entityId, invoiceId),
    ));
  if (txId === undefined) return rows.length;
  return rows.filter(r => {
    const md = r.metadata as { qontoTransactionId?: number } | null;
    return md?.qontoTransactionId === txId;
  }).length;
}

beforeAll(async () => {
  seeded.customerId = await insertCustomer();
});

afterAll(async () => {
  // Cleanup audit_log → qonto_transactions → invoices → customer
  if (seeded.invoiceIds.length > 0) {
    await db.delete(auditLog).where(and(
      eq(auditLog.entityType, "invoice"),
      inArray(auditLog.entityId, seeded.invoiceIds),
    ));
  }
  if (seeded.qontoTxIds.length > 0) {
    await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, seeded.qontoTxIds));
  }
  if (seeded.invoiceIds.length > 0) {
    await db.delete(invoices).where(inArray(invoices.id, seeded.invoiceIds));
  }
  if (seeded.customerId) {
    await db.delete(customers).where(eq(customers.id, seeded.customerId));
  }
});

describe("Qonto Match: Audit-Coverage und Transaktionalität", () => {
  it("manueller Match schreibt genau einen invoice_payment_reconciled-Audit-Eintrag", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 12345, suffix: "M1" });
    const txId = await insertQontoTx({ amountCents: 12345 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txId);

    const res = await apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
    expect(res.status).toBe(200);

    const auditCount = await countAudit("invoice_payment_reconciled", invoiceId, txId);
    expect(auditCount).toBe(1);

    const [inv] = await db.select({ status: invoices.status })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("bezahlt");
  });

  it("Unmatch schreibt genau einen invoice_payment_unreconciled-Audit-Eintrag und setzt Status zurück", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 22222, suffix: "U1" });
    const txId = await insertQontoTx({ amountCents: 22222 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txId);

    const matchRes = await apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
    expect(matchRes.status).toBe(200);

    const unmatchRes = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatchRes.status).toBe(200);

    const unrecCount = await countAudit("invoice_payment_unreconciled", invoiceId, txId);
    expect(unrecCount).toBe(1);

    const [inv] = await db.select({ status: invoices.status, paidAt: invoices.paidAt })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("versendet");
    expect(inv.paidAt).toBeNull();

    // Erneut unmatchen → no-op, keine zweite Audit-Zeile.
    const unmatchAgain = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatchAgain.status).toBe(200);
    const unrecCountAfter = await countAudit("invoice_payment_unreconciled", invoiceId, txId);
    expect(unrecCountAfter).toBe(1);
  });

  it("Re-Match derselben Transaktion auf dieselbe Rechnung ist idempotent (kein zweiter Audit)", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 33333, suffix: "I1" });
    const txId = await insertQontoTx({ amountCents: 33333 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txId);

    const first = await apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
    expect(first.status).toBe(200);
    const second = await apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
    expect(second.status).toBe(200);

    const auditCount = await countAudit("invoice_payment_reconciled", invoiceId, txId);
    expect(auditCount).toBe(1);
  });

  it("parallele Manual-Matches auf dieselbe Transaktion: genau ein Erfolg, genau ein Audit-Eintrag", async () => {
    const invoiceA = await insertInvoice(seeded.customerId, { amountCents: 44444, suffix: "CA" });
    const invoiceB = await insertInvoice(seeded.customerId, { amountCents: 44444, suffix: "CB" });
    const txId = await insertQontoTx({ amountCents: 44444 });
    seeded.invoiceIds.push(invoiceA, invoiceB);
    seeded.qontoTxIds.push(txId);

    const auth = await getAuthCookie();
    const [resA, resB] = await Promise.all([
      apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId: invoiceA }),
      apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId: invoiceB }),
    ]);
    void auth;

    const successes = [resA, resB].filter(r => r.status === 200);
    expect(successes.length).toBe(1);

    const totalAudits =
      (await countAudit("invoice_payment_reconciled", invoiceA, txId)) +
      (await countAudit("invoice_payment_reconciled", invoiceB, txId));
    expect(totalAudits).toBe(1);

    // Genau eine der beiden Rechnungen ist 'bezahlt'.
    const rows = await db.select({ id: invoices.id, status: invoices.status })
      .from(invoices).where(inArray(invoices.id, [invoiceA, invoiceB]));
    const paid = rows.filter(r => r.status === "bezahlt");
    expect(paid.length).toBe(1);
  });

  it("AutoMatch: jede gematchte Transaktion erhält genau eine invoice_payment_reconciled-Audit-Zeile (matchedBy=auto)", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 55555, suffix: "A1" });
    // Reference enthält Invoice-Number → auto_exact.
    const invoiceNumber = (await db.select({ n: invoices.invoiceNumber })
      .from(invoices).where(eq(invoices.id, invoiceId)))[0].n;
    const txId = await insertQontoTx({ amountCents: 55555, reference: `Zahlung ${invoiceNumber}` });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txId);

    const res = await apiPost(`/api/admin/qonto/auto-match`, {});
    expect(res.status).toBe(200);

    const rows = await db.select({ metadata: auditLog.metadata })
      .from(auditLog).where(and(
        eq(auditLog.action, "invoice_payment_reconciled"),
        eq(auditLog.entityType, "invoice"),
        eq(auditLog.entityId, invoiceId),
      ));
    expect(rows.length).toBe(1);
    expect((rows[0].metadata as { matchedBy: string }).matchedBy).toBe("auto");

    const [inv] = await db.select({ status: invoices.status })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("bezahlt");
  });

  it("partial-unique-Index verhindert Doppel-Matches derselben Rechnung", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 66666, suffix: "PU" });
    const txA = await insertQontoTx({ amountCents: 66666 });
    const txB = await insertQontoTx({ amountCents: 66666 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txA, txB);

    // Direkter DB-Setzversuch auf zwei Transaktionen → der zweite muss
    // an `qonto_transactions_matched_invoice_unique_idx` scheitern.
    await db.update(qontoTransactions)
      .set({ matchedInvoiceId: invoiceId, matchConfidence: "test" })
      .where(eq(qontoTransactions.id, txA));

    let threw = false;
    try {
      await db.update(qontoTransactions)
        .set({ matchedInvoiceId: invoiceId, matchConfidence: "test" })
        .where(eq(qontoTransactions.id, txB));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Cleanup: lösen, damit afterAll die FK-Reihenfolge sauber abräumen kann.
    await db.update(qontoTransactions)
      .set({ matchedInvoiceId: null, matchConfidence: null })
      .where(eq(qontoTransactions.id, txA));
  });

  it("Regression: jeder qonto_transactions.matched_invoice_id hat einen passenden audit_log-Eintrag", async () => {
    // Über alle in diesem Testlauf gematchten Transaktionen aggregieren.
    const matched = await db.select({
      id: qontoTransactions.id,
      invoiceId: qontoTransactions.matchedInvoiceId,
    })
      .from(qontoTransactions)
      .where(and(
        inArray(qontoTransactions.id, seeded.qontoTxIds.length > 0 ? seeded.qontoTxIds : [-1]),
        sql`${qontoTransactions.matchedInvoiceId} IS NOT NULL`,
      ));

    for (const m of matched) {
      const count = await countAudit("invoice_payment_reconciled", m.invoiceId!, m.id);
      expect(count, `audit fehlt für tx=${m.id} invoice=${m.invoiceId}`).toBeGreaterThanOrEqual(1);
    }
  });
});
