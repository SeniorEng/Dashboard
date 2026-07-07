/**
 * Task #1685 — Admin-Auflösung mehrdeutiger Sammel-Avis ↔ Sammelzahlung-Matches.
 *
 * Deckt die beiden neuen Superadmin-Routen ab:
 *  GET  /api/admin/qonto/transactions/ambiguous-advices  — listet Avise, deren
 *       Sammelzahlungs-Zuordnung mehrdeutig ist (mehrere passende Gutschriften),
 *       inkl. der konkurrierenden Gutschriften. Nutzt dieselbe SSoT-Gate
 *       (`computeProposals`) wie der Backfill-Verifier.
 *  POST /api/admin/qonto/transactions/ambiguous-advices/:adviceId/resolve — bucht
 *       die vom Operator gewählte Gutschrift über den geteilten, geguardeten &
 *       auditierten Backfill-Linker (`applyProposals`).
 *
 * Verifiziert:
 *  (a) Mehrere passende Gutschriften ⇒ Avis erscheint als mehrdeutig mit allen
 *      Kandidaten.
 *  (b) Auflösen verknüpft genau die gewählte Gutschrift (matchedPaymentAdviceId +
 *      Backfill-Confidence), schreibt EIN GoBD-Audit, und das Avis verschwindet
 *      danach aus der Mehrdeutigkeits-Liste.
 *  (c) Ein zweiter Auflöse-Versuch auf dasselbe (jetzt zugeordnete) Avis ⇒ 400.
 *  (d) Auflösen mit einer Gutschrift, die kein Kandidat (mehr) ist ⇒ 400, kein
 *      Schreibvorgang.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiGet, apiPost, uniqueId } from "../test-utils";
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
import { BACKFILL_MATCH_CONFIDENCE } from "../../scripts/verify-advice-backfill";

interface AmbiguousCreditDto {
  txId: number;
  txAmountCents: number;
  txEmittedAt: string;
  daysDelta: number;
  txCounterpartyName: string | null;
  txSourceIban: string | null;
  nameMatchesAdvisory: boolean;
}
interface AmbiguousAdviceDto {
  adviceId: number;
  reason: "multiple_credits" | "credit_collision";
  candidates: AmbiguousCreditDto[];
  collidingAdviceIds: number[];
}

const seeded = { customerId: 0, invoiceIds: [] as number[], qontoTxIds: [] as number[], adviceIds: [] as number[] };

let invoiceCounter = 60000 + Math.floor(Math.random() * 30000);
function nextInvoiceNumber(): string {
  invoiceCounter += 1;
  return `RE-2026-${invoiceCounter}`;
}
function centsToEuro(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

const IBAN = "DE02120300000000202051";

async function insertInvoice(amountCents: number, invoiceNumber: string): Promise<number> {
  const [row] = await db.insert(invoices).values({
    invoiceNumber,
    customerId: seeded.customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: 4,
    billingYear: 2026,
    recipientName: "Test",
    grossAmountCents: amountCents,
    netAmountCents: amountCents,
    status: "versendet",
  }).returning({ id: invoices.id });
  seeded.invoiceIds.push(row.id);
  return row.id;
}

async function insertCredit(amountCents: number, emittedAt: Date, counterpartyName?: string): Promise<number> {
  const [row] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `qonto-ambig-test-${uniqueId()}`,
    amountCents,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt,
    sourceIban: IBAN,
    counterpartyName: counterpartyName ?? null,
  }).returning({ id: qontoTransactions.id });
  seeded.qontoTxIds.push(row.id);
  return row.id;
}

function buildAvisCsv(items: Array<{ num: string; cents: number }>, totalCents: number, zahlungsDatum: string): string {
  const lines = ["1;IK123456789"];
  for (const it of items) {
    lines.push(`2;Sammelueberweisung;${it.num};${zahlungsDatum};${centsToEuro(it.cents)}`);
  }
  lines.push(`3;BELEG-${uniqueId()};${zahlungsDatum};${centsToEuro(totalCents)};${IBAN}`);
  return lines.join("\n");
}

/** Legt ein Avis an und markiert seine Rechnungen als bezahlt (⇒ „fully paid, unlinked"). */
async function createFullyPaidAdvice(items: Array<{ num: string; cents: number; invoiceId: number }>, totalCents: number, zahlungsDatum: string): Promise<number> {
  const csvContent = buildAvisCsv(items.map(i => ({ num: i.num, cents: i.cents })), totalCents, zahlungsDatum);
  const res = await apiPost<{ advice: { id: number }; matched: number }>(
    "/api/admin/qonto/payment-advices",
    { fileName: `ambig-avis-${uniqueId()}.csv`, csvContent },
  );
  expect(res.status).toBe(200);
  seeded.adviceIds.push(res.data.advice.id);

  await withGobdMutation((tx) =>
    tx.update(invoices)
      .set({ status: "bezahlt", paidAt: new Date(`${zahlungsDatum.split(".").reverse().join("-")}T12:00:00`) })
      .where(inArray(invoices.id, items.map(i => i.invoiceId))),
  );

  return res.data.advice.id;
}

beforeAll(async () => {
  const tag = uniqueId();
  const [row] = await db.insert(customers).values({
    name: `AMBIG-${tag}`,
    vorname: "Ambig",
    nachname: `Test-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  }).returning({ id: customers.id });
  seeded.customerId = row.id;
});

afterAll(async () => {
  for (const entityType of ["invoice", "payment_advice"] as const) {
    const ids = entityType === "invoice" ? seeded.invoiceIds : seeded.adviceIds;
    if (ids.length === 0) continue;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(and(eq(auditLog.entityType, entityType), inArray(auditLog.entityId, ids)));
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
    await withGobdMutation((tx) => tx.delete(invoices).where(inArray(invoices.id, seeded.invoiceIds)));
  }
  if (seeded.customerId) {
    await db.delete(customers).where(eq(customers.id, seeded.customerId));
  }
});

async function fetchAmbiguous(adviceId: number): Promise<AmbiguousAdviceDto | undefined> {
  const res = await apiGet<{ ambiguous: AmbiguousAdviceDto[] }>("/api/admin/qonto/transactions/ambiguous-advices");
  expect(res.status).toBe(200);
  return res.data.ambiguous.find(a => a.adviceId === adviceId);
}

describe("Task #1685 — Mehrdeutige Sammel-Avis-Zuordnung auflösen", () => {
  it("listet mehrdeutige Avise, löst über die gewählte Gutschrift auf und schreibt genau ein Audit", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const total = 90100;
    const invA = await insertInvoice(50100, numA);
    const invB = await insertInvoice(40000, numB);
    const adviceId = await createFullyPaidAdvice(
      [{ num: numA, cents: 50100, invoiceId: invA }, { num: numB, cents: 40000, invoiceId: invB }],
      total,
      "15.04.2026",
    );

    // Zwei passende Gutschriften (gleicher Betrag, IBAN, im Zeitfenster) ⇒ mehrdeutig.
    const txOne = await insertCredit(total, new Date("2026-04-16T10:00:00"));
    const txTwo = await insertCredit(total, new Date("2026-04-17T10:00:00"));

    // (a) beide Gutschriften erscheinen als Kandidaten.
    const entry = await fetchAmbiguous(adviceId);
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("multiple_credits");
    const candidateTxIds = entry!.candidates.map(c => c.txId).sort();
    expect(candidateTxIds).toEqual([txOne, txTwo].sort());

    // (b) Auflösen über txOne ⇒ verknüpft, Backfill-Confidence, ein Audit.
    const resolve = await apiPost(`/api/admin/qonto/transactions/ambiguous-advices/${adviceId}/resolve`, { txId: txOne });
    expect(resolve.status).toBe(200);

    const [linkedTx] = await db.select({
      matchedPaymentAdviceId: qontoTransactions.matchedPaymentAdviceId,
      matchConfidence: qontoTransactions.matchConfidence,
    }).from(qontoTransactions).where(eq(qontoTransactions.id, txOne));
    expect(linkedTx.matchedPaymentAdviceId).toBe(adviceId);
    expect(linkedTx.matchConfidence).toBe(BACKFILL_MATCH_CONFIDENCE);

    const [otherTx] = await db.select({ matchedPaymentAdviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, txTwo));
    expect(otherTx.matchedPaymentAdviceId).toBeNull();

    const auditRows = await db.select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.action, "advice_payment_reconciled"),
      eq(auditLog.entityType, "payment_advice"),
      eq(auditLog.entityId, adviceId),
    ));
    expect(auditRows.length).toBe(1);

    // Avis ist nicht mehr mehrdeutig.
    expect(await fetchAmbiguous(adviceId)).toBeUndefined();

    // (c) zweiter Auflöse-Versuch ⇒ 400 (nicht mehr mehrdeutig).
    const again = await apiPost(`/api/admin/qonto/transactions/ambiguous-advices/${adviceId}/resolve`, { txId: txTwo });
    expect(again.status).toBe(400);
  });

  it("(d) lehnt eine Gutschrift ab, die kein Kandidat des Avis ist", async () => {
    const numA = nextInvoiceNumber();
    const total = 33300;
    const invA = await insertInvoice(total, numA);
    const adviceId = await createFullyPaidAdvice(
      [{ num: numA, cents: total, invoiceId: invA }],
      total,
      "15.04.2026",
    );

    // Zwei passende Gutschriften ⇒ mehrdeutig …
    await insertCredit(total, new Date("2026-04-16T10:00:00"));
    await insertCredit(total, new Date("2026-04-17T10:00:00"));
    expect(await fetchAmbiguous(adviceId)).toBeDefined();

    // … aber ein betrags-fremder Kredit ist kein Kandidat.
    const strangerTx = await insertCredit(total + 5000, new Date("2026-04-16T10:00:00"));
    const res = await apiPost(`/api/admin/qonto/transactions/ambiguous-advices/${adviceId}/resolve`, { txId: strangerTx });
    expect(res.status).toBe(400);

    const [row] = await db.select({ matchedPaymentAdviceId: qontoTransactions.matchedPaymentAdviceId })
      .from(qontoTransactions).where(eq(qontoTransactions.id, strangerTx));
    expect(row.matchedPaymentAdviceId).toBeNull();
  });
});
