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

/** Eigenes Jahr, damit die Fixtures dieser Datei in der geteilten CI-DB allein stehen. */
const YEAR = 2033;
const MONTH = 7;
const AS_OF = `${YEAR}-${String(MONTH + 1).padStart(2, "0")}-15`;

/** Selbstzahler: 1.000,00 € netto + 19 % ⇒ 1.190,00 € auf dem Konto. */
const NETTO = 100_000;
const BRUTTO = 119_000;

let customerId = 0;
let ustInvoiceId = 0;
let ustTxId = 0;
let storniertInvoiceId = 0;
let storniertTxId = 0;

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

  // (1) Versendet, voll bezahlt — Brutto aufs Konto, Netto in der Kaskade.
  ustInvoiceId = await insertInvoice({ suffix: "UST", status: "versendet", net: NETTO, gross: BRUTTO });
  ustTxId = await bindPayment(ustInvoiceId, "ust", BRUTTO);
});

afterAll(async () => {
  const txIds = [ustTxId, storniertTxId].filter(Boolean);
  if (txIds.length > 0) {
    await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, txIds));
  }
  const ids = [ustInvoiceId, storniertInvoiceId].filter(Boolean);
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

describe("Umsatz-Kachel — die Zeile „davon bereits eingegangen“", () => {
  it("RC-1 – der Eingang steht auf derselben Basis wie die Schlagzeile (netto, nicht brutto)", async () => {
    const t = await totals();

    // 1.190,00 € sind geflossen, 1.000,00 € standen als Forderung in der
    // Kaskade. Gezeigt werden muss der Netto-Gegenwert — sonst behauptet die
    // Zeile einen Eingang, der die Erwartung um 19 % übersteigt.
    expect(
      t.receivedCents,
      "Brutto-Betrag durchgereicht statt auf Netto-Basis gebracht",
    ).toBeGreaterThanOrEqual(NETTO);
    expect(
      t.receivedCents,
      `${BRUTTO} wäre der Kontobetrag — die Kaskade rechnet aber netto`,
    ).toBeLessThan(BRUTTO);
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
});
