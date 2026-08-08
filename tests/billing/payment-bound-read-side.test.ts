/**
 * #1897 — Lese-Seite des Qonto-Zahlungsstands.
 *
 * Die Schreib-Seite (Status aus dem kumulierten Zahlungsstand, Task #1822) war
 * bereits korrekt; die Lese-Seite kannte die Zahlungsbindung nicht. Folge im
 * Betrieb: eine Rechnung mit gebundener, aber noch nicht freigegebener Zahlung
 * blieb auf `versendet`/`avis_erhalten`, alterte weiter und wurde als
 * „überfällig" gezählt — die Abrechnung mahnte Geld an, das auf dem Konto lag.
 *
 * Geprüft:
 *   (a) Cockpit-Reader: gebundene Rechnung altert nicht mehr und zählt nicht
 *       mehr in `overdueCount`. Die ungebundene Kontroll-Rechnung desselben
 *       Monats altert weiter — sonst würde der Test auch dann grün, wenn das
 *       Aging pauschal abgeschaltet wäre.
 *   (b) Listen-Endpunkt: liefert Bindung, gebundenen Betrag und Differenz für
 *       JEDE offene Rechnung — nicht nur für `teilweise_bezahlt`.
 *   (c) Ungebundene offene Rechnung trägt `hasBoundPayment: false` (der Client
 *       soll nicht zwischen „nicht gebunden" und „Feld fehlt" raten müssen).
 *   (d) Der Bestandsvertrag aus Task #1822 (`paidCents`/`openAmountCents` bei
 *       `teilweise_bezahlt`) bleibt unverändert bedient.
 *
 * Die Cluster-Zuordnung selbst (reine Funktion) ist im Architektur-Test
 * `tests/architecture/billing-pipeline-stage-identity.test.ts` verankert.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import {
  customers,
  invoices,
  qontoTransactions,
} from "../../shared/schema";
import { eq, inArray } from "drizzle-orm";
import { apiGet, uniqueId } from "../test-utils";
import { withGobdMutation } from "../helpers/gobd";
import { readBillingPipeline } from "../../server/storage/billing/pipeline-reader";

const YEAR = 2031;
const MONTH = 4;
/** >30 Tage über Fälligkeit ⇒ Selbstzahler-Bucket „rot" (billing-pipeline.ts:466-469). */
const AS_OF = `${YEAR}-${String(MONTH + 2).padStart(2, "0")}-15`;
const DUE = `${YEAR}-${String(MONTH).padStart(2, "0")}-02`;

let customerId = 0;
let boundInvoiceId = 0;
let unboundInvoiceId = 0;
let partialInvoiceId = 0;
let qontoTxId = 0;
let overpaidInvoiceId = 0;
let overpaidTxId = 0;
let kasseInvoiceId = 0;
let kasseTxId = 0;
let paidInvoiceId = 0;
const GROSS = 50_000;

async function insertInvoice(opts: { suffix: string; status: string; gross: number; billingType?: string }): Promise<number> {
  const [row] = await db.insert(invoices).values({
    invoiceNumber: `P1897-${opts.suffix}-${uniqueId()}`,
    customerId,
    billingType: opts.billingType ?? "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: MONTH,
    billingYear: YEAR,
    recipientName: "Test",
    grossAmountCents: opts.gross,
    netAmountCents: opts.gross,
    status: opts.status,
    dueDate: DUE,
  } as any).returning({ id: invoices.id });
  return row.id;
}

/** Bindet die Transaktion 1:1 an die Rechnung — derselbe Weg wie der Einzel-Match. */
async function bindPayment(invoiceId: number, txId: number, paidCents: number): Promise<void> {
  await db.update(qontoTransactions)
    .set({ matchedInvoiceId: invoiceId, matchConfidence: "high", amountCents: paidCents })
    .where(eq(qontoTransactions.id, txId));
}

async function board() {
  return readBillingPipeline(YEAR, MONTH, AS_OF);
}

function cardIn(b: Awaited<ReturnType<typeof board>>, invoiceId: number) {
  for (const grp of b.stages) {
    const card = grp.cards.find((c) => c.invoiceId === invoiceId);
    if (card) return { card, stage: grp.stage, overdueCount: grp.overdueCount };
  }
  return null;
}

/**
 * Zahl der ROTEN Karten UNSERER Rechnungen in der Stufe. `overdueCount` der
 * Gruppe taugt als Assertion nicht: beide Fixtures liegen in derselben Stufe,
 * der Zaehler ist also fuer beide identisch, und in der geteilten CI-DB traegt
 * er zusaetzlich fremde Rechnungen. Ein Mutant, der die Bindung faelschlich
 * MITZAEHLT, bliebe daran unentdeckt.
 */
function ourRedCards(b: Awaited<ReturnType<typeof board>>, ids: number[]): number[] {
  const red: number[] = [];
  for (const grp of b.stages) {
    for (const c of grp.cards) {
      if (c.invoiceId != null && ids.includes(c.invoiceId) && c.aging === "red") red.push(c.invoiceId);
    }
  }
  return red;
}

beforeAll(async () => {
  const tag = uniqueId();
  const [cust] = await db.insert(customers).values({
    name: `P1897-${tag}`,
    vorname: "Zahlung",
    nachname: `Lese-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  } as any).returning({ id: customers.id });
  customerId = cust.id;

  boundInvoiceId = await insertInvoice({ suffix: "BOUND", status: "versendet", gross: GROSS });
  unboundInvoiceId = await insertInvoice({ suffix: "FREI", status: "versendet", gross: GROSS });
  partialInvoiceId = await insertInvoice({ suffix: "TEIL", status: "teilweise_bezahlt", gross: GROSS });

  const [tx] = await db.insert(qontoTransactions).values({
    qontoTransactionId: `p1897-${tag}`,
    amountCents: GROSS,
    currency: "EUR",
    side: "credit",
    status: "completed",
    emittedAt: new Date(`${YEAR}-${String(MONTH).padStart(2, "0")}-10T10:00:00Z`),
  } as any).returning({ id: qontoTransactions.id });
  qontoTxId = tx.id;

  await bindPayment(boundInvoiceId, qontoTxId, GROSS);

  // Ueberzahlung: 600 EUR auf 500 EUR Brutto ⇒ overpaid, Status bleibt stehen.
  overpaidInvoiceId = await insertInvoice({ suffix: "UEBER", status: "versendet", gross: GROSS });
  overpaidTxId = (await db.insert(qontoTransactions).values({
    qontoTransactionId: `p1897-ueber-${tag}`, amountCents: GROSS + 10_000, currency: "EUR",
    side: "credit", status: "completed", emittedAt: new Date(),
  } as any).returning({ id: qontoTransactions.id }))[0].id;
  await bindPayment(overpaidInvoiceId, overpaidTxId, GROSS + 10_000);

  // Pflegekassen-Pfad im Status `avis_erhalten` — der zweite Warte-Cluster.
  kasseInvoiceId = await insertInvoice({
    suffix: "KASSE", status: "avis_erhalten", gross: GROSS, billingType: "pflegekasse_gesetzlich",
  });
  kasseTxId = (await db.insert(qontoTransactions).values({
    qontoTransactionId: `p1897-kasse-${tag}`, amountCents: GROSS, currency: "EUR",
    side: "credit", status: "completed", emittedAt: new Date(),
  } as any).returning({ id: qontoTransactions.id }))[0].id;
  await bindPayment(kasseInvoiceId, kasseTxId, GROSS);

  // Abgeschlossen — darf vom Endpunkt NICHT angereichert werden.
  paidInvoiceId = await insertInvoice({ suffix: "BEZAHLT", status: "bezahlt", gross: GROSS });
});

afterAll(async () => {
  const txIds = [qontoTxId, overpaidTxId, kasseTxId].filter(Boolean);
  if (txIds.length > 0) await db.delete(qontoTransactions).where(inArray(qontoTransactions.id, txIds));
  const ids = [boundInvoiceId, unboundInvoiceId, partialInvoiceId, overpaidInvoiceId, kasseInvoiceId, paidInvoiceId].filter(Boolean);
  if (ids.length > 0) {
    // Gestellte Rechnungen sind GoBD-geschuetzt (invoices_prevent_finalized_delete).
    await withGobdMutation(async (tx) => {
      await tx.delete(invoices).where(inArray(invoices.id, ids));
    });
  }
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

describe("#1897 — gebundene Zahlung auf der Lese-Seite", () => {
  it("(a) Cockpit-Reader: gebundene Rechnung altert nicht, ungebundene schon", async () => {
    const b = await board();
    const bound = cardIn(b, boundInvoiceId);
    const unbound = cardIn(b, unboundInvoiceId);

    expect(bound, "gebundene Rechnung muss im Board auftauchen").not.toBeNull();
    expect(unbound, "ungebundene Rechnung muss im Board auftauchen").not.toBeNull();

    // Die Kontroll-Rechnung altert — sonst wäre (a) auch bei pauschal
    // abgeschaltetem Aging grün.
    expect(unbound!.card.aging).toBe("red");
    // Die gebundene nicht. Kein Geld anmahnen, das da ist.
    expect(bound!.card.aging).toBe("none");

    // Von unseren beiden Rechnungen ist genau die ungebundene rot.
    expect(ourRedCards(b, [boundInvoiceId, unboundInvoiceId])).toEqual([unboundInvoiceId]);

    // Und die Mahn-ZAEHLUNG selbst: `overdueCount` einer Stufe MUSS der Zahl
    // ihrer roten Karten entsprechen. Das ist die eigentliche Aussage des PRs
    // — ohne sie bliebe ein Mutant unentdeckt, der die Bindung beim Aging
    // beachtet, sie aber trotzdem als ueberfaellig mitzaehlt.
    // Kontaminations-fest, weil beide Seiten der Gleichung dieselben fremden
    // Rechnungen der geteilten DB enthalten.
    for (const grp of b.stages) {
      const rot = grp.cards.filter((c) => c.aging === "red").length;
      expect(grp.overdueCount, `overdueCount der Stufe ${grp.stage}`).toBe(rot);
    }
  });

  it("(b) Listen-Endpunkt liefert Bindung, Betrag und Differenz für offene Rechnungen", async () => {
    const res = await apiGet<any[]>(`/api/billing?year=${YEAR}&month=${MONTH}`);
    expect(res.status).toBe(200);
    const rows = res.data as any[];

    const bound = rows.find((r) => r.id === boundInvoiceId);
    expect(bound, "gebundene Rechnung fehlt in der Liste").toBeTruthy();
    expect(bound.hasBoundPayment).toBe(true);
    expect(bound.boundPaidCents).toBe(GROSS);
    // Brutto − Skonto − gezahlt = 0 ⇒ exakt gedeckt.
    expect(bound.paymentDifferenceCents).toBe(0);
    expect(bound.paymentDifferenceResult).toBe("exact");
  });

  it("(c) ungebundene offene Rechnung trägt hasBoundPayment=false, keine Beträge", async () => {
    const res = await apiGet<any[]>(`/api/billing?year=${YEAR}&month=${MONTH}`);
    const unbound = (res.data as any[]).find((r) => r.id === unboundInvoiceId);
    expect(unbound).toBeTruthy();
    expect(unbound.hasBoundPayment).toBe(false);
    expect(unbound.boundPaidCents).toBeUndefined();
    expect(unbound.paymentDifferenceCents).toBeUndefined();
  });

  it("(e) Ueberzahlung: negative Differenz, Klassifikation overpaid, Pruef-Cluster", async () => {
    const res = await apiGet<any[]>(`/api/billing?year=${YEAR}&month=${MONTH}`);
    const over = (res.data as any[]).find((r) => r.id === overpaidInvoiceId);
    expect(over).toBeTruthy();
    expect(over.hasBoundPayment).toBe(true);
    expect(over.boundPaidCents).toBe(GROSS + 10_000);
    // Brutto − Skonto − gezahlt = -10000. Vorzeichen ist die Aussage: negativ
    // heisst Ueberzahlung. Eine Vorzeichen-Drehung faellt genau hier.
    expect(over.paymentDifferenceCents).toBe(-10_000);
    expect(over.paymentDifferenceResult).toBe("overpaid");
    // Der Status bleibt `versendet` — nie still als Vollzahlung gebucht.
    expect(over.status).toBe("versendet");

    expect(cardIn(await board(), overpaidInvoiceId)!.card.aging).toBe("none");
  });

  it("(f) Pflegekassen-Pfad: avis_erhalten mit Bindung altert ebenfalls nicht", async () => {
    const kasse = cardIn(await board(), kasseInvoiceId);
    expect(kasse, "Kassen-Rechnung muss im Board auftauchen").not.toBeNull();
    expect(kasse!.stage).toBe("avis_erhalten");
    expect(kasse!.card.aging).toBe("none");

    const res = await apiGet<any[]>(`/api/billing?year=${YEAR}&month=${MONTH}`);
    const row = (res.data as any[]).find((r) => r.id === kasseInvoiceId);
    expect(row.hasBoundPayment).toBe(true);
    expect(row.paymentDifferenceResult).toBe("exact");
  });

  it("(g) bezahlte Rechnung gilt nicht als offen und wird nicht angereichert", async () => {
    const res = await apiGet<any[]>(`/api/billing?year=${YEAR}&month=${MONTH}`);
    const paid = (res.data as any[]).find((r) => r.id === paidInvoiceId);
    expect(paid).toBeTruthy();
    expect(paid.status).toBe("bezahlt");
    // Nagelt die „offen"-Abgrenzung fest: wuerde sie auf `bezahlt` ausgeweitet,
    // faellt dieser Fall.
    expect(paid.hasBoundPayment).toBeUndefined();
    expect(paid.boundPaidCents).toBeUndefined();
  });

  it("(d) Bestandsvertrag #1822 bleibt: teilweise_bezahlt trägt paidCents/openAmountCents", async () => {
    const res = await apiGet<any[]>(`/api/billing?year=${YEAR}&month=${MONTH}`);
    const partial = (res.data as any[]).find((r) => r.id === partialInvoiceId);
    expect(partial).toBeTruthy();
    expect(partial.status).toBe("teilweise_bezahlt");
    // Ohne gebundene Zahlung: 0 gezahlt, offener Rest = Brutto.
    expect(partial.paidCents).toBe(0);
    expect(partial.openAmountCents).toBe(GROSS);
  });
});
