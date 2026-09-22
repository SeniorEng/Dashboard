/**
 * P1 `6hc4xjVGmFq7V78G`, Teil 1 — Kandidaten für die dritte Größe der
 * Dreifach-Gleichheit messen, BEVOR eine davon gebaut wird.
 *
 * ── Die Auflage, die dieses Skript beantwortet ──────────────────────────
 * Alrik: *„Das ist eine Änderung an der Dreifach-Gleichheit, also genau die
 * Stelle, an der man sich vertut. Miss es, bevor du es baust: wie viele der
 * heute gebundenen Avise würden unter der neuen Bedingung anders entschieden?
 * Wenn mehr als null, ist der Vorschlag falsch."*
 *
 * Das Skript wendet die Kandidaten auf die **heute gebundenen** Avise an und
 * zählt die Abweichungen. Es ändert nichts und schlägt nichts vor — es
 * liefert die Zahl, an der ein Vorschlag scheitert oder nicht.
 *
 * ── Warum die naheliegende Fassung schon rechnerisch ausfällt ───────────
 * `sumOpenInvoiceCents` summiert den **Brutto**-Betrag der Rechnung, und die
 * Toleranz ist `BULK_ADVICE_TOLERANCE_CENTS = 2` — zwei Cent. Sobald der Avis
 * eine Kürzung ausweist, kann Brutto den gezahlten Betrag nicht treffen:
 *
 *   heute      Σ Brutto der noch OFFENEN Rechnungen   → bei Teilzahlung weit daneben
 *   Kandidat A Σ Brutto ALLER beanspruchten Positionen → daneben um die Kürzung
 *   Kandidat B Σ (Brutto − erklärter Abzug)            → trifft, wenn der Avis stimmig ist
 *
 * Kandidat B benutzt dieselbe SSoT wie `mark-paid` und der Rechnungsabgleich
 * (`classifyPaymentDifference`) — kein Zweitbegriff. Die Rechnungsseite bleibt
 * als unabhängiger Zeuge drin: `grossAmountCents` kommt aus der Rechnung, nur
 * der Abzug aus dem Avis.
 *
 * ── Rein lesend ────────────────────────────────────────────────────────
 * Nur `db.select`. Schreibt nichts.
 *
 * Aufruf:
 *   tsx server/scripts/diff-avis-bindung.ts
 *   tsx server/scripts/diff-avis-bindung.ts --alle     # auch unauffällige Avise
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { invoices, paymentAdvices, paymentAdviceItems, qontoTransactions } from "@shared/schema";
import { BULK_ADVICE_TOLERANCE_CENTS } from "@shared/domain/qonto/bulk-advice-match";
import { classifyPaymentDifference } from "@shared/domain/qonto/payment-difference";
import { statusesAllowedToTransitionTo } from "@shared/domain/invoice-status";

function euro(c: number): string {
  return (c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const trifft = (a: number, b: number) => Math.abs(a - b) <= BULK_ADVICE_TOLERANCE_CENTS;

async function main() {
  const alle = process.argv.includes("--alle");

  const advices = await db.select().from(paymentAdvices).where(isNull(paymentAdvices.deletedAt));
  if (advices.length === 0) { console.log("Keine Avise."); return; }

  // Welche Avise sind HEUTE an eine Transaktion gebunden? Das ist die Menge,
  // auf der die Auflage gilt: ihre Entscheidung darf sich nicht ändern.
  const txRows = await db
    .select({ adviceId: qontoTransactions.matchedPaymentAdviceId, amountCents: qontoTransactions.amountCents })
    .from(qontoTransactions)
    .where(isNotNull(qontoTransactions.matchedPaymentAdviceId));
  const txByAdvice = new Map<number, number>();
  for (const t of txRows) if (t.adviceId != null) txByAdvice.set(t.adviceId, Math.abs(t.amountCents));

  const items = await db
    .select({
      adviceId: paymentAdviceItems.paymentAdviceId,
      invoiceId: invoices.id,
      grossAmountCents: invoices.grossAmountCents,
      status: invoices.status,
      betragCents: paymentAdviceItems.betragCents,
      skontoCents: paymentAdviceItems.skontoCents,
    })
    .from(paymentAdviceItems)
    .innerJoin(invoices, eq(paymentAdviceItems.matchedInvoiceId, invoices.id))
    .where(inArray(paymentAdviceItems.paymentAdviceId, advices.map(a => a.id)));

  const offeneStatus = new Set(statusesAllowedToTransitionTo("bezahlt"));

  let gebundenGeprueft = 0;
  const kippenA: string[] = [];
  const kippenB: string[] = [];
  const heilbarA: string[] = [];
  const heilbarB: string[] = [];

  for (const a of advices) {
    const meine = items.filter(i => i.adviceId === a.id);
    if (meine.length === 0) continue;
    const T = a.gesamtBetragCents;
    if (T == null) continue;

    const sumOffen = meine.filter(i => offeneStatus.has(i.status)).reduce((n, i) => n + i.grossAmountCents, 0);
    const sumBeansprucht = meine.reduce((n, i) => n + i.grossAmountCents, 0);
    const sumErklaert = meine.reduce((n, i) => {
      const cls = classifyPaymentDifference({
        invoiceGrossCents: i.grossAmountCents,
        paidCents: i.betragCents,
        skontoCents: i.skontoCents ?? 0,
      });
      // Brutto minus dem Abzug, den der Avis SELBST erklärt. `differenceCents`
      // ist Brutto − Skonto − gezahlt; abgezogen ergibt das den gezahlten Betrag.
      return n + (i.grossAmountCents - (i.skontoCents ?? 0) - cls.differenceCents);
    }, 0);

    const txBetrag = txByAdvice.get(a.id);
    const gebunden = txBetrag != null;

    const heuteOk = gebunden ? trifft(txBetrag, T) && trifft(T, sumOffen) && trifft(txBetrag, sumOffen) : null;
    const aOk = gebunden ? trifft(txBetrag, T) && trifft(T, sumBeansprucht) && trifft(txBetrag, sumBeansprucht) : null;
    const bOk = gebunden ? trifft(txBetrag, T) && trifft(T, sumErklaert) && trifft(txBetrag, sumErklaert) : null;

    const kennung = `Avis ${a.id} (${a.avisNummer ?? "ohne Nummer"})`;

    if (gebunden) {
      gebundenGeprueft++;
      if (heuteOk !== aOk) kippenA.push(`  ${kennung}: heute ${heuteOk} → A ${aOk}  | T=${euro(T)} offen=${euro(sumOffen)} beansprucht=${euro(sumBeansprucht)}`);
      if (heuteOk !== bOk) kippenB.push(`  ${kennung}: heute ${heuteOk} → B ${bOk}  | T=${euro(T)} offen=${euro(sumOffen)} erklaert=${euro(sumErklaert)}`);
    } else {
      // Ungebunden: würde einer der Kandidaten die Dreifach-Gleichheit gegen
      // den Avis-Gesamtbetrag überhaupt erfüllen? (Die Transaktionsseite fehlt
      // hier — das ist nur die notwendige Bedingung, nicht die hinreichende.)
      if (!trifft(T, sumOffen) && trifft(T, sumBeansprucht)) heilbarA.push(`  ${kennung}: T=${euro(T)} offen=${euro(sumOffen)} beansprucht=${euro(sumBeansprucht)}`);
      if (!trifft(T, sumOffen) && trifft(T, sumErklaert)) heilbarB.push(`  ${kennung}: T=${euro(T)} offen=${euro(sumOffen)} erklaert=${euro(sumErklaert)}`);
    }
  }

  console.log(`Toleranz: ${BULK_ADVICE_TOLERANCE_CENTS} Cent`);
  console.log(`Avise gesamt: ${advices.length} · heute gebunden und geprüft: ${gebundenGeprueft}`);
  console.log("");
  console.log("═══ ALRIKS AUFLAGE — ändert sich eine HEUTIGE Entscheidung? ═══");
  console.log(`  Kandidat A (Σ Brutto aller beanspruchten Positionen): ${kippenA.length}`);
  kippenA.slice(0, alle ? 999 : 10).forEach(z => console.log(z));
  console.log(`  Kandidat B (Σ Brutto − erklärter Abzug):              ${kippenB.length}`);
  kippenB.slice(0, alle ? 999 : 10).forEach(z => console.log(z));
  console.log("");
  console.log("  > Mehr als 0 heißt: der Kandidat ist falsch.");
  console.log("");
  console.log("═══ Was würde bei UNGEBUNDENEN Avisen neu erfüllbar? ═══");
  console.log(`  Kandidat A: ${heilbarA.length}`);
  heilbarA.slice(0, alle ? 999 : 10).forEach(z => console.log(z));
  console.log(`  Kandidat B: ${heilbarB.length}`);
  heilbarB.slice(0, alle ? 999 : 10).forEach(z => console.log(z));
  console.log("");
  console.log("  Notwendige Bedingung, nicht hinreichend: ob eine passende");
  console.log("  Transaktion existiert und der Diskriminator eindeutig ist,");
  console.log("  sagt erst `resolveUniqueBulkMatch`.");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
