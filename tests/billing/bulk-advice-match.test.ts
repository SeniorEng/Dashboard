/**
 * Task #1672 — Sammel-Avis (payment_advice) ↔ Sammelzahlung (Qonto bulk credit)
 * Auto-Match.
 *
 * Spiegelt tests/billing/avis-status-lifecycle.test.ts. Verifiziert die
 * Triple-Equality + Diskriminator-Logik (SSoT shared/domain/qonto/bulk-advice-match.ts)
 * über den echten Auto-Match-/Unmatch-Pfad:
 *  (a) Avis + Zahlung exakt Gesamtbetrag, ohne Rechnungsnummer ⇒ Avis wird gebunden,
 *      alle offenen Rechnungen `bezahlt` (confidence auto_bulk_advice).
 *  (b) ±2 ct Rundung trifft weiterhin.
 *  (c) Zwei betragsgleiche offene Avise ⇒ skip (manuelle Prüfung).
 *  (d) Diskriminator (Empfänger-IBAN) löst den mehrdeutigen Fall auf genau eines auf.
 *  (e) Zahlung mit Rechnungsnummer UND Sammel-Betrag ⇒ Einzelrechnungs-Match gewinnt.
 *  (f) Storno einer Mitglieds-Rechnung ⇒ Triple-Equality bricht ⇒ manuell.
 *  (g) Eine Mitglieds-Rechnung bereits einzeln bezahlt (Σ offen < Gesamt) ⇒ manuell,
 *      kein doppeltes `bezahlt` (K2).
 *  (h) Unmatch stellt `avis_erhalten` wieder her und stuft eine stornierte Rechnung
 *      NICHT herab.
 *  (i) Idempotenz — ein zweiter Auto-Match-Lauf ist ein No-op (kein zusätzlicher
 *      Match, keine doppelten Audit-Zeilen) (K5).
 *  (j) XOR-Constraint lehnt gleichzeitige Bindung an Rechnung UND Avis ab.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiPost, apiDelete, uniqueId } from "../test-utils";
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
import {
  loadFullyPaidUnlinkedAdvices,
  loadUnmatchedCredits,
  computeProposals,
  applyProposals,
  BACKFILL_MATCH_CONFIDENCE,
} from "../../scripts/verify-advice-backfill";
import { users } from "../../shared/schema";

interface Seeded {
  customerId: number;
  invoiceIds: number[];
  qontoTxIds: number[];
  adviceIds: number[];
}

const seeded: Seeded = { customerId: 0, invoiceIds: [], qontoTxIds: [], adviceIds: [] };

let invoiceCounter = 40000 + Math.floor(Math.random() * 40000);

function nextInvoiceNumber(): string {
  invoiceCounter += 1;
  return `RE-2026-${invoiceCounter}`;
}

function centsToEuro(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
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

async function insertQontoTx(opts: {
  amountCents: number;
  sourceIban?: string;
  reference?: string;
  emittedAt?: Date;
  counterpartyName?: string;
}): Promise<number> {
  const tag = uniqueId();
  const [row] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `qonto-bulk-avis-test-${tag}`,
    amountCents: opts.amountCents,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt: opts.emittedAt ?? new Date(),
    sourceIban: opts.sourceIban ?? null,
    reference: opts.reference ?? null,
    counterpartyName: opts.counterpartyName ?? null,
  }).returning({ id: qontoTransactions.id });
  seeded.qontoTxIds.push(row.id);
  return row.id;
}

/**
 * Barmer-CSV (Zeilentypen 1/2/3, Semikolon). Pro Item eine "2;"-Position mit
 * Rechnungsnummer im Referenzfeld; die "3;"-Summenzeile trägt Gesamtbetrag,
 * Zahlungsdatum, Belegnummer und Empfänger-IBAN. avisNummer bleibt (Barmer) null,
 * der Diskriminator läuft daher über die IBAN.
 */
function buildAvisCsv(opts: {
  items: Array<{ num: string; cents: number }>;
  totalCents: number;
  zahlungsDatum: string;
  iban: string;
}): string {
  const lines = ["1;IK123456789"];
  for (const it of opts.items) {
    lines.push(`2;Sammelueberweisung;${it.num};${opts.zahlungsDatum};${centsToEuro(it.cents)}`);
  }
  lines.push(`3;BELEG-${uniqueId()};${opts.zahlungsDatum};${centsToEuro(opts.totalCents)};${opts.iban}`);
  return lines.join("\n");
}

async function createAdvice(opts: {
  items: Array<{ num: string; cents: number }>;
  totalCents: number;
  zahlungsDatum: string;
  iban: string;
}): Promise<{ adviceId: number; matched: number }> {
  const csvContent = buildAvisCsv(opts);
  const res = await apiPost<{ advice: { id: number }; matched: number }>(
    "/api/admin/qonto/payment-advices",
    { fileName: `bulk-avis-${uniqueId()}.csv`, csvContent },
  );
  expect(res.status).toBe(200);
  seeded.adviceIds.push(res.data.advice.id);
  return { adviceId: res.data.advice.id, matched: res.data.matched };
}

async function autoMatch(): Promise<{ matched: number; skipped: number }> {
  const res = await apiPost<{ matched: number; skipped: number }>("/api/admin/qonto/auto-match", {});
  expect(res.status).toBe(200);
  return res.data;
}

async function getInvoiceStatus(invoiceId: number): Promise<string> {
  const [row] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId));
  return row.status;
}

async function getTxMatch(txId: number): Promise<{
  matchedInvoiceId: number | null;
  matchedPaymentAdviceId: number | null;
  matchConfidence: string | null;
}> {
  const [row] = await db.select({
    matchedInvoiceId: qontoTransactions.matchedInvoiceId,
    matchedPaymentAdviceId: qontoTransactions.matchedPaymentAdviceId,
    matchConfidence: qontoTransactions.matchConfidence,
  }).from(qontoTransactions).where(eq(qontoTransactions.id, txId));
  return row;
}

async function countAdviceAudit(action: string, adviceId: number): Promise<number> {
  const rows = await db.select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.action, action),
      eq(auditLog.entityType, "payment_advice"),
      eq(auditLog.entityId, adviceId),
    ));
  return rows.length;
}

beforeAll(async () => {
  const tag = uniqueId();
  const [row] = await db.insert(customers).values({
    name: `BULK-AVIS-${tag}`,
    vorname: "Bulk",
    nachname: `Avis-${tag}`,
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

const IBAN_A = "DE02120300000000202051";
const IBAN_B = "DE02100500000054540402";

describe("Task #1672 — Sammel-Avis ↔ Sammelzahlung Auto-Match", () => {
  it("(a) exakter Gesamtbetrag ohne Rechnungsnummer ⇒ Avis gebunden, alle Rechnungen bezahlt", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 50100, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 50100 }, { num: numB, cents: 40000 }],
      totalCents: 90100,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });
    // Items sind zugeordnet ⇒ Rechnungen auf avis_erhalten.
    expect(await getInvoiceStatus(invA)).toBe("avis_erhalten");
    expect(await getInvoiceStatus(invB)).toBe("avis_erhalten");

    const txId = await insertQontoTx({ amountCents: 90100 });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBe(adviceId);
    expect(tx.matchedInvoiceId).toBeNull();
    expect(tx.matchConfidence).toBe("auto_bulk_advice");
    expect(await getInvoiceStatus(invA)).toBe("bezahlt");
    expect(await getInvoiceStatus(invB)).toBe("bezahlt");
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(1);
  });

  it("(b) ±2 ct Rundung trifft weiterhin", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 45100, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 45100, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 45100 }, { num: numB, cents: 45100 }],
      totalCents: 90200,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });

    // Zahlung 2 ct über dem Gesamtbetrag ⇒ innerhalb der Toleranz.
    const txId = await insertQontoTx({ amountCents: 90202 });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBe(adviceId);
    expect(await getInvoiceStatus(invA)).toBe("bezahlt");
    expect(await getInvoiceStatus(invB)).toBe("bezahlt");
  });

  it("(c) zwei betragsgleiche offene Avise ohne Diskriminator ⇒ skip (manuell)", async () => {
    const n1 = nextInvoiceNumber();
    const n2 = nextInvoiceNumber();
    const n3 = nextInvoiceNumber();
    const n4 = nextInvoiceNumber();
    const i1 = await insertInvoice({ amountCents: 50300, invoiceNumber: n1 });
    const i2 = await insertInvoice({ amountCents: 40000, invoiceNumber: n2 });
    const i3 = await insertInvoice({ amountCents: 40300, invoiceNumber: n3 });
    const i4 = await insertInvoice({ amountCents: 50000, invoiceNumber: n4 });

    const a1 = await createAdvice({
      items: [{ num: n1, cents: 50300 }, { num: n2, cents: 40000 }],
      totalCents: 90300, zahlungsDatum: "15.04.2026", iban: IBAN_A,
    });
    const a2 = await createAdvice({
      items: [{ num: n3, cents: 40300 }, { num: n4, cents: 50000 }],
      totalCents: 90300, zahlungsDatum: "15.04.2026", iban: IBAN_B,
    });

    // Zahlung ohne IBAN/Nummer ⇒ beide Avise passen betraglich, kein Diskriminator.
    const txId = await insertQontoTx({ amountCents: 90300 });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    expect(await getInvoiceStatus(i1)).toBe("avis_erhalten");
    expect(await getInvoiceStatus(i2)).toBe("avis_erhalten");
    expect(await getInvoiceStatus(i3)).toBe("avis_erhalten");
    expect(await getInvoiceStatus(i4)).toBe("avis_erhalten");
    expect(await countAdviceAudit("advice_payment_reconciled", a1.adviceId)).toBe(0);
    expect(await countAdviceAudit("advice_payment_reconciled", a2.adviceId)).toBe(0);
  });

  it("(d) Diskriminator (Empfänger-IBAN) löst den mehrdeutigen Fall auf genau eines auf", async () => {
    const n1 = nextInvoiceNumber();
    const n2 = nextInvoiceNumber();
    const n3 = nextInvoiceNumber();
    const n4 = nextInvoiceNumber();
    const i1 = await insertInvoice({ amountCents: 50400, invoiceNumber: n1 });
    const i2 = await insertInvoice({ amountCents: 40000, invoiceNumber: n2 });
    const i3 = await insertInvoice({ amountCents: 40400, invoiceNumber: n3 });
    const i4 = await insertInvoice({ amountCents: 50000, invoiceNumber: n4 });

    const aA = await createAdvice({
      items: [{ num: n1, cents: 50400 }, { num: n2, cents: 40000 }],
      totalCents: 90400, zahlungsDatum: "15.04.2026", iban: IBAN_A,
    });
    const aB = await createAdvice({
      items: [{ num: n3, cents: 40400 }, { num: n4, cents: 50000 }],
      totalCents: 90400, zahlungsDatum: "15.04.2026", iban: IBAN_B,
    });

    // Zahlung mit Quell-IBAN == Empfänger-IBAN von Avis A ⇒ eindeutig A.
    const txId = await insertQontoTx({ amountCents: 90400, sourceIban: IBAN_A });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBe(aA.adviceId);
    expect(await getInvoiceStatus(i1)).toBe("bezahlt");
    expect(await getInvoiceStatus(i2)).toBe("bezahlt");
    // Avis B unangetastet.
    expect(await getInvoiceStatus(i3)).toBe("avis_erhalten");
    expect(await getInvoiceStatus(i4)).toBe("avis_erhalten");
    expect(await countAdviceAudit("advice_payment_reconciled", aB.adviceId)).toBe(0);
  });

  it("(e) Zahlung mit Rechnungsnummer UND Sammel-Betrag ⇒ Einzelrechnungs-Match gewinnt", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 50500, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 50500 }, { num: numB, cents: 40000 }],
      totalCents: 90500, zahlungsDatum: "15.04.2026", iban: IBAN_A,
    });

    // Zahlung trägt Gesamtbetrag, aber im Verwendungszweck eine Einzel-Rechnungsnummer.
    const txId = await insertQontoTx({ amountCents: 90500, reference: `Zahlung ${numA}` });
    await autoMatch();

    const tx = await getTxMatch(txId);
    // Einzelrechnungs-Match (Nummer) gewinnt ⇒ an die Rechnung gebunden, NICHT ans Avis.
    expect(tx.matchedInvoiceId).toBe(invA);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    expect(await getInvoiceStatus(invA)).toBe("bezahlt");
    expect(await getInvoiceStatus(invB)).toBe("avis_erhalten");
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(0);
  });

  it("(f) Storno einer Mitglieds-Rechnung ⇒ Triple-Equality bricht ⇒ manuell", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 50600, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 50600 }, { num: numB, cents: 40000 }],
      totalCents: 90600, zahlungsDatum: "15.04.2026", iban: IBAN_A,
    });

    // Storno von invB ⇒ Σ offen (50600) < Gesamtbetrag (90600).
    await withGobdMutation((tx) =>
      tx.update(invoices).set({ status: "storniert" }).where(eq(invoices.id, invB)),
    );

    const txId = await insertQontoTx({ amountCents: 90600 });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    expect(await getInvoiceStatus(invA)).toBe("avis_erhalten");
    expect(await getInvoiceStatus(invB)).toBe("storniert");
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(0);
  });

  it("(g) eine Mitglieds-Rechnung bereits einzeln bezahlt (Σ offen < Gesamt) ⇒ manuell, kein Doppel-bezahlt", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 50700, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 50700 }, { num: numB, cents: 40000 }],
      totalCents: 90700, zahlungsDatum: "15.04.2026", iban: IBAN_A,
    });

    // invB bereits einzeln bezahlt ⇒ Σ offen (50700) < Gesamt (90700).
    await withGobdMutation((tx) =>
      tx.update(invoices).set({ status: "bezahlt", paidAt: new Date() }).where(eq(invoices.id, invB)),
    );

    const txId = await insertQontoTx({ amountCents: 90700 });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    // invA darf NICHT über die (divergierende) Sammelzahlung geschlossen werden.
    expect(await getInvoiceStatus(invA)).toBe("avis_erhalten");
    expect(await getInvoiceStatus(invB)).toBe("bezahlt");
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(0);
  });

  it("(h) Unmatch stellt avis_erhalten wieder her und stuft eine stornierte Rechnung nicht herab", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 50800, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    await createAdvice({
      items: [{ num: numA, cents: 50800 }, { num: numB, cents: 40000 }],
      totalCents: 90800, zahlungsDatum: "15.04.2026", iban: IBAN_A,
    });

    const txId = await insertQontoTx({ amountCents: 90800 });
    await autoMatch();
    expect((await getTxMatch(txId)).matchedPaymentAdviceId).not.toBeNull();
    expect(await getInvoiceStatus(invA)).toBe("bezahlt");
    expect(await getInvoiceStatus(invB)).toBe("bezahlt");

    // invB nachträglich stornieren (aus bezahlt) — GoBD-Bypass fürs Test-Setup.
    await withGobdMutation((tx) =>
      tx.update(invoices).set({ status: "storniert", paidAt: null }).where(eq(invoices.id, invB)),
    );

    // Unmatch: bezahlte offene Rechnung ⇒ zurück auf avis_erhalten; storniert bleibt.
    const unmatch = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatch.status).toBe(200);

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    expect(tx.matchConfidence).toBeNull();
    expect(await getInvoiceStatus(invA)).toBe("avis_erhalten");
    expect(await getInvoiceStatus(invB)).toBe("storniert");
  });

  it("(i) Idempotenz — zweiter Auto-Match-Lauf ist ein No-op (kein Extra-Match, keine Doppel-Audits)", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    await insertInvoice({ amountCents: 50900, invoiceNumber: numA });
    await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 50900 }, { num: numB, cents: 40000 }],
      totalCents: 90900, zahlungsDatum: "15.04.2026", iban: IBAN_A,
    });

    const txId = await insertQontoTx({ amountCents: 90900 });
    await autoMatch();
    const firstMatch = await getTxMatch(txId);
    expect(firstMatch.matchedPaymentAdviceId).toBe(adviceId);
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(1);

    // Zweiter Lauf: geguardete Updates greifen auf 0 Zeilen ⇒ nichts ändert sich.
    await autoMatch();
    const secondMatch = await getTxMatch(txId);
    expect(secondMatch.matchedPaymentAdviceId).toBe(adviceId);
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(1);
  });

  it("(j) XOR-Constraint lehnt gleichzeitige Bindung an Rechnung UND Avis ab", async () => {
    const numA = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 91000, invoiceNumber: numA });
    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 91000 }],
      totalCents: 91000, zahlungsDatum: "15.04.2026", iban: IBAN_A,
    });

    const txId = await insertQontoTx({ amountCents: 91000 });

    await expect(
      db.update(qontoTransactions)
        .set({ matchedInvoiceId: invA, matchedPaymentAdviceId: adviceId })
        .where(eq(qontoTransactions.id, txId)),
    ).rejects.toThrow();
  });
});

/**
 * Task #1680 — Historischer Sammel-Avis-Backfill (`--apply`).
 *
 * Der Backfill paart BEREITS VOLLSTÄNDIG BEZAHLTE Avise (Σ offen = 0, Live-
 * Triple-Equality greift nicht mehr) mit unverknüpften Gutschriften über
 * Betrag ±2ct + ±21d + Empfänger-IBAN und schreibt `matched_payment_advice_id`
 * + ein Audit je Avis, ohne die (bereits `bezahlt`en) Rechnungen anzufassen.
 */
describe("Task #1680 — Sammel-Avis Backfill --apply", () => {
  let superadminId = 0;

  beforeAll(async () => {
    const [sa] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .limit(1);
    expect(sa).toBeTruthy();
    superadminId = sa.id;
  });

  /** Erzeugt ein vollständig BEZAHLTES, noch unverknüpftes Avis. */
  async function createFullyPaidAdvice(opts: {
    items: Array<{ num: string; cents: number }>;
    totalCents: number;
    zahlungsDatum: string;
    iban: string;
  }): Promise<{ adviceId: number; invoiceIds: number[] }> {
    const invoiceIds: number[] = [];
    for (const it of opts.items) {
      invoiceIds.push(await insertInvoice({ amountCents: it.cents, invoiceNumber: it.num }));
    }
    const { adviceId } = await createAdvice(opts);
    // Alle Mitglieds-Rechnungen auf `bezahlt` — ohne Qonto-Verknüpfung.
    await withGobdMutation((tx) =>
      tx.update(invoices)
        .set({ status: "bezahlt", paidAt: new Date() })
        .where(inArray(invoices.id, invoiceIds)),
    );
    return { adviceId, invoiceIds };
  }

  it("(k) verknüpft eindeutigen Backfill-Vorschlag + schreibt Audit, ohne Rechnungen anzufassen", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const { adviceId, invoiceIds } = await createFullyPaidAdvice({
      items: [{ num: numA, cents: 51100 }, { num: numB, cents: 40000 }],
      totalCents: 91100,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });

    const txId = await insertQontoTx({
      amountCents: 91100,
      sourceIban: IBAN_A,
      emittedAt: new Date("2026-04-20T00:00:00Z"),
    });

    const advices = await loadFullyPaidUnlinkedAdvices();
    const credits = await loadUnmatchedCredits();
    const { proposals } = computeProposals(advices, credits);
    const mine = proposals.filter((p) => p.advice.id === adviceId);
    expect(mine).toHaveLength(1);
    expect(mine[0].txId).toBe(txId);

    const linked = await applyProposals(mine, superadminId, "Backfill-Test Task #1680");
    expect(linked).toBe(1);

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBe(adviceId);
    expect(tx.matchedInvoiceId).toBeNull();
    expect(tx.matchConfidence).toBe(BACKFILL_MATCH_CONFIDENCE);
    // Rechnungen bleiben `bezahlt` (Backfill fasst sie nicht an).
    for (const id of invoiceIds) {
      expect(await getInvoiceStatus(id)).toBe("bezahlt");
    }
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(1);
  });

  it("(l) idempotent — zweiter --apply-Lauf verknüpft null Zeilen, kein zweites Audit", async () => {
    const numA = nextInvoiceNumber();
    const { adviceId } = await createFullyPaidAdvice({
      items: [{ num: numA, cents: 51200 }],
      totalCents: 51200,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });
    const txId = await insertQontoTx({
      amountCents: 51200,
      sourceIban: IBAN_A,
      emittedAt: new Date("2026-04-20T00:00:00Z"),
    });

    const proposals1 = computeProposals(
      await loadFullyPaidUnlinkedAdvices(),
      await loadUnmatchedCredits(),
    ).proposals.filter((p) => p.advice.id === adviceId);
    expect(await applyProposals(proposals1, superadminId, "Backfill-Test idempotent #1680")).toBe(1);
    expect((await getTxMatch(txId)).matchedPaymentAdviceId).toBe(adviceId);
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(1);

    // Zweiter Lauf: das Avis ist verknüpft ⇒ nicht mehr Kandidat, geguardetes
    // Update träfe ohnehin 0 Zeilen.
    const proposals2 = computeProposals(
      await loadFullyPaidUnlinkedAdvices(),
      await loadUnmatchedCredits(),
    ).proposals.filter((p) => p.advice.id === adviceId);
    expect(proposals2).toHaveLength(0);
    expect(await applyProposals(proposals1, superadminId, "Backfill-Test idempotent #1680")).toBe(0);
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(1);
  });

  it("(m) mehrdeutig (2 passende Gutschriften) ⇒ kein Vorschlag, keine Verknüpfung", async () => {
    const numA = nextInvoiceNumber();
    const { adviceId } = await createFullyPaidAdvice({
      items: [{ num: numA, cents: 51300 }],
      totalCents: 51300,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });
    // Zwei betrags-/IBAN-/fenstergleiche Gutschriften ⇒ mehrdeutig.
    await insertQontoTx({ amountCents: 51300, sourceIban: IBAN_A, emittedAt: new Date("2026-04-18T00:00:00Z") });
    await insertQontoTx({ amountCents: 51300, sourceIban: IBAN_A, emittedAt: new Date("2026-04-22T00:00:00Z") });

    const { proposals, ambiguous } = computeProposals(
      await loadFullyPaidUnlinkedAdvices(),
      await loadUnmatchedCredits(),
    );
    expect(proposals.filter((p) => p.advice.id === adviceId)).toHaveLength(0);
    expect(ambiguous.some((a) => a.id === adviceId)).toBe(true);
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(0);
  });

  it("(n) IBAN-Mismatch ⇒ kein Vorschlag (IBAN ist Pflicht-Gate)", async () => {
    const numA = nextInvoiceNumber();
    const { adviceId } = await createFullyPaidAdvice({
      items: [{ num: numA, cents: 51400 }],
      totalCents: 51400,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });
    // Betrag + Fenster passen, aber IBAN nicht ⇒ kein Match.
    await insertQontoTx({ amountCents: 51400, sourceIban: IBAN_B, emittedAt: new Date("2026-04-20T00:00:00Z") });

    const { proposals } = computeProposals(
      await loadFullyPaidUnlinkedAdvices(),
      await loadUnmatchedCredits(),
    );
    expect(proposals.filter((p) => p.advice.id === adviceId)).toHaveLength(0);
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(0);
  });
});
