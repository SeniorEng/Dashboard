/**
 * Task #1864 — Qonto Betrags-Match absichern (Fehl-Match über gleichen Betrag
 * verhindern), End-to-End über die Auto-Match-Route.
 *
 * Realer Bug: Eine AOK-Zahlung über 77,40 € für „Popp, J." (04-2026) wurde nur
 * wegen Betragsgleichheit an Bernd Funkes §45b-Juni-Rechnung gebunden und diese
 * still auf „bezahlt" gesetzt — das paid_at lag sogar VOR dem Rechnungsdatum.
 *
 * Verifiziert:
 *  1. Reiner Betrags-Treffer OHNE Beleg begleicht NICHT mehr automatisch: die
 *     Rechnung bleibt „versendet", die Transaktion wird nur im Prüf-Zustand
 *     (`auto_amount_review`) gebunden, mit `invoice_payment_review_required`-Audit.
 *  2. Plausibilitäts-Guard: Eine Zahlung, die VOR der Rechnungserstellung datiert,
 *     wird per Betrag gar nicht erst gebunden.
 *  3. Starke Treffer (Rechnungsnummer) begleichen weiterhin korrekt — auch bei
 *     unplausiblem Datum (der Guard greift NUR für reine Betrags-Treffer).
 *  4. Reiner Betrags-Treffer MIT Versicherten-Beleg begleicht weiterhin (`auto_amount`).
 *  5. confirm-paid gibt einen Prüf-Treffer frei: Rechnung „bezahlt", Kennzeichen
 *     graduiert zu `auto_amount`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiPost, uniqueId } from "../test-utils";
import { db } from "../../server/lib/db";
import { customers, invoices, qontoTransactions, auditLog } from "../../shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withGobdMutation } from "../helpers/gobd";

interface Seeded {
  customerId: number;
  invoiceIds: number[];
  qontoTxIds: number[];
}
const seeded: Seeded = { customerId: 0, invoiceIds: [], qontoTxIds: [] };

// Eindeutige, ungewöhnlich hohe Beträge, damit der „genau eine offene Rechnung
// mit diesem Betrag"-Pfad (Betrags-Match) deterministisch greift und nicht mit
// Fixtures anderer Testdateien im geteilten Ephemeral-DB kollidiert.
const AMOUNT_BASE = 7_000_00 + Math.floor(Math.random() * 90_000);
let amountSeq = 0;
function uniqueAmount(): number {
  return AMOUNT_BASE + amountSeq++ * 173;
}

async function insertCustomer(): Promise<number> {
  const tag = uniqueId();
  const [row] = await db.insert(customers).values({
    name: `QONTO-AMG-${tag}`,
    vorname: "Qonto",
    nachname: `Amg-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  }).returning({ id: customers.id });
  return row.id;
}

async function insertInvoice(opts: {
  amountCents: number;
  suffix: string;
  customerName?: string | null;
  versichertennummer?: string | null;
  billingMonth?: number;
  billingYear?: number;
}): Promise<{ id: number; invoiceNumber: string }> {
  const tag = uniqueId();
  const invoiceNumber = `AMG-${opts.suffix}-${tag}`;
  const [row] = await db.insert(invoices).values({
    invoiceNumber,
    customerId: seeded.customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: opts.billingMonth ?? 1,
    billingYear: opts.billingYear ?? 2026,
    customerName: opts.customerName ?? null,
    versichertennummer: opts.versichertennummer ?? null,
    recipientName: "Test",
    grossAmountCents: opts.amountCents,
    netAmountCents: opts.amountCents,
    status: "versendet",
  }).returning({ id: invoices.id });
  seeded.invoiceIds.push(row.id);
  return { id: row.id, invoiceNumber };
}

async function insertQontoTx(opts: { amountCents: number; reference?: string; emittedAt?: Date }): Promise<number> {
  const tag = uniqueId();
  const [row] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `qonto-amg-${tag}`,
    amountCents: opts.amountCents,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt: opts.emittedAt ?? new Date(),
    reference: opts.reference ?? null,
  }).returning({ id: qontoTransactions.id });
  seeded.qontoTxIds.push(row.id);
  return row.id;
}

async function countAudit(action: string, invoiceId: number, txId: number): Promise<number> {
  const rows = await db.select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityType, "invoice"), eq(auditLog.entityId, invoiceId)));
  return rows.filter(r => (r.metadata as { qontoTransactionId?: number } | null)?.qontoTransactionId === txId).length;
}

async function getTx(id: number) {
  const [row] = await db.select({
    matchedInvoiceId: qontoTransactions.matchedInvoiceId,
    matchConfidence: qontoTransactions.matchConfidence,
  }).from(qontoTransactions).where(eq(qontoTransactions.id, id));
  return row;
}

async function getInvoiceStatus(id: number) {
  const [row] = await db.select({ status: invoices.status, paidAt: invoices.paidAt })
    .from(invoices).where(eq(invoices.id, id));
  return row;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
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

describe("Qonto Betrags-Match-Absicherung (Auto-Match)", () => {
  it("betragsgleiche Fremdzahlung ohne Beleg begleicht NICHT automatisch, sondern bindet nur zur Prüfung", async () => {
    const amt = uniqueAmount();
    const invoice = await insertInvoice({ amountCents: amt, suffix: "REVIEW", customerName: "Alpha Eindeutigname" });
    // Verwendungszweck OHNE Rechnungsnummer, OHNE Versicherten-Namen/-Nummer,
    // OHNE Zeitraum — nur der Betrag stimmt überein (Fremdzahlung).
    const txId = await insertQontoTx({ amountCents: amt, reference: "aok bayern sammelzahlung fremd ohne beleg" });

    const res = await apiPost(`/api/admin/qonto/auto-match`, {});
    expect(res.status).toBe(200);

    // Rechnung bleibt offen — kein stilles „bezahlt".
    const inv = await getInvoiceStatus(invoice.id);
    expect(inv.status).toBe("versendet");
    expect(inv.paidAt).toBeNull();

    // Transaktion ist gebunden, aber im Prüf-Zustand.
    const tx = await getTx(txId);
    expect(tx.matchedInvoiceId).toBe(invoice.id);
    expect(tx.matchConfidence).toBe("auto_amount_review");

    // Genau ein Prüf-Audit; bewusst KEIN reconciled/partial.
    expect(await countAudit("invoice_payment_review_required", invoice.id, txId)).toBe(1);
    expect(await countAudit("invoice_payment_reconciled", invoice.id, txId)).toBe(0);
    expect(await countAudit("invoice_partial_payment", invoice.id, txId)).toBe(0);
  });

  it("Plausibilitäts-Guard: Zahlung VOR Rechnungserstellung wird per Betrag gar nicht gebunden", async () => {
    const amt = uniqueAmount();
    const invoice = await insertInvoice({ amountCents: amt, suffix: "EARLY", customerName: "Beta Eindeutigname" });
    // Bank-Datum liegt Tage vor der (soeben erzeugten) Rechnung.
    const txId = await insertQontoTx({ amountCents: amt, reference: "fremdzahlung ohne beleg", emittedAt: daysAgo(5) });

    const res = await apiPost(`/api/admin/qonto/auto-match`, {});
    expect(res.status).toBe(200);

    const inv = await getInvoiceStatus(invoice.id);
    expect(inv.status).toBe("versendet");

    // NICHT gebunden (übersprungen) — kein Prüf-Zustand, kein Audit.
    const tx = await getTx(txId);
    expect(tx.matchedInvoiceId).toBeNull();
    expect(tx.matchConfidence).toBeNull();
    expect(await countAudit("invoice_payment_review_required", invoice.id, txId)).toBe(0);
    expect(await countAudit("invoice_payment_reconciled", invoice.id, txId)).toBe(0);
  });

  it("starker Treffer (Rechnungsnummer) begleicht weiterhin — auch bei unplausiblem Datum (Guard nur für Betrags-Treffer)", async () => {
    const amt = uniqueAmount();
    const invoice = await insertInvoice({ amountCents: amt, suffix: "STRONG", customerName: "Gamma Eindeutigname" });
    // Rechnungsnummer im Verwendungszweck + Datum vor Erstellung → muss trotzdem
    // begleichen (starke Treffer verhalten sich unverändert).
    const txId = await insertQontoTx({ amountCents: amt, reference: `Zahlung ${invoice.invoiceNumber}`, emittedAt: daysAgo(5) });

    const res = await apiPost(`/api/admin/qonto/auto-match`, {});
    expect(res.status).toBe(200);

    const inv = await getInvoiceStatus(invoice.id);
    expect(inv.status).toBe("bezahlt");
    expect(inv.paidAt).not.toBeNull();

    const tx = await getTx(txId);
    expect(tx.matchedInvoiceId).toBe(invoice.id);
    expect(tx.matchConfidence).toBe("auto_exact");
    expect(await countAudit("invoice_payment_reconciled", invoice.id, txId)).toBe(1);
  });

  it("reiner Betrags-Treffer MIT Versicherten-Beleg begleicht weiterhin (auto_amount)", async () => {
    const amt = uniqueAmount();
    const invoice = await insertInvoice({ amountCents: amt, suffix: "CORROB", customerName: "Zoltan Belegperson" });
    // Kein Rechnungsnummer-Treffer, aber der Versicherten-Name steht im Zweck.
    const txId = await insertQontoTx({ amountCents: amt, reference: "ueberweisung belegperson pflege" });

    const res = await apiPost(`/api/admin/qonto/auto-match`, {});
    expect(res.status).toBe(200);

    const inv = await getInvoiceStatus(invoice.id);
    expect(inv.status).toBe("bezahlt");

    const tx = await getTx(txId);
    expect(tx.matchedInvoiceId).toBe(invoice.id);
    expect(tx.matchConfidence).toBe("auto_amount");
    expect(await countAudit("invoice_payment_reconciled", invoice.id, txId)).toBe(1);
    expect(await countAudit("invoice_payment_review_required", invoice.id, txId)).toBe(0);
  });

  it("confirm-paid gibt einen Prüf-Treffer frei: bezahlt + Kennzeichen graduiert zu auto_amount", async () => {
    const amt = uniqueAmount();
    const invoice = await insertInvoice({ amountCents: amt, suffix: "CONFIRM", customerName: "Delta Eindeutigname" });
    const txId = await insertQontoTx({ amountCents: amt, reference: "fremdzahlung ohne beleg" });

    // Zuerst per Auto-Match in den Prüf-Zustand binden.
    expect((await apiPost(`/api/admin/qonto/auto-match`, {})).status).toBe(200);
    let tx = await getTx(txId);
    expect(tx.matchConfidence).toBe("auto_amount_review");

    // Manuelle Freigabe.
    const res = await apiPost<{ paid: number }>(`/api/admin/qonto/transactions/${txId}/confirm-paid`, {});
    expect(res.status).toBe(200);
    expect(res.data.paid).toBe(1);

    const inv = await getInvoiceStatus(invoice.id);
    expect(inv.status).toBe("bezahlt");

    // Prüf-Kennzeichen ist entfernt (auf auto_amount gehoben).
    tx = await getTx(txId);
    expect(tx.matchConfidence).toBe("auto_amount");
    expect(await countAudit("invoice_payment_difference_accepted", invoice.id, txId)).toBe(1);
  });
});
