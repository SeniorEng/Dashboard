/**
 * Ticket 6hHW39P2JxmcjvQp — der Trockenlauf des Zahlungs-Abgleichs.
 *
 * ── Warum dieser Test der eigentliche Punkt ist ──────────────────────────
 * Eine Vorschau ist nur so viel wert wie ihre Übereinstimmung mit dem echten
 * Lauf. Ohne Vergleich ist sie eine **Behauptung** — und zwar eine, auf die
 * sich jemand verlässt, bevor er einen Knopf drückt, der Rechnungen auf
 * `bezahlt` setzt.
 *
 * Deshalb fährt dieser Test dieselbe Datenlage **zweimal**: erst trocken, dann
 * echt, und vergleicht die Pläne Eintrag für Eintrag. Weichen sie ab, ist die
 * Vorschau kaputt — nicht der Test.
 *
 * Die Reihenfolge ist zwingend und nicht beliebig: trocken zuerst, weil der
 * echte Lauf die Datenlage verändert. Genau daran liegt auch, dass dieser Test
 * beweist, dass der Trockenlauf NICHTS schreibt — sonst fände der echte Lauf
 * nichts mehr vor.
 *
 * ── Was hier absichtlich mitgemessen wird ────────────────────────────────
 * TL-3 deckt die Reihenfolge-Wirkung ab: zwei Zahlungen auf DIESELBE Rechnung.
 * Im echten Lauf sieht die zweite die kumulierte Summe der ersten und hebt die
 * Rechnung auf `bezahlt`; ein Trockenlauf ohne Überlagerung würde beide als
 * „nur gebunden" zeigen. Das ist die Grenze, die ich vorher benannt habe —
 * hier wird sie geprüft statt zugesagt.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import { invoices, qontoTransactions } from "../../shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { uniqueId, createTestCustomer, cleanupCustomer } from "../test-utils";
import { withGobdMutation } from "../helpers/gobd";
import { qontoService, type AutoMatchPlanEntry } from "../../server/services/qonto";

/**
 * Eigenes Nummern- UND Betrags-Fenster.
 *
 * Der Abgleich scannt ALLE offenen Zahlungen und Rechnungen der Worker-DB —
 * zwei Tests mit gleichem Betrag oder ineinander enthaltenen Rechnungsnummern
 * binden sich gegenseitig quer (dieselbe Falle, die `bulk-advice-match.test.ts`
 * mit seiner Kollisions-Registry adressiert).
 *
 * Die erste Fassung rechnete `8_130_000 % 10000` und erzeugte damit `RE-2026-0`
 * — eine Zeichenfolge, die in JEDER fremden `RE-2026-0xxx` steckt. Da der
 * Matcher ein nackter Teilstring-Vergleich ist (genau der Befund aus Gate 1),
 * griff die Zahlung an einer fremden Rechnung. Der Test hat damit seinen
 * eigenen Prüfgegenstand demonstriert, bevor er ihn prüfen konnte.
 *
 * Jetzt Jahr **2017**: repoweit als Datum frei, und keine andere Testdatei legt
 * `RE-2017-*` an. Dem Matcher ist das Jahr gleichgültig — er vergleicht Zeichen.
 */
const LAUF = 10_000 + Math.floor(Math.random() * 80_000);
const NUMMER = (i: number) => `RE-2017-${LAUF + i}`;
/** Gerade Basis, damit die halbierte Rechnung aus TL-3 glatt aufgeht. */
const BASIS = 1_000_000 + LAUF * 4;

let userId = 0;
let customerId = 0;
const txIds: number[] = [];
const invoiceIds: number[] = [];
const tag = uniqueId();

async function insertInvoice(nummer: string, cents: number): Promise<number> {
  const [row] = await db.insert(invoices).values({
    invoiceNumber: nummer,
    customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: 4,
    billingYear: 2026,
    recipientName: "Trockenlauf",
    grossAmountCents: cents,
    netAmountCents: cents,
    status: "versendet",
  }).returning({ id: invoices.id });
  invoiceIds.push(row.id);
  return row.id;
}

async function insertTx(cents: number, reference: string | null, emittedAt?: Date): Promise<number> {
  const [row] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `qonto-trockenlauf-${tag}-${txIds.length}`,
    amountCents: cents,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt: emittedAt ?? new Date(),
    reference,
  }).returning({ id: qontoTransactions.id });
  txIds.push(row.id);
  return row.id;
}

/** Nur die Einträge dieses Tests — die Worker-DB trägt fremde Zahlungen. */
function nurUnsere(plan: AutoMatchPlanEntry[]): AutoMatchPlanEntry[] {
  return plan
    .filter((e) => txIds.includes(e.transactionId))
    .sort((a, b) => a.transactionId - b.transactionId);
}

/** Vergleichsform: alles, was eine Aussage trägt — ohne Zeitstempel. */
function vergleichbar(plan: AutoMatchPlanEntry[]) {
  return nurUnsere(plan).map((e) => ({
    transactionId: e.transactionId,
    outcome: e.outcome,
    wirkung: e.wirkung,
    confidence: e.confidence,
    invoiceId: e.invoiceId ?? null,
  }));
}

beforeAll(async () => {
  const u = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, vorname, nachname, is_active)
    VALUES (${`trocken-${tag}@example.com`}, 'x', ${`Trocken ${tag}`}, 'Trocken', ${tag}, true)
    RETURNING id
  `);
  userId = Number((u.rows[0] as Record<string, unknown>).id);

  // Der gemeinsame Fixture-Helfer statt eines eigenen INSERT: `customers` hat
  // mehrere NOT-NULL-Spalten, die hier nichts zur Sache tun.
  const kunde = await createTestCustomer({ vorname: "TROCKEN", nachname: `Lauf_${tag}` });
  customerId = kunde.id;

  // (1) Referenz + exakter Betrag  ⇒ „wird bezahlt"
  await insertInvoice(NUMMER(0), BASIS);
  await insertTx(BASIS, `Zahlung ${NUMMER(0)}`);

  // (2) Referenz, Betrag deckt NICHT ⇒ „nur gebunden, bleibt offen"
  await insertInvoice(NUMMER(1), BASIS + 2);
  await insertTx(BASIS - 5_000, `Anzahlung ${NUMMER(1)}`);

  // (3) ZWEI Zahlungen auf dieselbe Rechnung — die Reihenfolge-Wirkung.
  //
  // Die Daten sind AUSDRUECKLICH gesetzt, nicht `new Date()`: der Matcher
  // arbeitet `ORDER BY emitted_at DESC`, die JUENGERE Zahlung kommt also
  // zuerst dran. Mit zwei gleichzeitig eingefuegten Zahlungen haengt die
  // Reihenfolge an Millisekunden — und die erste Fassung dieses Tests hat
  // genau deshalb die falsche Zahlung erwartet.
  const dritte = BASIS + 4;
  await insertInvoice(NUMMER(2), dritte);
  await insertTx(dritte / 2, `Teil A ${NUMMER(2)}`, new Date("2026-05-02T10:00:00Z"));
  await insertTx(dritte / 2, `Teil B ${NUMMER(2)}`, new Date("2026-05-01T10:00:00Z"));

  // (4) Weder Referenz noch eindeutiger Betrag ⇒ „übersprungen"
  await insertTx(BASIS + 7, "SIEHE AVIS");
});

afterAll(async () => {
  if (txIds.length) await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, txIds));
  // Der ECHTE Lauf aus TL-2 hat Rechnungen auf `bezahlt` gesetzt — und eine
  // finalisierte Rechnung zu loeschen verbietet der GoBD-Trigger zu Recht.
  // Das Aufraeumen einer Test-Fixture ist der eine Fall, in dem das erlaubt
  // sein muss; dafuer gibt es die ausdrueckliche Marke.
  if (invoiceIds.length) {
    await withGobdMutation(async (tx) => {
      await tx.delete(invoices).where(inArray(invoices.id, invoiceIds));
    });
  }
  if (customerId) await cleanupCustomer(customerId);
  // Der Test-Benutzer bleibt ABSICHTLICH stehen: der echte Lauf aus TL-2 hat
  // Audit-Eintraege geschrieben, die auf ihn zeigen. Ein Audit-Eintrag ohne
  // Urheber waere schlimmer als eine Karteileiche in einer Wegwerf-DB — und
  // das Audit zu loeschen, um aufzuraeumen, ist genau das, was man bei einer
  // GoBD-Spur nicht tut.
});

describe("Auto-Abgleich — Trockenlauf (6hHW39P2JxmcjvQp)", () => {
  // Zwischen den Fällen geteilt: TL-1 erzeugt die Vorschau, TL-2 den echten
  // Lauf. Bewusst NICHT je Fall neu gefahren — der echte Lauf ist nicht
  // wiederholbar, und genau seine Einmaligkeit ist der Prüfgegenstand.
  let trocken: AutoMatchPlanEntry[] = [];
  let echt: AutoMatchPlanEntry[] = [];

  it("TL-1 – der Trockenlauf plant etwas und schreibt dabei NICHTS", async () => {
    const vorherTx = await db.select({ id: qontoTransactions.id, m: qontoTransactions.matchedInvoiceId })
      .from(qontoTransactions).where(inArray(qontoTransactions.id, txIds));
    const vorherRechnung = await db.select({ id: invoices.id, s: invoices.status })
      .from(invoices).where(inArray(invoices.id, invoiceIds));

    const ergebnis = await qontoService.autoMatch(userId, undefined, { dryRun: true });
    trocken = ergebnis.plan;

    // Er muss überhaupt etwas zu sagen haben — sonst wäre alles Folgende
    // vakuum-wahr.
    expect(nurUnsere(trocken).length, "der Trockenlauf plant nichts").toBe(txIds.length);
    expect(nurUnsere(trocken).some((e) => e.outcome === "invoice_paid")).toBe(true);

    const nachherTx = await db.select({ id: qontoTransactions.id, m: qontoTransactions.matchedInvoiceId })
      .from(qontoTransactions).where(inArray(qontoTransactions.id, txIds));
    const nachherRechnung = await db.select({ id: invoices.id, s: invoices.status })
      .from(invoices).where(inArray(invoices.id, invoiceIds));

    expect(nachherTx, "der Trockenlauf hat Zahlungen gebunden").toEqual(vorherTx);
    expect(nachherRechnung, "der Trockenlauf hat Rechnungs-Status geändert").toEqual(vorherRechnung);
  });

  it("TL-2 – der echte Lauf entscheidet GENAUSO wie die Vorschau", async () => {
    const ergebnis = await qontoService.autoMatch(userId, undefined);
    echt = ergebnis.plan;

    // DIE Zusage. Fällt sie, ist die Vorschau kaputt: jemand liest dann eine
    // Liste, die etwas anderes ankündigt als der Knopf tut.
    expect(vergleichbar(echt)).toEqual(vergleichbar(trocken));
  });

  it("TL-3 – die zweite Zahlung auf dieselbe Rechnung wird in BEIDEN Modi als „bezahlt“ geplant", async () => {
    // Die Grenze, die ich vor dem Bauen benannt habe: der echte Lauf sieht bei
    // der zweiten Zahlung die kumulierte Summe der ersten. Ohne Überlagerung
    // im Trockenlauf stünde hier zweimal „nur gebunden" — und die Vorschau
    // hätte genau an der Stelle gelogen, an der es um Geld geht.
    // `Teil A` ist die JÜNGERE Zahlung und wird deshalb ZUERST verarbeitet
    // (`ORDER BY emitted_at DESC`). Sie deckt die Rechnung nur zur Hälfte;
    // erst die danach verarbeitete `Teil B` schließt sie — und nur, wenn der
    // Trockenlauf die erste Hälfte mitgerechnet hat.
    const [zuerstId, danachId] = txIds.slice(2, 4);

    const zuerst = nurUnsere(trocken).find((e) => e.transactionId === zuerstId)!;
    const danach = nurUnsere(trocken).find((e) => e.transactionId === danachId)!;

    expect(zuerst.outcome, "die zuerst verarbeitete Hälfte dürfte noch nicht bezahlen")
      .toBe("invoice_bound_partial");
    expect(danach.outcome, "die zweite Hälfte muss die Rechnung schließen")
      .toBe("invoice_paid");

    // Und der echte Lauf hat es tatsächlich getan — die Vorschau war keine
    // hübsche Rechnung neben der Wirklichkeit.
    const [rechnung] = await db.select({ status: invoices.status })
      .from(invoices).where(eq(invoices.id, invoiceIds[2]));
    expect(rechnung.status).toBe("bezahlt");
  });

  it("TL-4 – die Vorschau nennt die WIRKUNG, nicht nur die Confidence", async () => {
    // „auto_amount" sagt einem Bediener nicht, ob gleich eine Rechnung bezahlt
    // wird. Genau diese Frage ist der Zweck der Vorschau.
    for (const eintrag of nurUnsere(trocken)) {
      expect(eintrag.wirkung.length, `Eintrag ohne Wirkung: ${JSON.stringify(eintrag)}`)
        .toBeGreaterThan(10);
    }
    const bezahlt = nurUnsere(trocken).find((e) => e.outcome === "invoice_paid")!;
    expect(bezahlt.wirkung).toMatch(/bezahlt/);
    expect(bezahlt.invoiceNumber, "ohne Rechnungsnummer ist die Zeile nicht nachprüfbar").toBeTruthy();

    const uebersprungen = nurUnsere(trocken).find((e) => e.outcome === "skipped");
    expect(uebersprungen, "der unzuordenbare Fall fehlt in der Vorschau").toBeTruthy();
    expect(uebersprungen!.wirkung, "„übersprungen“ ohne Grund hilft niemandem")
      .toMatch(/uebersprungen: .+/);
  });
});
