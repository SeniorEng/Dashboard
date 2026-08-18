/**
 * Der Zahlungsavis ist eine ZUORDNUNGS-Mechanik, kein Status.
 *
 * ── Was diese Datei früher prüfte ───────────────────────────────────────
 * Sie hieß „Task #1284 — Rechnungsstatus `avis_erhalten` zwischen `versendet`
 * und `bezahlt`" und nagelte einen eigenen Lebenszyklus-Schritt fest: der
 * Avis-Treffer hob die Rechnung auf `avis_erhalten`, das Löschen des Avis nahm
 * das zurück, und ein Unmatch fiel „nicht unter den Avis-Stand".
 *
 * Mit dem Status-Umbau (`docs/rechnungsstatus-zielmodell.md`) ist dieser Schritt
 * entfallen. Der Avis verbindet einen angekündigten Geldeingang mit einer
 * Rechnung — genau wie eine Qonto-Banktransaktion. Bezahlt ist die Rechnung
 * damit nicht, und ihr Zustand ändert sich nicht: sie wartet weiter auf Zahlung.
 *
 * ── Was sie jetzt prüft ─────────────────────────────────────────────────
 * Dieselben Abläufe, aber gegen die neue Wahrheit. Die Datei ist damit kein
 * Rest, sondern der Beleg für die Modelländerung an der Integrationsgrenze:
 *
 *  1. Avis-Treffer ändert den Status NICHT — die Zuordnung entsteht trotzdem,
 *     und der Audit-Eintrag `invoice_avis_received` bleibt (ein Ereignis).
 *  2. „Als bezahlt markieren" setzt die offenen Rechnungen eines Avis auf
 *     `bezahlt`; paidAt aus dem Zahlungsdatum (Audit
 *     `invoice_payment_reconciled`, matchedBy="avis"). Unverändert.
 *  3. Qonto-Match hebt eine `versendet`-Rechnung mit Avis auf `bezahlt`;
 *     Unmatch fällt auf `versendet` zurück — es gibt keinen Zwischenstand
 *     mehr, unter den man nicht fallen dürfte.
 *  4. Löschen eines Avis lässt den Status unberührt; der Audit-Eintrag
 *     `invoice_avis_reverted` bleibt.
 *  5. GET /payment-advices reichert matchedInvoiceCount + unpaidMatchedCount
 *     an. Unverändert.
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

/**
 * Task #1687 — AOK-Plus-artige `1;`-CSV: der Betrag steht NICHT am festen
 * Barmer-Feld-Index 4, sondern an Feld 5
 * (`2;<Zweck>;<Ref>;<Datum>;<Code>;<Betrag>;+;EUR`). Verifiziert, dass der Parser
 * den Betrag STRUKTURELL erkennt statt still als Barmer (parts[4]) fehlzudeuten.
 * `ref` erlaubt O-statt-0-Referenzen (O→0-Normalisierung).
 */
function buildAokCsv(opts: {
  ref: string;
  amountEuro: string;
  zahlungsDatum: string;
  verwendungszweck?: string;
}): string {
  const zweck = opts.verwendungszweck ?? "Pflegeleistung";
  return [
    "1;IK987654321;AOK PLUS",
    `2;${zweck};${opts.ref};${opts.zahlungsDatum};0;${opts.amountEuro};+;EUR`,
    `3;BELEG-${uniqueId()};${opts.zahlungsDatum};${opts.amountEuro};DE00987654320000000000`,
  ].join("\n");
}

async function createAdviceWithRawCsv(csvContent: string): Promise<{ adviceId: number; matched: number }> {
  const res = await apiPost<{ advice: { id: number }; matched: number }>(
    "/api/admin/qonto/payment-advices",
    { fileName: `aok-avis-${uniqueId()}.csv`, csvContent },
  );
  expect(res.status).toBe(200);
  seeded.adviceIds.push(res.data.advice.id);
  return { adviceId: res.data.advice.id, matched: res.data.matched };
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

describe("Zahlungsavis — Zuordnung ohne Statuswechsel", () => {
  it("Avis-Treffer laesst den Status auf versendet (Audit invoice_avis_received bleibt)", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 12345, invoiceNumber: num });

    const { matched } = await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "123,45",
      zahlungsDatum: "15.04.2026",
    });
    expect(matched).toBe(1);

    const inv = await getInvoiceStatus(invoiceId);
    // DIE Kernaussage des Umbaus: die Zuordnung entsteht, der Zustand bleibt.
    expect(inv.status).toBe("versendet");
    expect(inv.paidAt).toBeNull();
    expect(await countAudit("invoice_avis_received", invoiceId)).toBe(1);
  });

  it("Bereits bezahlte Rechnung wird vom Avis-Treffer NICHT herabgestuft", async () => {
    // Diese Zusicherung war frueher aktiv erkaempft: der Avis-Treffer schrieb
    // Status, und eine Bedingung musste die bezahlte Rechnung davor bewahren.
    // Jetzt schreibt der Pfad ueberhaupt keinen Status mehr — die Zusicherung
    // gilt bauartbedingt. Der Test bleibt trotzdem: er haelt fest, DASS sie
    // gilt, unabhaengig davon, wodurch.
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
    expect(inv.paidAt).not.toBeNull(); // und das Zahlungsdatum ueberlebt.

    // Frueher stand hier `toBe(0)` — aber nicht, weil das Ereignis nicht
    // stattgefunden haette, sondern weil der Audit-Eintrag INNERHALB des
    // Status-Zweigs geschrieben wurde und der Zweig uebersprungen wurde. Die
    // Null zaehlte also den ausgebliebenen Statuswechsel, nicht das Ereignis.
    //
    // Ohne Statuswechsel ist der Eintrag das, was er immer sein sollte: die
    // Feststellung, dass ein Avis diese Rechnung deckt. Das ist auch dann
    // wahr, wenn sie laengst bezahlt ist — und genau dann fuer die
    // Nachvollziehbarkeit interessant (angekuendigtes Geld zu einer bereits
    // beglichenen Forderung).
    expect(await countAudit("invoice_avis_received", invoiceId)).toBe(1);
  });

  it("'Als bezahlt markieren' setzt versendet → bezahlt mit paidAt aus Zahlungsdatum", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 33333, invoiceNumber: num });
    const { adviceId } = await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "333,33",
      zahlungsDatum: "10.04.2026",
    });
    expect((await getInvoiceStatus(invoiceId)).status).toBe("versendet");

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

  it("Qonto-Match akzeptiert eine Rechnung mit Avis → bezahlt; Unmatch faellt auf versendet zurueck", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 44444, invoiceNumber: num });
    await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "444,44",
      zahlungsDatum: "12.04.2026",
    });
    expect((await getInvoiceStatus(invoiceId)).status).toBe("versendet");

    const txId = await insertQontoTx({ amountCents: 44444 });
    const matchRes = await apiPost(`/api/admin/qonto/transactions/${txId}/match`, { invoiceId });
    expect(matchRes.status).toBe(200);
    expect((await getInvoiceStatus(invoiceId)).status).toBe("bezahlt");

    // Unmatch → `versendet`. Frueher fiel die Rechnung hier auf `avis_erhalten`
    // zurueck, „nicht unter den Avis-Stand". Diesen Stand gibt es nicht mehr:
    // faellt die Zahlung weg, wartet die Rechnung wieder auf Zahlung — ob ein
    // Avis vorliegt oder nicht.
    const unmatchRes = await apiDelete(`/api/admin/qonto/transactions/${txId}/match`);
    expect(unmatchRes.status).toBe(200);
    const inv = await getInvoiceStatus(invoiceId);
    // DIE Kernaussage des Umbaus: die Zuordnung entsteht, der Zustand bleibt.
    expect(inv.status).toBe("versendet");
    expect(inv.paidAt).toBeNull();
  });

  it("Loeschen des Avis laesst den Status unberuehrt (Audit invoice_avis_reverted bleibt)", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 55555, invoiceNumber: num });
    const { adviceId } = await createAdviceWithCsv({
      invoiceNumbers: [num],
      amountEuro: "555,55",
      zahlungsDatum: "14.04.2026",
    });
    expect((await getInvoiceStatus(invoiceId)).status).toBe("versendet");

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

    // Der Kern: das Loeschen eines Avis nimmt KEINE Zahlung zurueck. Die
    // Zahlung ist ein eigener Vorgang und ueberlebt das Entfernen der
    // Ankuendigung.
    const nachher = await getInvoiceStatus(invoiceId);
    expect(nachher.status).toBe("bezahlt");
    expect(nachher.paidAt).not.toBeNull();

    // Analog zum Avis-Treffer oben: der Eintrag verzeichnet, dass die
    // Avis-Deckung entfiel — ein Ereignis, kein Statuswechsel.
    expect(await countAudit("invoice_avis_reverted", invoiceId)).toBe(1);
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

describe("Task #1687 — Avis-Import: strukturell + robustes Matching", () => {
  it("AOK-CSV (Betrag an Feld 5) + O→0-Referenz ordnet zu, ohne den Status zu heben", async () => {
    // Rechnungsnummer mit Nullen; die CSV-Referenz verwendet O statt 0.
    const num = "RE-2026-700500";
    const invoiceId = await insertInvoice({ amountCents: 12399, invoiceNumber: num });
    seeded.invoiceIds.push(invoiceId);

    const csv = buildAokCsv({
      ref: "RE-2026-7OO5OO", // O→0 ⇒ RE-2026-700500
      amountEuro: "123,99",
      zahlungsDatum: "15.04.2026",
    });
    const { matched } = await createAdviceWithRawCsv(csv);
    expect(matched).toBe(1); // Betrag wurde strukturell an Feld 5 erkannt.

    expect((await getInvoiceStatus(invoiceId)).status).toBe("versendet");
    expect(await countAudit("invoice_avis_received", invoiceId)).toBe(1);
  });

  it("Betrags-Fallback: garble Referenz ⇒ genau EINE offene Rechnung mit exaktem Brutto", async () => {
    // Einmaliger Betrag ⇒ genau ein Kandidat für den Betrags-Fallback.
    const invoiceId = await insertInvoice({ amountCents: 81237, invoiceNumber: nextInvoiceNumber() });

    // Referenz ist Excel-Exponential-Müll ⇒ keine Rechnungsnummer extrahierbar.
    const csv = buildAokCsv({
      ref: "4,00000061835E+15",
      amountEuro: "812,37",
      zahlungsDatum: "17.04.2026",
      verwendungszweck: "Kein Bezug",
    });
    const { matched } = await createAdviceWithRawCsv(csv);
    expect(matched).toBe(1); // über exakten Bruttobetrag zugeordnet.

    expect((await getInvoiceStatus(invoiceId)).status).toBe("versendet");
    expect(await countAudit("invoice_avis_received", invoiceId)).toBe(1);
  });

  it("GET leitet Unterzahlung (Kürzung) pro Position am Lesepfad ab", async () => {
    const num = nextInvoiceNumber();
    const invoiceId = await insertInvoice({ amountCents: 10000, invoiceNumber: num });

    // Gezahlt 90,00 auf 100,00-Rechnung ⇒ Unterzahlung 10,00 (1000 Cent).
    const csv = buildAokCsv({ ref: num, amountEuro: "90,00", zahlungsDatum: "19.04.2026" });
    const { adviceId, matched } = await createAdviceWithRawCsv(csv);
    expect(matched).toBe(1);
    expect((await getInvoiceStatus(invoiceId)).status).toBe("versendet");

    const res = await apiGet<Array<{
      id: number;
      unterzahlungCents: number;
      items: Array<{ matchedInvoiceId: number | null; unterzahlungCents: number; matchedInvoiceGrossCents: number | null }>;
    }>>("/api/admin/qonto/payment-advices");
    expect(res.status).toBe(200);
    const advice = res.data.find(a => a.id === adviceId);
    expect(advice).toBeDefined();
    expect(advice!.unterzahlungCents).toBe(1000);
    const item = advice!.items.find(i => i.matchedInvoiceId === invoiceId);
    expect(item).toBeDefined();
    expect(item!.matchedInvoiceGrossCents).toBe(10000);
    expect(item!.unterzahlungCents).toBe(1000);
  });
});
