/**
 * Ticket 6hWgVqw2C8442hcG — „davon bereits eingegangen" in der Umsatz-Kachel.
 *
 * ── Warum dieser Test existiert ──────────────────────────────────────────
 * Die Kaskaden-Tests (`tests/unit/pipeline-kaskade.test.ts`) prüfen reine
 * Arithmetik über `summarizePipelineCents`. Genau die Teile, die tatsächlich
 * falsch sein können, stecken aber NICHT dort, sondern im Reader: welche
 * Rechnungsmenge gezählt wird, und auf welcher Basis.
 *
 * Beide waren in der ersten Fassung falsch, und beide auf eine Art, die man
 * auf dem Bildschirm für plausibel hält:
 *
 *   1. BASIS. Die Kaskade rechnet netto (`netAmountCents`), eine Überweisung
 *      ist brutto. Eine voll bezahlte Netto-1.000-€-Selbstzahler-Rechnung
 *      zeigte „erwartet 1.000,00 € — davon eingegangen 1.190,00 €". 119 %
 *      eines Betrags, aus dem nie 1.190 € erwartet wurden.
 *
 *   2. MENGE. Gefiltert wurde auf `invoiceType === "stornorechnung"`. Eine
 *      stornierte ORIGINALrechnung behält aber Typ `rechnung` und bekommt nur
 *      `status = 'storniert'` — ihr Betrag fällt damit aus der Schlagzeile,
 *      ihre gebundene Zahlung blieb drin (der Storno löst die Qonto-Bindung
 *      nicht). Ergebnis: „erwartet 0,00 €, davon eingegangen 500,00 €".
 *
 * Das Wort „davon" ist die ganze Zusage dieser Zeile. Diese Tests prüfen sie
 * als Zusage, nicht die Einzelbeträge.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import { customers, invoices, qontoTransactions } from "../../shared/schema";
import { eq, inArray } from "drizzle-orm";
import { uniqueId } from "../test-utils";
import { withGobdMutation } from "../helpers/gobd";
import { readBillingPipeline } from "../../server/storage/billing/pipeline-reader";

/**
 * Eigenes MONATS-Fenster, damit die Fixtures dieser Datei in der geteilten
 * CI-DB niemandem in die Quere kommen: `readBillingPipeline` liest alles, was
 * im selben Abrechnungsmonat liegt.
 *
 * Das Jahr allein reicht dafür NICHT — 2033 benutzen ausserdem
 * `equality/no-show-wage-ssot` (Monat 7), `equality/no-show-kilometers-ssot`
 * und `billing/invoice-number-never-reused` (beide Monat 5). Massgeblich ist
 * das Paar; 2033/9 ist frei. Wer hier etwas ändert, prüft `grep -rn "YEAR ="
 * tests/` gegen den neuen Monat.
 *
 * Die Tests messen zusätzlich DIFFERENZEN zweier Messungen statt Absolutwerte,
 * damit ein fremder Eintrag im selben Fenster sie nicht rot färbt.
 */
const YEAR = 2033;
const MONTH = 9;
const AS_OF = `${YEAR}-${String(MONTH + 1).padStart(2, "0")}-15`;

/** Selbstzahler: 1.000,00 € netto + 19 % ⇒ 1.190,00 € auf dem Konto. */
const NETTO = 100_000;
const BRUTTO = 119_000;

let customerId = 0;
let ustInvoiceId = 0;
let ustTxId = 0;
let storniertInvoiceId = 0;
let storniertTxId = 0;
let ueberzahltInvoiceId = 0;
let ueberzahltTxId = 0;
let teilInvoiceId = 0;
let teilTxId = 0;
let vollInvoiceId = 0;
let vollTxId = 0;

async function insertInvoice(opts: {
  suffix: string;
  status: string;
  net: number;
  gross: number;
}): Promise<number> {
  const [row] = await db.insert(invoices).values({
    invoiceNumber: `KASK-${opts.suffix}-${uniqueId()}`,
    customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: MONTH,
    billingYear: YEAR,
    recipientName: "Test",
    netAmountCents: opts.net,
    vatAmountCents: opts.gross - opts.net,
    grossAmountCents: opts.gross,
    status: opts.status,
    dueDate: `${YEAR}-${String(MONTH).padStart(2, "0")}-02`,
  } as any).returning({ id: invoices.id });
  return row.id;
}

async function bindPayment(invoiceId: number, tag: string, paidCents: number): Promise<number> {
  const [tx] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `kask-${tag}-${uniqueId()}`,
    amountCents: paidCents,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt: new Date(`${YEAR}-${String(MONTH).padStart(2, "0")}-10T10:00:00Z`),
    matchedInvoiceId: invoiceId,
    matchConfidence: "high",
  } as any).returning({ id: qontoTransactions.id });
  return tx.id;
}

beforeAll(async () => {
  const tag = uniqueId();
  const [cust] = await db.insert(customers).values({
    name: `KASK-${tag}`,
    vorname: "Kaskade",
    nachname: `Eingang-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  } as any).returning({ id: customers.id });
  customerId = cust.id;

  // Grundlast, damit RC-2/RC-4 („davon" hält) nicht auf einer leeren Kachel
  // trivial grün werden: eine versendete, voll bezahlte Rechnung.
  ustInvoiceId = await insertInvoice({ suffix: "UST", status: "versendet", net: NETTO, gross: BRUTTO });
  ustTxId = await bindPayment(ustInvoiceId, "ust", BRUTTO);
});

afterAll(async () => {
  const txIds = [ustTxId, storniertTxId, ueberzahltTxId, teilTxId, vollTxId].filter(Boolean);
  if (txIds.length > 0) {
    await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, txIds));
  }
  const ids = [ustInvoiceId, storniertInvoiceId, ueberzahltInvoiceId, teilInvoiceId, vollInvoiceId].filter(Boolean);
  if (ids.length > 0) {
    // Gestellte Rechnungen sind GoBD-geschützt (invoices_prevent_finalized_delete).
    await withGobdMutation(async (tx) => {
      await tx.delete(invoices).where(inArray(invoices.id, ids));
    });
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

/**
 * Anteil UNSERER Fixture am jeweiligen Gesamtwert. Gegen die Gesamtsumme zu
 * prüfen ginge in der geteilten CI-DB schief — dort tragen fremde Zeilen
 * desselben Monats mit. Deshalb wird jeweils die DIFFERENZ zweier Messungen
 * betrachtet, nicht der Absolutwert.
 */
async function totals() {
  const b = await readBillingPipeline(YEAR, MONTH, AS_OF);
  return b.totals;
}

/**
 * REIHENFOLGE-ABHÄNGIG: die Tests bauen aufeinander auf (RC-2 prüft den Stand
 * nach RC-1, RC-4 den nach RC-3). Das ist mit der Vitest-Standardsequenz
 * korrekt; ein `sequence.shuffle` in der Konfiguration bräche sie.
 */
describe("Umsatz-Kachel — die Zeile „davon bereits eingegangen“", () => {
  it("RC-1 – der Eingang steht auf derselben Basis wie die Schlagzeile (netto, nicht brutto)", async () => {
    // Gemessen als DIFFERENZ, nicht als Bereich auf dem globalen Wert: ein
    // Faktor-Fehler, der irgendwo zwischen netto und brutto landet, käme
    // durch eine Bereichsprüfung durch.
    const vorher = await totals();

    vollInvoiceId = await insertInvoice({
      suffix: "VOLL", status: "versendet", net: NETTO, gross: BRUTTO,
    });
    vollTxId = await bindPayment(vollInvoiceId, "voll", BRUTTO);

    const danach = await totals();
    // 1.190,00 € sind geflossen, 1.000,00 € standen als Forderung in der
    // Kaskade. Zugehen darf genau der Netto-Gegenwert — sonst behauptet die
    // Zeile einen Eingang, der die Erwartung um 19 % übersteigt.
    expect(
      danach.receivedCents - vorher.receivedCents,
      `${BRUTTO} wäre der Kontobetrag — die Kaskade rechnet aber netto`,
    ).toBe(NETTO);
  });

  it("RC-2 – „davon“ hält: der Eingang übersteigt den erwarteten Kontoeingang nicht", async () => {
    const t = await totals();
    expect(
      t.receivedCents,
      "eine Teilmenge kann nicht größer sein als die Menge",
    ).toBeLessThanOrEqual(t.expectedRevenueTotalCents);
  });

  it("RC-3 – eine STORNIERTE Originalrechnung nimmt ihre Zahlung aus dem Eingang mit", async () => {
    // Der Fall, den die Typ-Prüfung auf `stornorechnung` nicht sah: Typ bleibt
    // `rechnung`, nur der Status wechselt. Fällt der Betrag aus der Schlagzeile,
    // MUSS auch sein Eingang verschwinden — sonst steht unter einer um 500 €
    // geschrumpften Erwartung ein unveränderter Eingang.
    const vorher = await totals();

    storniertInvoiceId = await insertInvoice({
      suffix: "STORNO", status: "versendet", net: NETTO, gross: BRUTTO,
    });
    storniertTxId = await bindPayment(storniertInvoiceId, "storno", BRUTTO);

    const bezahlt = await totals();
    expect(
      bezahlt.receivedCents,
      "solange sie versendet ist, zählt ihre Zahlung mit",
    ).toBeGreaterThan(vorher.receivedCents);
    const beitrag = bezahlt.receivedCents - vorher.receivedCents;

    await withGobdMutation(async (tx) => {
      await tx.update(invoices)
        .set({ status: "storniert" })
        .where(eq(invoices.id, storniertInvoiceId));
    });

    const danach = await totals();
    expect(
      danach.expectedRevenueTotalCents,
      "die stornierte Forderung fällt aus der Schlagzeile",
    ).toBeLessThan(bezahlt.expectedRevenueTotalCents);
    expect(
      bezahlt.receivedCents - danach.receivedCents,
      "…und ihr Eingang fällt in GLEICHEM Mass mit heraus",
    ).toBe(beitrag);
    expect(
      danach.receivedCents,
      "Gegenrichtung: der Eingang der anderen Rechnung bleibt unangetastet",
    ).toBe(vorher.receivedCents);
  });

  it("RC-4 – „davon“ hält auch nach dem Storno", async () => {
    const t = await totals();
    expect(t.receivedCents).toBeLessThanOrEqual(t.expectedRevenueTotalCents);
  });

  it("RC-6 – eine TEILZAHLUNG wird anteilig umgerechnet, nicht bloss gedeckelt", async () => {
    // Die Lücke, die RC-1/RC-3/RC-5 offen lassen: bei Voll- und Überzahlung
    // liefern `round(paid · netto/brutto)` und ein simples `min(paid, netto)`
    // DENSELBEN Wert. Wer die Proration ersatzlos durch den Deckel ersetzt,
    // bliebe dort grün — und beim nächsten Teilbetrag stünde wieder Brutto
    // auf dem Schirm.
    //
    // Halbe Brutto-Zahlung auf netto 1.000 / brutto 1.190:
    //   proriert  59.500 · 100.000 / 119.000 = 50.000  ← richtig
    //   gedeckelt min(59.500, 100.000)       = 59.500  ← der Fehler
    const vorher = await totals();

    teilInvoiceId = await insertInvoice({
      suffix: "TEIL", status: "versendet", net: NETTO, gross: BRUTTO,
    });
    teilTxId = await bindPayment(teilInvoiceId, "teil", BRUTTO / 2);

    const danach = await totals();
    expect(
      danach.receivedCents - vorher.receivedCents,
      "halbe Zahlung ⇒ halber Netto-Anteil, nicht der halbe Brutto-Betrag",
    ).toBe(NETTO / 2);
  });

  it("RC-5 – eine ÜBERZAHLUNG hebt den Eingang nicht über die Forderung", async () => {
    // Der leisere Bruch derselben Zusage: 1.300 € auf eine Rechnung mit
    // 1.190 € brutto / 1.000 € netto. Ohne Deckel ergäbe die Proration
    // 1.092,44 € — mehr, als von dieser Rechnung je erwartet wurde, und die
    // Gesamtsumme stiege wieder über die Schlagzeile.
    //
    // Überzahlungen kommen vor (Fixture „600 auf 500 EUR" in
    // `payment-bound-read-side.test.ts`). Der Überhang ist eine eigene
    // fachliche Tatsache und steht in der Rechnungsliste, nicht hier.
    const vorher = await totals();

    ueberzahltInvoiceId = await insertInvoice({
      suffix: "UEBER", status: "versendet", net: NETTO, gross: BRUTTO,
    });
    ueberzahltTxId = await bindPayment(ueberzahltInvoiceId, "ueber", BRUTTO + 11_000);

    const danach = await totals();
    expect(
      danach.receivedCents - vorher.receivedCents,
      "höchstens der Netto-Betrag DIESER Rechnung darf zugehen",
    ).toBe(NETTO);
    expect(
      danach.receivedCents,
      "…und „davon“ hält damit auch hier",
    ).toBeLessThanOrEqual(danach.expectedRevenueTotalCents);
  });
});
