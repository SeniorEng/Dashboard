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
 *  (e) Zahlung mit Rechnungsnummer UND passendem Sammel-Betrag ⇒ Sammel-Avis-Abgleich
 *      gewinnt (Task #1788): der ganze Stapel wird bezahlt statt Einzel-Bind+Flag.
 *  (e2) Zahlung mit Rechnungsnummer, Betrag passt zu KEINEM Avis ⇒ Einzel-Bind+Flag
 *      bleibt (kein Regress).
 *  (e4) Zahlung deckt die genannte Rechnung nur teilweise ⇒ `invoice_partial_payment`,
 *      NICHT `invoice_payment_mismatch` (Unterzahlung ist kein Prüffall).
 *  (e3) Zahlung nennt eine Rechnung, die in KEINEM Avis liegt, ihr Betrag ginge aber
 *      bei einem FREMD-Avis triple-equal auf ⇒ der Fremd-Avis gewinnt NICHT; die
 *      genannte Rechnung wird gebunden + geflaggt (Task #1788 Enthaltensein-Gate).
 *  (f) Storno einer Mitglieds-Rechnung ⇒ Triple-Equality bricht ⇒ manuell.
 *  (g) Eine Mitglieds-Rechnung bereits einzeln bezahlt (Σ offen < Gesamt) ⇒ manuell,
 *      kein doppeltes `bezahlt` (K2).
 *  (h) Unmatch nimmt die Zahlung zurück (⇒ `versendet`) und stuft eine stornierte
 *      Rechnung NICHT herab.
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
  buildAmbiguousReportRows,
  formatAmbiguousReportCsv,
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

/**
 * Kollisions-Registry für Gesamtbeträge.
 *
 * Der Auto-Match-/Backfill-Pfad scannt ALLE noch offenen Avise/Gutschriften in
 * der geteilten Worker-DB. Zwei Cases mit demselben Gesamtbetrag können sich
 * daher gegenseitig „querbinden" — ein nicht-lokaler, verwirrender Fehler.
 * Deshalb MUSS jeder Case einen global eindeutigen Gesamtbetrag nutzen.
 * Absichtliche Duplikate innerhalb DESSELBEN Case (z.B. (c)/(d): zwei
 * betragsgleiche Avise) sind erlaubt — sie teilen sich dieselbe `caseId`.
 */
const totalsByCase = new Map<number, string>();

function registerCaseTotal(totalCents: number, caseId: string): void {
  const existing = totalsByCase.get(totalCents);
  if (existing !== undefined && existing !== caseId) {
    throw new Error(
      `Sammel-Avis Test-Kollision: Gesamtbetrag ${totalCents} wird von Case "${existing}" ` +
        `UND Case "${caseId}" verwendet. Der Auto-Match scannt ALLE offenen Avise/Gutschriften ` +
        `in der geteilten Worker-DB, daher braucht jeder Case einen global eindeutigen Gesamtbetrag. ` +
        `Nutze einen anderen Betrag (Ausnahme: absichtliche Duplikate innerhalb desselben Case ` +
        `wie (c)/(d) — diese müssen dieselbe caseId teilen).`,
    );
  }
  totalsByCase.set(totalCents, caseId);
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
  caseId: string;
}): Promise<{ adviceId: number; matched: number }> {
  registerCaseTotal(opts.totalCents, opts.caseId);
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

async function countInvoiceAudit(action: string, invoiceId: number): Promise<number> {
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
      caseId: "a",
    });
    // Items sind zugeordnet. Vor dem Status-Umbau hob das die Rechnungen auf
    // `avis_erhalten`; jetzt ist die Zuordnung von ihrem Zustand getrennt — sie
    // warten weiter auf Zahlung, denn Geld ist keines geflossen.
    expect(await getInvoiceStatus(invA)).toBe("versendet");
    expect(await getInvoiceStatus(invB)).toBe("versendet");

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
      caseId: "b",
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
      totalCents: 90300, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "c",
    });
    const a2 = await createAdvice({
      items: [{ num: n3, cents: 40300 }, { num: n4, cents: 50000 }],
      totalCents: 90300, zahlungsDatum: "15.04.2026", iban: IBAN_B, caseId: "c",
    });

    // Zahlung ohne IBAN/Nummer ⇒ beide Avise passen betraglich, kein Diskriminator.
    const txId = await insertQontoTx({ amountCents: 90300 });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    expect(await getInvoiceStatus(i1)).toBe("versendet");
    expect(await getInvoiceStatus(i2)).toBe("versendet");
    expect(await getInvoiceStatus(i3)).toBe("versendet");
    expect(await getInvoiceStatus(i4)).toBe("versendet");
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
      totalCents: 90400, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "d",
    });
    const aB = await createAdvice({
      items: [{ num: n3, cents: 40400 }, { num: n4, cents: 50000 }],
      totalCents: 90400, zahlungsDatum: "15.04.2026", iban: IBAN_B, caseId: "d",
    });

    // Zahlung mit Quell-IBAN == Empfänger-IBAN von Avis A ⇒ eindeutig A.
    const txId = await insertQontoTx({ amountCents: 90400, sourceIban: IBAN_A });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBe(aA.adviceId);
    expect(await getInvoiceStatus(i1)).toBe("bezahlt");
    expect(await getInvoiceStatus(i2)).toBe("bezahlt");
    // Avis B unangetastet.
    expect(await getInvoiceStatus(i3)).toBe("versendet");
    expect(await getInvoiceStatus(i4)).toBe("versendet");
    expect(await countAdviceAudit("advice_payment_reconciled", aB.adviceId)).toBe(0);
  });

  it("(e) Zahlung mit Rechnungsnummer UND passendem Sammel-Betrag ⇒ Sammel-Avis-Abgleich gewinnt (Task #1788)", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 50500, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 50500 }, { num: numB, cents: 40000 }],
      totalCents: 90500, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "e",
    });

    // Zahlung trägt den Sammel-Gesamtbetrag, im Verwendungszweck aber nur EINE
    // Einzel-Rechnungsnummer (invA). Der Betrag deckt invA nicht voll (90500 ≠
    // 50500), aber der Sammel-Avis geht triple-equal auf ⇒ Avis-Abgleich gewinnt.
    const txId = await insertQontoTx({ amountCents: 90500, reference: `Zahlung ${numA}` });
    await autoMatch();

    const tx = await getTxMatch(txId);
    // Sammel-Avis-Abgleich gewinnt ⇒ an das Avis gebunden, NICHT an die Einzelrechnung.
    expect(tx.matchedPaymentAdviceId).toBe(adviceId);
    expect(tx.matchedInvoiceId).toBeNull();
    expect(tx.matchConfidence).toBe("auto_bulk_advice");
    // Der ganze Stapel wird bezahlt — kein Bind+Flag mehr.
    expect(await getInvoiceStatus(invA)).toBe("bezahlt");
    expect(await getInvoiceStatus(invB)).toBe("bezahlt");
    expect(await countInvoiceAudit("invoice_payment_mismatch", invA)).toBe(0);
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(1);
  });

  it("(e2) Zahlung mit Rechnungsnummer, Betrag passt zu KEINEM Avis ⇒ Einzel-Bind+Flag bleibt (kein Regress)", async () => {
    const numA = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 51500, invoiceNumber: numA });

    // KEIN Sammel-Avis für diese Rechnung. Die Zahlung trifft invA per Nummer,
    // weicht aber > Toleranz vom Brutto ab (88888 ≠ 51500) und geht bei keinem
    // Avis triple-equal auf ⇒ die Disambiguierung greift nicht, es bleibt beim
    // bisherigen Einzel-Bind+Flag.
    const txId = await insertQontoTx({ amountCents: 88888, reference: `Zahlung ${numA}` });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedInvoiceId).toBe(invA);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    // invA war nie einem Avis zugeordnet ⇒ bleibt „versendet", nur gebunden + geflaggt.
    expect(await getInvoiceStatus(invA)).toBe("versendet");
    expect(await countInvoiceAudit("invoice_payment_mismatch", invA)).toBe(1);
  });

  it("(e4) Zahlung deckt die genannte Rechnung nur teilweise ⇒ Teilzahlung, KEIN Mismatch", async () => {
    // ── Warum dieser Fall eigenstaendig geprueft wird ──────────────────────
    // (e2) daneben prueft die UEBERZAHLUNG: sie ist ein Prueffall und wird als
    // `invoice_payment_mismatch` geflaggt. Die UNTERZAHLUNG ist das Gegenteil —
    // voellig normal, es fehlt nur noch Geld — und muss als
    // `invoice_partial_payment` verbucht werden.
    //
    // Vor dem Status-Umbau hielt der Auto-Match die beiden ueber den
    // abgeleiteten Status auseinander: Unterzahlung ergab `teilweise_bezahlt`,
    // Ueberzahlung ergab `null`. Seit die Unterzahlung keinen Status mehr setzt,
    // ergeben BEIDE `null` — und ein Zweig, der auf `null` prueft, wirft sie
    // zusammen. Der Auto-Match meldete daraufhin jede Teilzahlung zur manuellen
    // Pruefung, und `invoice_partial_payment` konnte hier gar nicht mehr
    // entstehen.
    //
    // Kein Test war rot geworden: die Statuszeile blieb in beiden Faellen
    // `versendet`, nur die Audit-Art kippte. Deshalb prueft dieser Fall die
    // Audit-Art in BEIDE Richtungen.
    const numT = nextInvoiceNumber();
    const invT = await insertInvoice({ amountCents: 51500, invoiceNumber: numT });

    // 300 EUR auf 515 EUR: klar unter Brutto, weit ausserhalb der Toleranz.
    const txId = await insertQontoTx({ amountCents: 30000, reference: `Zahlung ${numT}` });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedInvoiceId, "Teilzahlung muss gebunden werden").toBe(invT);

    // Der Zustand bleibt „wartet auf Zahlung" — eine Teilzahlung schliesst
    // nichts ab. (Diese Zeile allein wuerde den Regress NICHT fangen.)
    expect(await getInvoiceStatus(invT)).toBe("versendet");

    // Und die eigentliche Aussage: als Teilzahlung verbucht, NICHT als
    // Prueffall. Faellt die Unterscheidung, kippt genau dieses Paar.
    expect(await countInvoiceAudit("invoice_partial_payment", invT)).toBe(1);
    expect(await countInvoiceAudit("invoice_payment_mismatch", invT)).toBe(0);
  });

  it("(e3) Rechnung in KEINEM Avis, aber Betrag = Fremd-Avis-Gesamt ⇒ Fremd-Avis gewinnt NICHT (Enthaltensein-Gate)", async () => {
    const numX = nextInvoiceNumber();
    const numY = nextInvoiceNumber();
    const numZ = nextInvoiceNumber();
    // invX wird von KEINEM Avis referenziert.
    const invX = await insertInvoice({ amountCents: 40000, invoiceNumber: numX });
    // Fremd-Avis über zwei ANDERE Rechnungen; sein Gesamtbetrag entspricht exakt
    // der Zahlung und ginge triple-equal auf — enthält invX aber nicht.
    const invY = await insertInvoice({ amountCents: 30000, invoiceNumber: numY });
    const invZ = await insertInvoice({ amountCents: 33700, invoiceNumber: numZ });
    const { adviceId: foreignAdviceId } = await createAdvice({
      items: [{ num: numY, cents: 30000 }, { num: numZ, cents: 33700 }],
      totalCents: 63700, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "e3",
    });

    // Zahlung nennt invX, deckt sie aber nicht voll (63700 ≠ 40000). Der Betrag
    // ginge beim Fremd-Avis triple-equal auf — dieser enthält invX jedoch nicht,
    // also darf er NICHT gewinnen; sonst bliebe invX fälschlich offen.
    const txId = await insertQontoTx({ amountCents: 63700, reference: `Zahlung ${numX}` });
    await autoMatch();

    const tx = await getTxMatch(txId);
    // Enthaltensein-Gate ⇒ genannte Einzelrechnung gebunden + geflaggt, kein Fremd-Avis.
    expect(tx.matchedInvoiceId).toBe(invX);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    expect(await getInvoiceStatus(invX)).toBe("versendet");
    expect(await countInvoiceAudit("invoice_payment_mismatch", invX)).toBe(1);
    // Der Fremd-Avis bleibt unangetastet.
    expect(await getInvoiceStatus(invY)).toBe("versendet");
    expect(await getInvoiceStatus(invZ)).toBe("versendet");
    expect(await countAdviceAudit("advice_payment_reconciled", foreignAdviceId)).toBe(0);
  });

  it("(f) Storno einer Mitglieds-Rechnung ⇒ Triple-Equality bricht ⇒ manuell", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 50600, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 50600 }, { num: numB, cents: 40000 }],
      totalCents: 90600, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "f",
    });

    // Storno von invB ⇒ Σ offen (50600) < Gesamtbetrag (90600).
    await withGobdMutation((tx) =>
      tx.update(invoices).set({ status: "storniert" }).where(eq(invoices.id, invB)),
    );

    const txId = await insertQontoTx({ amountCents: 90600 });
    await autoMatch();

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    expect(await getInvoiceStatus(invA)).toBe("versendet");
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
      totalCents: 90700, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "g",
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
    expect(await getInvoiceStatus(invA)).toBe("versendet");
    expect(await getInvoiceStatus(invB)).toBe("bezahlt");
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(0);
  });

  it("(h) Unmatch nimmt die Zahlung zurueck und stuft eine stornierte Rechnung nicht herab", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const invA = await insertInvoice({ amountCents: 50800, invoiceNumber: numA });
    const invB = await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    await createAdvice({
      items: [{ num: numA, cents: 50800 }, { num: numB, cents: 40000 }],
      totalCents: 90800, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "h",
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

    // Unmatch: die offene Rechnung faellt auf `versendet` — sie wartet wieder
    // auf Zahlung. (Frueher fiel sie auf `avis_erhalten`, weil der Avis noch
    // lag; diesen Zwischenstand gibt es nicht mehr.)
    //
    // Die stornierte bleibt storniert, und DAS ist der eigentliche Prueffall:
    // die Ruecknahme faehrt seit dem Umbau ueber
    // `INVOICE_STATUS_REVERSAL_TRANSITIONS`, die ausschliesslich `bezahlt` als
    // Ausgangs-Status kennt. Griffe die Ruecknahme breiter, wuerde hier eine
    // stornierte Rechnung wiederbelebt.
    const unmatch = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatch.status).toBe(200);

    const tx = await getTxMatch(txId);
    expect(tx.matchedPaymentAdviceId).toBeNull();
    expect(tx.matchConfidence).toBeNull();
    expect(await getInvoiceStatus(invA)).toBe("versendet");
    expect(await getInvoiceStatus(invB)).toBe("storniert");
  });

  it("(i) Idempotenz — zweiter Auto-Match-Lauf ist ein No-op (kein Extra-Match, keine Doppel-Audits)", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    await insertInvoice({ amountCents: 50900, invoiceNumber: numA });
    await insertInvoice({ amountCents: 40000, invoiceNumber: numB });

    const { adviceId } = await createAdvice({
      items: [{ num: numA, cents: 50900 }, { num: numB, cents: 40000 }],
      totalCents: 90900, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "i",
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
      totalCents: 91000, zahlungsDatum: "15.04.2026", iban: IBAN_A, caseId: "j",
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
    caseId: string;
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
      caseId: "k",
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
      caseId: "l",
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
      caseId: "m",
    });
    // Zwei betrags-/IBAN-/fenstergleiche Gutschriften ⇒ mehrdeutig.
    await insertQontoTx({ amountCents: 51300, sourceIban: IBAN_A, emittedAt: new Date("2026-04-18T00:00:00Z") });
    await insertQontoTx({ amountCents: 51300, sourceIban: IBAN_A, emittedAt: new Date("2026-04-22T00:00:00Z") });

    const { proposals, ambiguous } = computeProposals(
      await loadFullyPaidUnlinkedAdvices(),
      await loadUnmatchedCredits(),
    );
    expect(proposals.filter((p) => p.advice.id === adviceId)).toHaveLength(0);
    const mine = ambiguous.find((a) => a.advice.id === adviceId);
    expect(mine).toBeTruthy();
    expect(mine!.reason).toBe("multiple_credits");
    // Beide konkurrierenden Gutschriften sind für die manuelle Prüfung erhalten.
    expect(mine!.candidates).toHaveLength(2);
    expect(mine!.candidates.map((c) => c.txId).sort()).toEqual([...mine!.candidates.map((c) => c.txId)].sort());
    expect(await countAdviceAudit("advice_payment_reconciled", adviceId)).toBe(0);
  });

  it("(m2) Report enthält für jedes mehrdeutige Avis eine Zeile je konkurrierender Gutschrift (CSV + Rows)", async () => {
    const numA = nextInvoiceNumber();
    const { adviceId } = await createFullyPaidAdvice({
      items: [{ num: numA, cents: 51350 }],
      totalCents: 51350,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });
    const tx1 = await insertQontoTx({ amountCents: 51350, sourceIban: IBAN_A, emittedAt: new Date("2026-04-18T00:00:00Z"), counterpartyName: "AOK Nordost" });
    const tx2 = await insertQontoTx({ amountCents: 51350, sourceIban: IBAN_A, emittedAt: new Date("2026-04-22T00:00:00Z"), counterpartyName: "AOK Bayern" });

    const { ambiguous } = computeProposals(
      await loadFullyPaidUnlinkedAdvices(),
      await loadUnmatchedCredits(),
    );

    const rows = buildAmbiguousReportRows(ambiguous).filter((r) => r.adviceId === adviceId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.txId).sort()).toEqual([tx1, tx2].sort());
    // Jede Zeile trägt den Avis-Kontext UND die konkurrierende Gutschrift.
    for (const r of rows) {
      expect(r.adviceAmountCents).toBe(51350);
      expect(r.reason).toBe("multiple_credits");
      expect(r.txAmountCents).toBe(51350);
      expect(r.txSourceIban).toBe(IBAN_A);
    }

    const csv = formatAmbiguousReportCsv(ambiguous);
    const header = csv.split("\n")[0];
    expect(header).toContain("advice_id");
    expect(header).toContain("tx_id");
    // Beide Gegenpartei-Namen tauchen im CSV auf.
    expect(csv).toContain("AOK Nordost");
    expect(csv).toContain("AOK Bayern");
  });

  it("(m3) Kollision: eine Gutschrift für zwei Avise ⇒ beide mehrdeutig, mit collidingAdviceIds", async () => {
    const numA = nextInvoiceNumber();
    const numB = nextInvoiceNumber();
    const a1 = await createFullyPaidAdvice({
      items: [{ num: numA, cents: 51360 }],
      totalCents: 51360,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });
    const a2 = await createFullyPaidAdvice({
      items: [{ num: numB, cents: 51360 }],
      totalCents: 51360,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
    });
    // GENAU EINE passende Gutschrift ⇒ jedes Avis hätte für sich einen eindeutigen
    // Vorschlag, aber beide beanspruchen dieselbe TX ⇒ Kollision.
    const txId = await insertQontoTx({ amountCents: 51360, sourceIban: IBAN_A, emittedAt: new Date("2026-04-20T00:00:00Z") });

    const { proposals, ambiguous } = computeProposals(
      await loadFullyPaidUnlinkedAdvices(),
      await loadUnmatchedCredits(),
    );

    expect(proposals.filter((p) => p.txId === txId)).toHaveLength(0);
    const e1 = ambiguous.find((a) => a.advice.id === a1.adviceId);
    const e2 = ambiguous.find((a) => a.advice.id === a2.adviceId);
    expect(e1?.reason).toBe("credit_collision");
    expect(e2?.reason).toBe("credit_collision");
    expect(e1?.candidates[0].txId).toBe(txId);
    expect(e1?.collidingAdviceIds).toContain(a2.adviceId);
    expect(e2?.collidingAdviceIds).toContain(a1.adviceId);
  });

  it("(n) IBAN-Mismatch ⇒ kein Vorschlag (IBAN ist Pflicht-Gate)", async () => {
    const numA = nextInvoiceNumber();
    const { adviceId } = await createFullyPaidAdvice({
      items: [{ num: numA, cents: 51400 }],
      totalCents: 51400,
      zahlungsDatum: "15.04.2026",
      iban: IBAN_A,
      caseId: "n",
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
