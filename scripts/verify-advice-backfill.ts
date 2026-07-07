// ---------------------------------------------------------------------------
// Task #1672 — Historischer Backfill-Verifier (Schritt 7): Sammel-Avis ↔
// Sammelzahlung.
//
// NUR LESEN / DRY-RUN. Dieses Skript schreibt NICHTS. Es paart bereits
// VOLLSTÄNDIG BEZAHLTE Avise (alle zugeordneten Rechnungen `bezahlt`, noch KEINE
// Sammel-Avis-Verknüpfung) mit noch nicht zugeordneten Qonto-Gutschriften und
// druckt die Vorschläge, die ein späterer — separat freigegebener — `--apply`-Lauf
// verbinden würde.
//
// Gating-Signale (Schritt 7, K3):
//   1. Exakter Betrag: abs(TX.amountCents) ≈ advice.gesamtBetragCents
//      (±BULK_ADVICE_TOLERANCE_CENTS, reine Rundung).
//   2. Zeitfenster: TX.emittedAt innerhalb ±21 Tagen um das Avis-Zahlungsdatum
//      (Fallback: spätestes paidAt der Avis-Rechnungen).
//   3. Empfänger-IBAN: advice.zahlungsempfaengerIban == TX.sourceIban
//      (normalisiert).
// Der Zahler-/Kostenträger-Name wird NUR als Kontext für die menschliche Prüfung
// angezeigt, ist KEIN Gate (Pflegekassen-Namen sind zu variabel, K3).
//
// Warum Backfill separat von der Live-Triple-Equality: bei bereits bezahlten
// Avisen ist die Summe der OFFENEN Rechnungen 0 — die Live-Triple-Equality (die
// offene Rechnungen prüft) greift also nicht mehr. Der Backfill fällt daher auf
// „exakter Betrag + Fenster + IBAN" zurück, wie in Schritt 7 spezifiziert.
//
// `--apply` ist in DIESEM Task NICHT implementiert: ein Schreiblauf ist eine
// separat freigegebene Operation mit Prod-in-Dev-Vorbereitungsdisziplin.
// ---------------------------------------------------------------------------

import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  qontoTransactions,
  paymentAdvices,
  paymentAdviceItems,
  invoices,
} from "@shared/schema";
import { parseLocalDate } from "@shared/utils/datetime";
import { normalizeIban } from "@shared/domain/qonto/monitored-ibans";
import { BULK_ADVICE_TOLERANCE_CENTS } from "@shared/domain/qonto/bulk-advice-match";

/** Zeitfenster für die Backfill-Paarung (Schritt 7). */
const BACKFILL_WINDOW_DAYS = 21;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatEuro(cents: number | null): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " €";
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

interface FullyPaidAdvice {
  id: number;
  avisNummer: string | null;
  gesamtBetragCents: number;
  zahlungsempfaengerIban: string | null;
  kostentraegerName: string | null;
  anchorDate: Date | null;
  invoiceCount: number;
}

interface ProposedLink {
  advice: FullyPaidAdvice;
  txId: number;
  txAmountCents: number;
  txEmittedAt: Date;
  txCounterpartyName: string | null;
  daysDelta: number;
  nameMatchesAdvisory: boolean;
}

/**
 * Lädt alle Avise, die VOLLSTÄNDIG bezahlt und noch NICHT über
 * `matched_payment_advice_id` verknüpft sind: mindestens eine zugeordnete
 * Rechnung, ALLE zugeordneten Rechnungen im Status `bezahlt`.
 */
async function loadFullyPaidUnlinkedAdvices(): Promise<FullyPaidAdvice[]> {
  const advices = await db
    .select()
    .from(paymentAdvices)
    .where(and(isNull(paymentAdvices.deletedAt), isNotNull(paymentAdvices.gesamtBetragCents)));
  if (advices.length === 0) return [];

  // Avise, die bereits per Sammel-Avis-Link verbunden sind ⇒ ausschließen.
  const linkedRows = await db
    .select({ adviceId: qontoTransactions.matchedPaymentAdviceId })
    .from(qontoTransactions)
    .where(isNotNull(qontoTransactions.matchedPaymentAdviceId));
  const linkedAdviceIds = new Set(linkedRows.map((r) => r.adviceId).filter((x): x is number => x != null));

  const adviceIds = advices.map((a) => a.id);
  const itemRows = await db
    .select({
      adviceId: paymentAdviceItems.paymentAdviceId,
      invoiceId: invoices.id,
      status: invoices.status,
      paidAt: invoices.paidAt,
    })
    .from(paymentAdviceItems)
    .innerJoin(invoices, eq(paymentAdviceItems.matchedInvoiceId, invoices.id))
    .where(inArray(paymentAdviceItems.paymentAdviceId, adviceIds));

  const byAdvice = new Map<number, { count: number; allPaid: boolean; latestPaidAt: Date | null }>();
  for (const r of itemRows) {
    const agg = byAdvice.get(r.adviceId) ?? { count: 0, allPaid: true, latestPaidAt: null };
    agg.count += 1;
    if (r.status !== "bezahlt") agg.allPaid = false;
    if (r.paidAt && (!agg.latestPaidAt || r.paidAt > agg.latestPaidAt)) agg.latestPaidAt = r.paidAt;
    byAdvice.set(r.adviceId, agg);
  }

  const result: FullyPaidAdvice[] = [];
  for (const a of advices) {
    if (linkedAdviceIds.has(a.id)) continue;
    const agg = byAdvice.get(a.id);
    if (!agg || agg.count === 0 || !agg.allPaid) continue;

    const parsed = a.zahlungsDatum ? parseLocalDate(a.zahlungsDatum) : null;
    const anchorDate = parsed ?? agg.latestPaidAt ?? null;

    result.push({
      id: a.id,
      avisNummer: a.avisNummer,
      gesamtBetragCents: a.gesamtBetragCents!,
      zahlungsempfaengerIban: a.zahlungsempfaengerIban,
      kostentraegerName: a.kostentraegerName,
      anchorDate,
      invoiceCount: agg.count,
    });
  }
  return result;
}

/** Noch nicht zugeordnete Qonto-Gutschriften (weder Rechnung noch Avis verknüpft). */
async function loadUnmatchedCredits() {
  return db
    .select()
    .from(qontoTransactions)
    .where(
      and(
        eq(qontoTransactions.side, "credit"),
        isNull(qontoTransactions.matchedInvoiceId),
        isNull(qontoTransactions.matchedPaymentAdviceId),
      ),
    );
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply) {
    console.error(
      "\n✖ --apply ist in Task #1672 NICHT implementiert.\n" +
        "  Ein Schreiblauf ist eine separat freigegebene Operation (Prod-in-Dev-\n" +
        "  Vorbereitung, Sign-off). Dieses Skript bleibt reiner Dry-Run.\n",
    );
    process.exit(2);
  }

  console.log("═".repeat(78));
  console.log("Task #1672 — Backfill-Verifier (DRY-RUN, keine Schreibvorgänge)");
  console.log("Bereits bezahlte Avise ↔ nicht zugeordnete Qonto-Sammelzahlungen");
  console.log("═".repeat(78));

  const [advices, credits] = await Promise.all([
    loadFullyPaidUnlinkedAdvices(),
    loadUnmatchedCredits(),
  ]);

  console.log(
    `\nKandidaten: ${advices.length} vollständig bezahlte, unverknüpfte Avise · ` +
      `${credits.length} nicht zugeordnete Gutschriften.`,
  );
  console.log(
    `Gating: exakter Betrag (±${BULK_ADVICE_TOLERANCE_CENTS} ct) · ` +
      `±${BACKFILL_WINDOW_DAYS} Tage · Empfänger-IBAN. Name = nur Kontext.\n`,
  );

  const proposals: ProposedLink[] = [];
  const ambiguous: FullyPaidAdvice[] = [];

  for (const advice of advices) {
    const adviceIban = advice.zahlungsempfaengerIban ? normalizeIban(advice.zahlungsempfaengerIban) : null;
    if (!adviceIban) continue; // IBAN ist ein Pflicht-Gate — ohne sie kein Backfill-Vorschlag.
    if (!advice.anchorDate) continue; // ohne Anker kein Zeitfenster ⇒ übersprungen.

    const matches: ProposedLink[] = [];
    for (const tx of credits) {
      const amountOk = Math.abs(Math.abs(tx.amountCents) - advice.gesamtBetragCents) <= BULK_ADVICE_TOLERANCE_CENTS;
      if (!amountOk) continue;

      const ibanOk = tx.sourceIban ? normalizeIban(tx.sourceIban) === adviceIban : false;
      if (!ibanOk) continue;

      const daysDelta = Math.round((tx.emittedAt.getTime() - advice.anchorDate.getTime()) / MS_PER_DAY);
      if (Math.abs(daysDelta) > BACKFILL_WINDOW_DAYS) continue;

      const nameAdvisory =
        !!advice.kostentraegerName &&
        !!tx.counterpartyName &&
        (tx.counterpartyName.toLowerCase().includes(advice.kostentraegerName.toLowerCase()) ||
          advice.kostentraegerName.toLowerCase().includes(tx.counterpartyName.toLowerCase()));

      matches.push({
        advice,
        txId: tx.id,
        txAmountCents: tx.amountCents,
        txEmittedAt: tx.emittedAt,
        txCounterpartyName: tx.counterpartyName,
        daysDelta,
        nameMatchesAdvisory: nameAdvisory,
      });
    }

    if (matches.length === 1) {
      proposals.push(matches[0]);
    } else if (matches.length > 1) {
      ambiguous.push(advice);
      console.log(
        `⚠  Avis ${advice.avisNummer ?? `#${advice.id}`} (${formatEuro(advice.gesamtBetragCents)}): ` +
          `${matches.length} passende Gutschriften — mehrdeutig, KEIN Vorschlag (manuelle Prüfung).`,
      );
    }
  }

  console.log("\n" + "─".repeat(78));
  if (proposals.length === 0) {
    console.log("Keine eindeutigen Backfill-Vorschläge gefunden.");
  } else {
    console.log(`Eindeutige Vorschläge (würden bei --apply verknüpft): ${proposals.length}\n`);
    for (const p of proposals) {
      const a = p.advice;
      console.log(
        `• Avis ${a.avisNummer ?? `#${a.id}`} · ${a.invoiceCount} Rechnungen · ${formatEuro(a.gesamtBetragCents)}`,
      );
      console.log(
        `    ↔ Qonto-TX #${p.txId} · ${formatEuro(Math.abs(p.txAmountCents))} · ` +
          `${formatDate(p.txEmittedAt)} (${p.daysDelta >= 0 ? "+" : ""}${p.daysDelta} d zum Anker ${formatDate(a.anchorDate)})`,
      );
      console.log(
        `    IBAN ✓ · Name ${p.nameMatchesAdvisory ? "≈ passt" : "≠ (nur Kontext)"}: ` +
          `Avis „${a.kostentraegerName ?? "—"}" vs. TX „${p.txCounterpartyName ?? "—"}"`,
      );
    }
  }
  console.log("─".repeat(78));
  console.log(
    `\nZusammenfassung: ${proposals.length} eindeutig · ${ambiguous.length} mehrdeutig (übersprungen).`,
  );
  console.log("DRY-RUN beendet — es wurde NICHTS geschrieben.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Backfill-Verifier fehlgeschlagen:", err);
      process.exit(1);
    });
}
