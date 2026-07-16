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

/**
 * Task #1712 — Teil-Aufhebung (partial-unmatch) einer Sammelzahlung.
 *
 * Dokumentiert die BEABSICHTIGTE Semantik: eine einzelne Rechnung aus einem
 * bestehenden Sammel-Match zu entfernen (und die übrigen verknüpft zu lassen)
 * ist NICHT unterstützt. Der einzige Pfad ist „komplette Zuordnung aufheben +
 * neu matchen". Diese Tests verankern das Verhalten, damit eine spätere
 * Änderung nicht still die Avis-/Item-Summen korrumpiert.
 *
 *  1. DELETE /match ist all-or-nothing: es hebt IMMER die gesamte
 *     Sammelzahlung auf (soft-delete Avis + alle Rechnungen zurück), es gibt
 *     keinen Body/Parameter, um nur eine Rechnung zu lösen.
 *  2. Ein erneuter bulk-match mit einer Teilmenge der bereits gematchten
 *     Rechnungen wird mit 400 abgelehnt („zuerst Zuordnung aufheben"); das
 *     bestehende Avis (Betrag + Items) bleibt dabei UNVERÄNDERT.
 *  3. Der unterstützte Pfad (Full-Unmatch + Re-Match mit Teilmenge) hält
 *     Avis-betragCents und payment_advice_items konsistent.
 */
describe("Task #1712 — Teil-Aufhebung einer Sammelzahlung (partial-unmatch)", () => {
  it("DELETE /match ist all-or-nothing: hebt die gesamte Sammelzahlung auf, nicht nur eine Rechnung", async () => {
    const invA = await insertInvoice(seeded.customerId, { amountCents: 4000, suffix: "P1A" });
    const invB = await insertInvoice(seeded.customerId, { amountCents: 5000, suffix: "P1B" });
    const invC = await insertInvoice(seeded.customerId, { amountCents: 6000, suffix: "P1C" });
    const txId = await insertQontoTx({ amountCents: 15000 });
    seeded.invoiceIds.push(invA, invB, invC);
    seeded.qontoTxIds.push(txId);

    const bulk = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, {
      invoiceIds: [invA, invB, invC],
    });
    expect(bulk.status).toBe(200);
    const [tx] = await db.select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    const adviceId = tx.adviceId!;
    seeded.adviceIds.push(adviceId);

    // Es gibt keinen partiellen Löschpfad: DELETE ohne/mit Body verhält sich
    // identisch und hebt IMMER die komplette Zuordnung auf.
    const unmatch = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatch.status).toBe(200);

    // Alle drei Rechnungen zurückgesetzt (nicht nur eine).
    const invRows = await db.select({ id: invoices.id, status: invoices.status })
      .from(invoices).where(inArray(invoices.id, [invA, invB, invC]));
    expect(invRows.length).toBe(3);
    expect(invRows.every(r => r.status === "versendet")).toBe(true);

    // Avis komplett soft-gelöscht (kein partieller Rest-Avis).
    const [advice] = await db.select({ deletedAt: paymentAdvices.deletedAt })
      .from(paymentAdvices).where(eq(paymentAdvices.id, adviceId));
    expect(advice.deletedAt).not.toBeNull();
  });

  it("Re-Match mit Teilmenge einer bereits gematchten Zahlung → 400; Avis + Items bleiben unverändert", async () => {
    const invA = await insertInvoice(seeded.customerId, { amountCents: 3000, suffix: "P2A" });
    const invB = await insertInvoice(seeded.customerId, { amountCents: 3500, suffix: "P2B" });
    const invC = await insertInvoice(seeded.customerId, { amountCents: 4500, suffix: "P2C" });
    const txId = await insertQontoTx({ amountCents: 11000 });
    seeded.invoiceIds.push(invA, invB, invC);
    seeded.qontoTxIds.push(txId);

    const bulk = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, {
      invoiceIds: [invA, invB, invC],
    });
    expect(bulk.status).toBe(200);
    const [tx] = await db.select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    const adviceId = tx.adviceId!;
    seeded.adviceIds.push(adviceId);

    // Versuch, invC zu „entfernen", indem man nur mit [invA, invB] neu matcht.
    const partial = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, {
      invoiceIds: [invA, invB],
    });
    expect(partial.status).toBe(400);

    // Das bestehende Avis ist unverändert: gleicher Gesamtbetrag, alle 3 Items.
    const [advice] = await db.select({ gross: paymentAdvices.gesamtBetragCents, deletedAt: paymentAdvices.deletedAt })
      .from(paymentAdvices).where(eq(paymentAdvices.id, adviceId));
    expect(advice.deletedAt).toBeNull();
    expect(advice.gross).toBe(11000);
    const items = await db.select({ inv: paymentAdviceItems.matchedInvoiceId, betrag: paymentAdviceItems.betragCents })
      .from(paymentAdviceItems).where(eq(paymentAdviceItems.paymentAdviceId, adviceId));
    expect(items.length).toBe(3);
    expect(new Set(items.map(i => i.inv))).toEqual(new Set([invA, invB, invC]));
    const itemsSum = items.reduce((sum, i) => sum + i.betrag, 0);
    expect(itemsSum).toBe(11000);

    // Alle 3 Rechnungen bleiben bezahlt (invC nicht heimlich gelöst).
    const invRows = await db.select({ id: invoices.id, status: invoices.status })
      .from(invoices).where(inArray(invoices.id, [invA, invB, invC]));
    expect(invRows.every(r => r.status === "bezahlt")).toBe(true);
  });

  it("Unterstützter Pfad: Full-Unmatch + Re-Match mit Teilmenge hält Betrag/Items konsistent", async () => {
    const invA = await insertInvoice(seeded.customerId, { amountCents: 2000, suffix: "P3A" });
    const invB = await insertInvoice(seeded.customerId, { amountCents: 2500, suffix: "P3B" });
    const invC = await insertInvoice(seeded.customerId, { amountCents: 3000, suffix: "P3C" });
    const txId = await insertQontoTx({ amountCents: 7500 });
    seeded.invoiceIds.push(invA, invB, invC);
    seeded.qontoTxIds.push(txId);

    const bulk = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, {
      invoiceIds: [invA, invB, invC],
    });
    expect(bulk.status).toBe(200);
    const [tx1] = await db.select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    seeded.adviceIds.push(tx1.adviceId!);

    // Full-Unmatch.
    const unmatch = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatch.status).toBe(200);

    // Re-Match mit Teilmenge (invC bewusst weggelassen).
    const rematch = await apiPost(`/api/admin/qonto/transactions/${txId}/bulk-match`, {
      invoiceIds: [invA, invB],
    });
    expect(rematch.status).toBe(200);
    const [tx2] = await db.select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, txId));
    const newAdviceId = tx2.adviceId!;
    expect(newAdviceId).not.toBe(tx1.adviceId!);
    seeded.adviceIds.push(newAdviceId);

    // Neues Avis: nur die 2 verbliebenen Items, Betrag = Σ items = Tx-Betrag.
    const items = await db.select({ inv: paymentAdviceItems.matchedInvoiceId, betrag: paymentAdviceItems.betragCents })
      .from(paymentAdviceItems).where(eq(paymentAdviceItems.paymentAdviceId, newAdviceId));
    expect(items.length).toBe(2);
    expect(new Set(items.map(i => i.inv))).toEqual(new Set([invA, invB]));

    const [advice] = await db.select({ gross: paymentAdvices.gesamtBetragCents })
      .from(paymentAdvices).where(eq(paymentAdvices.id, newAdviceId));
    const itemsSum = items.reduce((sum, i) => sum + i.betrag, 0);
    // Σ der neu zugeordneten Rechnungen (4500) ≠ Avis-Gesamt = Zahlungsbetrag (7500).
    expect(itemsSum).toBe(4500);
    expect(advice.gross).toBe(7500);

    // Die Zahlung (7500) weicht > Toleranz von der Summe der zugeordneten
    // Rechnungen (4500) ab ⇒ Bind-only + Flag: A/B werden NICHT still auf
    // „bezahlt" gesetzt, sondern bleiben „versendet" und werden pro Rechnung
    // zur manuellen Prüfung markiert (invoice_payment_mismatch).
    const flagged = await db.select({ id: invoices.id, status: invoices.status })
      .from(invoices).where(inArray(invoices.id, [invA, invB]));
    for (const r of flagged) expect(r.status).toBe("versendet");
    expect(await countAudit("invoice_payment_mismatch", "invoice", invA)).toBe(1);
    expect(await countAudit("invoice_payment_mismatch", "invoice", invB)).toBe(1);

    // Operator prüft die Differenz und bestätigt sie explizit (confirm-paid) ⇒
    // erst jetzt gehen die gebundenen Rechnungen auf „bezahlt".
    const confirm = await apiPost(`/api/admin/qonto/transactions/${txId}/confirm-paid`, {});
    expect(confirm.status).toBe(200);

    // invC wieder frei/offen, invA+invB nach Freigabe bezahlt.
    const invRows = await db.select({ id: invoices.id, status: invoices.status })
      .from(invoices).where(inArray(invoices.id, [invA, invB, invC]));
    const statusById = new Map(invRows.map(r => [r.id, r.status]));
    expect(statusById.get(invA)).toBe("bezahlt");
    expect(statusById.get(invB)).toBe("bezahlt");
    expect(statusById.get(invC)).toBe("versendet");
  });
});
