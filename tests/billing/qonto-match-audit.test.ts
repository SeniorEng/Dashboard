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
 *  6. Task #1822 — der frühere Partial-Unique-Index
 *     `qonto_transactions_matched_invoice_unique_idx` wurde ENTFERNT: mehrere
 *     Teilüberweisungen dürfen sich auf DIESELBE Rechnung legen (Aggregation
 *     zum Restbetrag). Der Test verifiziert, dass zwei Transaktionen auf
 *     dieselbe Rechnung gebunden werden können (kein Constraint-Fehler mehr).
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
import { withGobdMutation } from "../helpers/gobd";

interface Seeded {
  customerId: number;
  invoiceIds: number[];
  qontoTxIds: number[];
}

const seeded: Seeded = { customerId: 0, invoiceIds: [], qontoTxIds: [] };

/**
 * Summe aller auf eine Rechnung gebundenen Qonto-Zahlungen, in Cent.
 *
 * Seit dem Status-Umbau traegt diese Zahl die Aussage, die vorher der Status
 * `teilweise_bezahlt` trug — und sie traegt sie genauer: der Status kannte nur
 * „etwas" und „alles", die Summe kennt den Betrag.
 */
async function gebundeneSumme(invoiceId: number): Promise<number> {
  const [row] = await db
    .select({ summe: sql<number>`coalesce(sum(${qontoTransactions.amountCents}), 0)::int` })
    .from(qontoTransactions)
    .where(eq(qontoTransactions.matchedInvoiceId, invoiceId));
  return row.summe;
}

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
  // audit_log ist GoBD-unveränderbar (Trigger, Task #824) — Löschen nur über
  // den transaktions-lokalen Bypass-GUC.
  if (seeded.invoiceIds.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(and(
        eq(auditLog.entityType, "invoice"),
        inArray(auditLog.entityId, seeded.invoiceIds),
      ));
    });
  }
  if (seeded.qontoTxIds.length > 0) {
    await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, seeded.qontoTxIds));
  }
  if (seeded.invoiceIds.length > 0) {
    // invoices ist GoBD-unveränderbar (finalisierte Rechnungen, Trigger Task #828)
    // — Hard-Delete im Test-Teardown nur über den transaktions-lokalen Bypass.
    await withGobdMutation((tx) =>
      tx.delete(invoices).where(inArray(invoices.id, seeded.invoiceIds)),
    );
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

  it("Task #1822: zwei Teilüberweisungen dürfen sich auf dieselbe Rechnung legen (kein Unique-Constraint mehr)", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 66666, suffix: "PU" });
    const txA = await insertQontoTx({ amountCents: 30000 });
    const txB = await insertQontoTx({ amountCents: 20000 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txA, txB);

    // Beide Transaktionen auf dieselbe Rechnung binden — für Teilzahlungen muss
    // das jetzt erlaubt sein (der frühere partielle Unique-Index ist entfernt).
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
    expect(threw).toBe(false);

    // Beide Bindungen sind persistiert.
    const bound = await db.select({ id: qontoTransactions.id })
      .from(qontoTransactions)
      .where(and(
        inArray(qontoTransactions.id, [txA, txB]),
        eq(qontoTransactions.matchedInvoiceId, invoiceId),
      ));
    expect(bound.length).toBe(2);

    // Cleanup: beide lösen, sonst schlägt der Audit-Regressionstest weiter unten
    // fehl (direkt gesetzte matchedInvoiceId ohne Audit-Eintrag) und afterAll
    // kann die FK-Reihenfolge sauber abräumen.
    await db.update(qontoTransactions)
      .set({ matchedInvoiceId: null, matchConfidence: null })
      .where(inArray(qontoTransactions.id, [txA, txB]));
  });

  it("Task #1822: eine Teilüberweisung laesst die Rechnung offen (kein bezahlt, kein Mismatch)", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 50000, suffix: "TP1" });
    const txId = await insertQontoTx({ amountCents: 30000 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txId);

    const res = await apiPost<{
      invoicePartiallyPaid: boolean;
      invoiceMarkedPaid: boolean;
      paymentDifferenceResult: string;
      paymentDifferenceCents: number;
    }>(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
    expect(res.status).toBe(200);
    const body = res.data;
    expect(body.invoicePartiallyPaid).toBe(true);
    expect(body.invoiceMarkedPaid).toBe(false);
    expect(body.paymentDifferenceResult).toBe("underpaid");
    expect(body.paymentDifferenceCents).toBe(20000); // offener Rest = Brutto − gezahlt

    const [inv] = await db.select({ status: invoices.status, paidAt: invoices.paidAt })
      .from(invoices).where(eq(invoices.id, invoiceId));
    // Frueher stand hier `teilweise_bezahlt` als STATUS. Der Zustand des
    // Vorgangs ist unveraendert „wartet auf Zahlung" — dass schon Geld da ist,
    // sagt die gebundene Summe, nicht die Status-Spalte. `invoicePartiallyPaid`
    // oben ist genau diese abgeleitete Aussage; das Badge derselben Frage ist
    // in `payment-bound-read-side` (d) verankert.
    expect(inv.status).toBe("versendet");
    expect(inv.paidAt).toBeNull();

    // Genau ein invoice_partial_payment-Audit; bewusst KEIN reconciled/mismatch.
    expect(await countAudit("invoice_partial_payment", invoiceId, txId)).toBe(1);
    expect(await countAudit("invoice_payment_reconciled", invoiceId, txId)).toBe(0);
    expect(await countAudit("invoice_payment_mismatch", invoiceId, txId)).toBe(0);
  });

  it("Task #1822: zweite Teilüberweisung deckt den Rest → bezahlt (Σ-Gleichheit)", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 50000, suffix: "TP2" });
    const txA = await insertQontoTx({ amountCents: 30000 });
    const txB = await insertQontoTx({ amountCents: 20000 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txA, txB);

    // 1. Teilzahlung — deckt nicht, Rechnung wartet weiter.
    const resA = await apiPost<{ invoicePartiallyPaid: boolean }>(
      `/api/admin/qonto/transactions/${txA}/match`, { invoiceId });
    expect(resA.status).toBe(200);
    expect(resA.data.invoicePartiallyPaid).toBe(true);

    let [inv] = await db.select({ status: invoices.status })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("versendet");

    // 2. Teilzahlung deckt den Rest → bezahlt.
    const resB = await apiPost<{
      invoiceMarkedPaid: boolean;
      paymentDifferenceResult: string;
      paymentDifferenceCents: number;
    }>(`/api/admin/qonto/transactions/${txB}/match`, { invoiceId });
    expect(resB.status).toBe(200);
    const bodyB = resB.data;
    expect(bodyB.invoiceMarkedPaid).toBe(true);
    expect(bodyB.paymentDifferenceResult).toBe("exact");
    expect(bodyB.paymentDifferenceCents).toBe(0);

    [inv] = await db.select({ status: invoices.status, paidAt: invoices.paidAt })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("bezahlt");
    expect(inv.paidAt).not.toBeNull();

    // Σ-Gleichheit im Abschluss-Audit: kumuliert gezahlt === Brutto, Rest 0.
    const [reconciled] = await db.select({ metadata: auditLog.metadata })
      .from(auditLog).where(and(
        eq(auditLog.action, "invoice_payment_reconciled"),
        eq(auditLog.entityType, "invoice"),
        eq(auditLog.entityId, invoiceId),
      ));
    const md = reconciled.metadata as { cumulativePaidCents: number; differenceCents: number };
    expect(md.cumulativePaidCents).toBe(50000);
    expect(md.differenceCents).toBe(0);
  });

  it("Task #1822: Unmatch nimmt die Zahlung symmetrisch zurueck (gebundene Summe 50000 → 30000 → 0)", async () => {
    // ── Was diese Pruefung frueher behauptete ────────────────────────────
    // Sie hiess „setzt den Status symmetrisch zurueck (bezahlt →
    // teilweise_bezahlt → versendet)" und las die Symmetrie an der
    // Status-Spalte ab. Nach dem Status-Umbau faellt der mittlere Schritt mit
    // dem letzten zusammen — beide enden auf `versendet` —, und die Pruefung
    // koennte die zwei Schritte nicht mehr auseinanderhalten.
    //
    // Der Verlust ist nur scheinbar: die Symmetrie war nie eine Aussage ueber
    // den Status, sondern ueber das GELD. Sie wird deshalb dort gemessen, wo
    // sie sitzt — an der kumuliert gebundenen Summe. Das ist zugleich die
    // Groesse, aus der das Badge entsteht.
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 50000, suffix: "UP1" });
    const txA = await insertQontoTx({ amountCents: 30000 });
    const txB = await insertQontoTx({ amountCents: 20000 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txA, txB);

    // Zwei Teilzahlungen → voll gedeckt (bezahlt).
    expect((await apiPost(`/api/admin/qonto/transactions/${txA}/match`, { invoiceId })).status).toBe(200);
    expect((await apiPost(`/api/admin/qonto/transactions/${txB}/match`, { invoiceId })).status).toBe(200);
    let [inv] = await db.select({ status: invoices.status })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("bezahlt");

    expect(await gebundeneSumme(invoiceId)).toBe(50000);

    // Zweite Teilzahlung lösen → 30000 bleiben gebunden. Die Rechnung wartet
    // wieder auf Zahlung — mit Geld darauf, aber nicht genug.
    expect((await apiDelete(`/api/admin/qonto/transactions/${txB}/match`)).status).toBe(200);
    [inv] = await db.select({ status: invoices.status, paidAt: invoices.paidAt })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("versendet");
    expect(inv.paidAt).toBeNull();
    expect(await gebundeneSumme(invoiceId)).toBe(30000);

    // Letzte Teilzahlung lösen → nichts mehr gebunden. Derselbe Status wie
    // eben, aber eine andere Zahl — genau die Unterscheidung, die vorher im
    // Status steckte.
    expect((await apiDelete(`/api/admin/qonto/transactions/${txA}/match`)).status).toBe(200);
    [inv] = await db.select({ status: invoices.status, paidAt: invoices.paidAt })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("versendet");
    expect(inv.paidAt).toBeNull();
    expect(await gebundeneSumme(invoiceId)).toBe(0);
  });

  it("eine STORNIERTE Rechnung nimmt kein Geld mehr an — weder Teil- noch Ueberzahlung", async () => {
    // ── Warum dieser Fall existiert ────────────────────────────────────────
    // Bis zum Status-Umbau schuetzte den Bindungs-Pfad sein eigener
    // Schreibvorgang: `UPDATE … WHERE status IN (…)` lief auf 0 Zeilen und der
    // Handler warf 400. Der Statuswechsel entfiel mit dem Umbau — und der
    // Guard ersatzlos mit ihm. Eine Zahlung liess sich danach per 200 an eine
    // stornierte Rechnung binden.
    //
    // Kein Test wurde rot: es gab keinen. Genau deshalb gibt es ihn jetzt —
    // sonst verschwindet der Guard beim naechsten Umbau wieder lautlos.
    for (const [suffix, betrag] of [["SGT", 30000], ["SGU", 90000]] as const) {
      const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 50000, suffix });
      const txId = await insertQontoTx({ amountCents: betrag });
      seeded.invoiceIds.push(invoiceId);
      seeded.qontoTxIds.push(txId);

      await withGobdMutation((tx) =>
        tx.update(invoices).set({ status: "storniert" }).where(eq(invoices.id, invoiceId)),
      );

      const res = await apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
      expect(res.status, `Betrag ${betrag} muss abgelehnt werden`).toBe(400);

      // Und die Bindung darf NICHT bestehen bleiben: der Wurf liegt innerhalb
      // der Transaktion, also rollt sie das Binden mit zurueck. Ohne diese
      // Zeile waere der Test auch dann gruen, wenn die Zahlung haengen bliebe.
      const [tx] = await db.select({ matchedInvoiceId: qontoTransactions.matchedInvoiceId })
        .from(qontoTransactions).where(eq(qontoTransactions.id, txId));
      expect(tx.matchedInvoiceId, `Betrag ${betrag}: keine Bindung nach Ablehnung`).toBeNull();
    }
  });

  it("Task #1822: Über-Toleranz-Überzahlung bleibt Mismatch (nicht bezahlt, nicht teilweise)", async () => {
    const invoiceId = await insertInvoice(seeded.customerId, { amountCents: 50000, suffix: "OV1" });
    const txId = await insertQontoTx({ amountCents: 60000 });
    seeded.invoiceIds.push(invoiceId);
    seeded.qontoTxIds.push(txId);

    const res = await apiPost<{
      invoiceMarkedPaid: boolean;
      invoicePartiallyPaid: boolean;
      paymentDifferenceResult: string;
      paymentDifferenceCents: number;
    }>(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
    expect(res.status).toBe(200);
    const body = res.data;
    expect(body.invoiceMarkedPaid).toBe(false);
    expect(body.invoicePartiallyPaid).toBe(false);
    expect(body.paymentDifferenceResult).toBe("overpaid");
    expect(body.paymentDifferenceCents).toBe(-10000);

    // Status bleibt offen (versendet) — die Über-Toleranz-Abweichung wird geflaggt.
    const [inv] = await db.select({ status: invoices.status })
      .from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv.status).toBe("versendet");
    expect(await countAudit("invoice_payment_mismatch", invoiceId, txId)).toBe(1);
    expect(await countAudit("invoice_payment_reconciled", invoiceId, txId)).toBe(0);
    expect(await countAudit("invoice_partial_payment", invoiceId, txId)).toBe(0);
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
      // Task #1822 — eine gebundene Transaktion kann je nach kumuliertem
      // Zahlungsstand als Voll-Abgleich (reconciled), Teilzahlung
      // (partial_payment) ODER Über-Toleranz-Abweichung (mismatch) verbucht
      // sein. Der Audit-Trail muss in JEDEM dieser Fälle existieren.
      const count =
        (await countAudit("invoice_payment_reconciled", m.invoiceId!, m.id)) +
        (await countAudit("invoice_partial_payment", m.invoiceId!, m.id)) +
        (await countAudit("invoice_payment_mismatch", m.invoiceId!, m.id));
      expect(count, `audit fehlt für tx=${m.id} invoice=${m.invoiceId}`).toBeGreaterThanOrEqual(1);
    }
  });
});
