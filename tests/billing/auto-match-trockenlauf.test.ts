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
import {
  auditLog, invoices, qontoTransactions, paymentAdvices, paymentAdviceItems,
} from "../../shared/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
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
const adviceIds: number[] = [];

/**
 * Zahlungen beim NAMEN, nicht beim Index.
 *
 * Die erste Fassung griff mit `txIds.slice(6, 8)` zu — und als zwei Faelle
 * dazwischen kamen, zeigte der Zugriff auf andere Zahlungen. Der Test wurde
 * rot, ohne dass sich der Pruefgegenstand geaendert hatte. Ein Index ist
 * keine Aussage darueber, was gemeint ist.
 */
const zahlung: Record<string, number> = {};
const tag = uniqueId();

async function insertInvoice(nummer: string, cents: number, status = "versendet"): Promise<number> {
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
    status,
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
  zahlung.exakt = await insertTx(BASIS, `Zahlung ${NUMMER(0)}`);

  // (2) Referenz, Betrag deckt NICHT ⇒ „nur gebunden, bleibt offen"
  await insertInvoice(NUMMER(1), BASIS + 2);
  zahlung.unterdeckung = await insertTx(BASIS - 5_000, `Anzahlung ${NUMMER(1)}`);

  // (3) ZWEI Zahlungen auf dieselbe Rechnung — die Reihenfolge-Wirkung.
  //
  // Die Daten sind AUSDRUECKLICH gesetzt, nicht `new Date()`: der Matcher
  // arbeitet `ORDER BY emitted_at DESC`, die JUENGERE Zahlung kommt also
  // zuerst dran. Mit zwei gleichzeitig eingefuegten Zahlungen haengt die
  // Reihenfolge an Millisekunden — und die erste Fassung dieses Tests hat
  // genau deshalb die falsche Zahlung erwartet.
  const dritte = BASIS + 4;
  await insertInvoice(NUMMER(2), dritte);
  zahlung.haelfteZuerst = await insertTx(dritte / 2, `Teil A ${NUMMER(2)}`, new Date("2026-05-02T10:00:00Z"));
  zahlung.haelfteDanach = await insertTx(dritte / 2, `Teil B ${NUMMER(2)}`, new Date("2026-05-01T10:00:00Z"));

  // (4) Weder Referenz noch eindeutiger Betrag ⇒ „übersprungen"
  zahlung.ohneZuordnung = await insertTx(BASIS + 7, "SIEHE AVIS");

  // (5) ENTWURFS-Rechnung — Gate-2-Fund B1.
  // Sie steht bewusst in der Kandidatenliste des Matchers, kann aber von
  // keinem Schreibpfad gebunden werden (`statusesAllowedToTransitionTo`
  // liefert nur `versendet`). Die erste Fassung der Vorschau kündigte hier
  // „wird auf bezahlt gesetzt" an; der echte Lauf rollte zurück.
  await insertInvoice(NUMMER(3), BASIS + 12, "entwurf");
  zahlung.aufEntwurf = await insertTx(BASIS + 12, `Zahlung ${NUMMER(3)}`);

  // (7) SAMMEL-AVIS — der Zweig, der einen ganzen Stapel bewegt, und der
  // einzige mit eigenem fruehen Ausstieg im Trockenlauf (Gate-2-Fund S1).
  // Ohne diesen Fall vergliche TL-2 den Bulk-Pfad ueberhaupt nicht.
  const avisA = BASIS + 20;
  const avisB = BASIS + 24;
  const rAvisA = await insertInvoice(NUMMER(5), avisA);
  const rAvisB = await insertInvoice(NUMMER(6), avisB);
  const [avis] = await db.insert(paymentAdvices).values({
    fileName: `trockenlauf-${tag}.csv`,
    format: "manuell",
    gesamtBetragCents: avisA + avisB,
    kostentraegerName: "Testkasse",
  }).returning({ id: paymentAdvices.id });
  adviceIds.push(avis.id);
  await db.insert(paymentAdviceItems).values([
    { paymentAdviceId: avis.id, betragCents: avisA, matchedInvoiceId: rAvisA },
    { paymentAdviceId: avis.id, betragCents: avisB, matchedInvoiceId: rAvisB },
  ]);
  // Ohne Rechnungsnummer im Text — sonst gewinnt der Einzel-Pfad.
  zahlung.sammel = await insertTx(avisA + avisB, "Sammelzahlung Testkasse");

  // (8) REINER BETRAGS-TREFFER OHNE BELEG ⇒ Pruef-Zustand. Der zweite Zweig,
  // den der Plan-Vergleich bisher nicht beruehrt hat.
  await insertInvoice(NUMMER(7), BASIS + 28);
  zahlung.nurBetrag = await insertTx(BASIS + 28, "Ueberweisung Eingang");

  // (6) ZWEITE VOLLE Zahlung auf dieselbe Rechnung — die Umkehrung von TL-3.
  // Die erste schließt die Rechnung, die zweite läuft im echten Lauf auf.
  const doppelt = BASIS + 16;
  await insertInvoice(NUMMER(4), doppelt);
  zahlung.vollZuerst = await insertTx(doppelt, `Voll A ${NUMMER(4)}`, new Date("2026-05-04T10:00:00Z"));
  zahlung.vollDanach = await insertTx(doppelt, `Voll B ${NUMMER(4)}`, new Date("2026-05-03T10:00:00Z"));
});

afterAll(async () => {
  if (txIds.length) await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, txIds));
  if (adviceIds.length) {
    await db.delete(paymentAdviceItems).where(inArray(paymentAdviceItems.paymentAdviceId, adviceIds));
    await db.delete(paymentAdvices).where(inArray(paymentAdvices.id, adviceIds));
  }
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
    // Alle vier Spalten, die ein Schreibpfad anfassen könnte — die erste
    // Fassung prüfte nur zwei, und `matchedPaymentAdviceId` ist ausgerechnet
    // die, die der Bulk-Pfad schriebe (Gate-2-Fund S4).
    const zustandTx = () => db.select({
      id: qontoTransactions.id,
      rechnung: qontoTransactions.matchedInvoiceId,
      avis: qontoTransactions.matchedPaymentAdviceId,
      confidence: qontoTransactions.matchConfidence,
    }).from(qontoTransactions).where(inArray(qontoTransactions.id, txIds));
    const zustandRechnung = () => db.select({
      id: invoices.id, s: invoices.status, bezahltAm: invoices.paidAt,
    }).from(invoices).where(inArray(invoices.id, invoiceIds));
    /**
     * Audit-Zeilen ZU UNSEREN Entitaeten — nicht `count(*)` ueber die ganze
     * Tabelle.
     *
     * So stand es hier zuerst, und es war falsch gemessen: unter dem
     * Orchestrator teilen sich mehrere Testdateien eine Wegwerf-DB, und eine
     * gleichzeitig laufende Datei hebt den globalen Zaehler zwischen den
     * beiden Lesungen. Belegt am 21.09.2026 — waehrend dieses Trockenlaufs
     * erschien ein `invoice_avis_received` zu einer fremden Rechnung, das der
     * Avis-Import einer anderen Datei geschrieben hatte.
     *
     * Der globale Zaehler sollte maximale Deckung geben; tatsaechlich hat er
     * eine Zusage geprueft, die dieser Test gar nicht kontrolliert, und ist
     * genau daran rot geworden — ein Fehlalarm, der wie ein Leck aussieht.
     * Geprueft wird jetzt, was der Trockenlauf anfassen koennte: die
     * Rechnungen und Avise DIESES Falls.
     *
     * ── Was die Verengung KOSTET, damit es nicht spaeter als geprueft gilt ──
     * Ein Schreibvorgang auf eine FREMDE Entitaet faellt jetzt durch. Wuerde
     * der Trockenlauf einen Audit-Eintrag zu einer Rechnung schreiben, die
     * dieser Test nicht angelegt hat, bliebe der Zaehler bei 0 und der Test
     * gruen. Die Gegenprobe (ein kuenstlich eingebautes Leck im
     * Trockenlauf-Zweig, ausgefuehrt: `expected 5 to be 0`) belegt den eigenen
     * Fall — nicht den fremden.
     *
     * Das ist eine bewusste Abwaegung, kein Versehen: in einer geteilten DB
     * ist der fremde Fall nicht messbar, ohne Nachbarn mitzuzaehlen. Die
     * Diagnosefrage dahinter lautet nicht „ist die Messung korrekt", sondern
     * „deckt sich der gemessene Bereich exakt mit der Zusage?" — und wo er es
     * nicht tut, gehoert die Luecke benannt statt stillschweigend geschlossen.
     */
    const auditZahl = async () => {
      const zeilen = await db.select({ id: auditLog.id })
        .from(auditLog)
        .where(or(
          and(eq(auditLog.entityType, "invoice"), inArray(auditLog.entityId, invoiceIds)),
          and(eq(auditLog.entityType, "payment_advice"), inArray(auditLog.entityId, adviceIds)),
        ));
      return zeilen.length;
    };

    const vorherTx = await zustandTx();
    const vorherRechnung = await zustandRechnung();
    const vorherAudit = await auditZahl();

    const ergebnis = await qontoService.autoMatch(userId, undefined, { dryRun: true });
    trocken = ergebnis.plan;

    // Er muss überhaupt etwas zu sagen haben — sonst wäre alles Folgende
    // vakuum-wahr.
    expect(nurUnsere(trocken).length, "der Trockenlauf plant nichts").toBe(txIds.length);
    expect(nurUnsere(trocken).some((e) => e.outcome === "invoice_paid")).toBe(true);

    expect(await zustandTx(), "der Trockenlauf hat Zahlungen gebunden").toEqual(vorherTx);
    expect(await zustandRechnung(), "der Trockenlauf hat Rechnungs-Status geändert").toEqual(vorherRechnung);
    // Der Wächter, der die Zusage HÄLT, wenn jemand den `if (dryRun)`-Block
    // später verschiebt: jeder Schreibpfad hier schreibt auch ein Audit.
    expect(await auditZahl(), "der Trockenlauf hat Audit-Einträge geschrieben").toBe(vorherAudit);
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
    const zuerst = nurUnsere(trocken).find((e) => e.transactionId === zahlung.haelfteZuerst)!;
    const danach = nurUnsere(trocken).find((e) => e.transactionId === zahlung.haelfteDanach)!;

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

  it("TL-5 – eine ENTWURFS-Rechnung wird NICHT als „wird bezahlt“ angekündigt", () => {
    // Gate-2-Fund B1, Fall (a). Der Matcher nimmt Entwürfe als Kandidaten auf,
    // jeder Schreibpfad lehnt sie ab. Die Vorschau muss das vorher sagen —
    // sonst kündigt sie eine Buchung an, die nie stattfindet.
    const eintrag = nurUnsere(trocken).find((e) => e.transactionId === zahlung.aufEntwurf)!;
    expect(eintrag.outcome, "Entwurf als bezahlbar angekündigt").toBe("skipped");
    expect(eintrag.wirkung, "der Grund nennt den Status nicht").toMatch(/entwurf/i);
  });

  it("TL-6 – die zweite VOLLE Zahlung wird als übersprungen angekündigt", () => {
    // Gate-2-Fund B1, Fall (b), und die Umkehrung von TL-3: dort ergänzen sich
    // zwei Hälften, hier schließt schon die erste Zahlung die Rechnung. Die
    // zweite kann dann nichts mehr — auch nicht „binden und flaggen".
    const zuerst = nurUnsere(trocken).find((e) => e.transactionId === zahlung.vollZuerst)!;
    const danach = nurUnsere(trocken).find((e) => e.transactionId === zahlung.vollDanach)!;

    expect(zuerst.outcome).toBe("invoice_paid");
    expect(danach.outcome, "zweite Vollzahlung als buchbar angekündigt").toBe("skipped");
    expect(danach.wirkung).toMatch(/bereits geschlossen/);
  });

  it("TL-7 – der Sammel-Avis steht mit der WIRKSAMEN Rechnungszahl in beiden Plänen", () => {
    // Gate-2-Fund S2: die Vorschau nannte die KANDIDATEN-Zahl
    // (`openInvoiceIds.length`), das Audit schreibt die tatsächlich
    // geschriebene (`invoiceUpdate.length`). Bei einer Zeile, die einen
    // 23-Rechnungen-Stapel ankündigt, ist das die wichtigste Zahl auf dem
    // Schirm — und zwei Modi, die einig sind und beide danebenliegen, fängt
    // der Plan-Vergleich per Konstruktion nicht.
    const bulkTrocken = nurUnsere(trocken).find((e) => e.outcome === "bulk_advice_paid");
    expect(bulkTrocken, "der Sammel-Avis-Fall fehlt in der Vorschau").toBeTruthy();
    expect(bulkTrocken!.adviceInvoiceCount, "angekündigte Rechnungszahl stimmt nicht").toBe(2);
    expect(bulkTrocken!.wirkung).toMatch(/2 Rechnung\(en\) werden auf/);

    const bulkEcht = nurUnsere(echt).find((e) => e.outcome === "bulk_advice_paid");
    expect(bulkEcht?.adviceInvoiceCount, "der echte Lauf hat eine andere Zahl geschrieben").toBe(2);
  });

  it("TL-8 – der Prüf-Zustand wird in beiden Modi als solcher angekündigt", () => {
    // Der zweite Zweig mit eigenem Plan-Eintrag, den TL-2 vorher nicht berührt
    // hat: reiner Betrags-Treffer ohne Beleg im Verwendungszweck. Er darf NICHT
    // als „wird bezahlt" erscheinen — seit #1864 bindet er nur.
    const pruef = nurUnsere(trocken).find((e) => e.outcome === "invoice_bound_review");
    expect(pruef, "der Prüf-Fall fehlt in der Vorschau").toBeTruthy();
    expect(pruef!.confidence).toBe("auto_amount_review");
    expect(pruef!.wirkung).toMatch(/Pr(ü|ue)f-Zustand/);
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
