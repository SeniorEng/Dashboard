// ---------------------------------------------------------------------------
// Task #1672 / #1680 — Historischer Backfill: Sammel-Avis ↔ Sammelzahlung.
//
// Standard = DRY-RUN (nur lesen). Mit `--apply` = Schreiblauf (Task #1680).
//
// Das Skript paart bereits VOLLSTÄNDIG BEZAHLTE Avise (alle zugeordneten
// Rechnungen `bezahlt`, noch KEINE Sammel-Avis-Verknüpfung) mit noch nicht
// zugeordneten Qonto-Gutschriften.
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
// `--apply` (Task #1680) verknüpft je EINDEUTIGEM Vorschlag die Transaktion mit
// dem Avis (`matched_payment_advice_id`), bleibt XOR-sicher (geguardetes Update),
// überspringt bereits verknüpfte Avise/Transaktionen und schreibt ein Audit je
// betroffenem Avis. Die Avis-Rechnungen sind bereits `bezahlt` und werden NICHT
// angefasst. Idempotent: ein zweiter Lauf trifft null Zeilen.
//
// MEHRDEUTIGE AVISE (Task #1683): Avise, für die MEHRERE Gutschriften passen (oder
// deren einzige passende Gutschrift von einem weiteren Avis beansprucht wird),
// werden bewusst NICHT auto-verknüpft. Sie werden zusätzlich zur Konsole als
// durabler Report (`advice-backfill-ambiguous.csv` + `.json`, Pfad via `--out=`)
// geschrieben — je Zeile das Avis PLUS die konkurrierende Gutschrift, damit ein
// Operator die richtige Zuordnung manuell auswählen kann.
//
// PROD-DISZIPLIN: In Dev vorbereiten/verifizieren (Dry-Run), `--apply` gegen Prod
// erst nach Sign-off (PROD_DATABASE_URL / Deployment-Kontext).
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "../server/lib/db";
import {
  qontoTransactions,
  paymentAdvices,
  paymentAdviceItems,
  invoices,
  users,
} from "@shared/schema";
import { auditService } from "../server/services/audit";
import { parseLocalDate } from "@shared/utils/datetime";
import { normalizeIban } from "@shared/domain/qonto/monitored-ibans";
import { BULK_ADVICE_TOLERANCE_CENTS } from "@shared/domain/qonto/bulk-advice-match";

/**
 * Provenienz-Marker in `qonto_transactions.match_confidence` für per Backfill
 * (Task #1680) verknüpfte Sammelzahlungen — bewusst getrennt vom Live-Auto-Match
 * (`auto_bulk_advice`), damit der historische Ursprung nachvollziehbar bleibt.
 */
export const BACKFILL_MATCH_CONFIDENCE = "backfill_bulk_advice";

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
  txSourceIban: string | null;
  daysDelta: number;
  nameMatchesAdvisory: boolean;
}

/** Eine der miteinander konkurrierenden Gutschriften eines mehrdeutigen Avis. */
export interface AmbiguousCredit {
  txId: number;
  txAmountCents: number;
  txEmittedAt: Date;
  txCounterpartyName: string | null;
  txSourceIban: string | null;
  daysDelta: number;
  nameMatchesAdvisory: boolean;
}

/**
 * Ein Avis, das NICHT automatisch verknüpft werden kann, weil die Zuordnung
 * mehrdeutig ist — inklusive der konkurrierenden Gutschriften, zwischen denen ein
 * Mensch entscheiden muss.
 *
 *  - `multiple_credits`: mehrere Gutschriften passen auf DASSELBE Avis
 *    (`candidates` = alle passenden Gutschriften).
 *  - `credit_collision`: EINE Gutschrift würde für mehrere Avise vorgeschlagen
 *    (`candidates` = die eine geteilte Gutschrift, `collidingAdviceIds` = die
 *    anderen Avise, die dieselbe Gutschrift beanspruchen).
 */
export interface AmbiguousAdvice {
  advice: FullyPaidAdvice;
  reason: "multiple_credits" | "credit_collision";
  candidates: AmbiguousCredit[];
  collidingAdviceIds: number[];
}

function toAmbiguousCredit(p: ProposedLink): AmbiguousCredit {
  return {
    txId: p.txId,
    txAmountCents: p.txAmountCents,
    txEmittedAt: p.txEmittedAt,
    txCounterpartyName: p.txCounterpartyName,
    txSourceIban: p.txSourceIban,
    daysDelta: p.daysDelta,
    nameMatchesAdvisory: p.nameMatchesAdvisory,
  };
}

/**
 * Lädt alle Avise, die VOLLSTÄNDIG bezahlt und noch NICHT über
 * `matched_payment_advice_id` verknüpft sind: mindestens eine zugeordnete
 * Rechnung, ALLE zugeordneten Rechnungen im Status `bezahlt`.
 */
export async function loadFullyPaidUnlinkedAdvices(): Promise<FullyPaidAdvice[]> {
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
export async function loadUnmatchedCredits() {
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

/**
 * Reine Paarungs-Logik: liefert eindeutige Vorschläge (genau eine passende
 * Gutschrift) und mehrdeutige Avise (mehrere passende Gutschriften → kein
 * Vorschlag). Wird von Dry-Run UND `--apply` geteilt, damit beide exakt dieselben
 * Gates anwenden.
 */
export function computeProposals(
  advices: FullyPaidAdvice[],
  credits: Awaited<ReturnType<typeof loadUnmatchedCredits>>,
): { proposals: ProposedLink[]; ambiguous: AmbiguousAdvice[] } {
  const proposals: ProposedLink[] = [];
  const ambiguous: AmbiguousAdvice[] = [];

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
        txSourceIban: tx.sourceIban,
        daysDelta,
        nameMatchesAdvisory: nameAdvisory,
      });
    }

    if (matches.length === 1) {
      proposals.push(matches[0]);
    } else if (matches.length > 1) {
      ambiguous.push({
        advice,
        reason: "multiple_credits",
        candidates: matches.map(toAmbiguousCredit),
        collidingAdviceIds: [],
      });
    }
  }

  // Ein Backfill-Vorschlag ist auch dann mehrdeutig, wenn dieselbe Gutschrift
  // (txId) für mehrere Avise vorgeschlagen würde — die Zahlung kann nur EINEM
  // Avis zugeordnet werden. In dem Fall wird KEINE der kollidierenden
  // Zuordnungen automatisch gebucht (manuelle Prüfung).
  const txCounts = new Map<number, number>();
  const txToAdviceIds = new Map<number, number[]>();
  for (const p of proposals) {
    txCounts.set(p.txId, (txCounts.get(p.txId) ?? 0) + 1);
    const arr = txToAdviceIds.get(p.txId) ?? [];
    arr.push(p.advice.id);
    txToAdviceIds.set(p.txId, arr);
  }
  const uniqueProposals: ProposedLink[] = [];
  for (const p of proposals) {
    if ((txCounts.get(p.txId) ?? 0) > 1) {
      const collidingAdviceIds = (txToAdviceIds.get(p.txId) ?? []).filter((id) => id !== p.advice.id);
      ambiguous.push({
        advice: p.advice,
        reason: "credit_collision",
        candidates: [toAmbiguousCredit(p)],
        collidingAdviceIds,
      });
    } else {
      uniqueProposals.push(p);
    }
  }

  return { proposals: uniqueProposals, ambiguous };
}

/** Eine flache Zeile des Mehrdeutigkeits-Reports (ein Avis × eine Gutschrift). */
export interface AmbiguousReportRow {
  adviceId: number;
  avisNummer: string | null;
  adviceAmountCents: number;
  adviceIban: string | null;
  kostentraegerName: string | null;
  anchorDate: string | null;
  invoiceCount: number;
  reason: AmbiguousAdvice["reason"];
  collidingAdviceIds: number[];
  txId: number;
  txAmountCents: number;
  txEmittedAt: string;
  daysDelta: number;
  txCounterpartyName: string | null;
  txSourceIban: string | null;
  nameMatchesAdvisory: boolean;
}

/**
 * Flacht die mehrdeutigen Avise zu je einer Zeile pro konkurrierender Gutschrift
 * aus, damit ein Operator sie in Tabellenform (CSV/JSON) durcharbeiten kann.
 * Reine Transformation ohne Seiteneffekte.
 */
export function buildAmbiguousReportRows(ambiguous: AmbiguousAdvice[]): AmbiguousReportRow[] {
  const rows: AmbiguousReportRow[] = [];
  for (const entry of ambiguous) {
    const a = entry.advice;
    for (const c of entry.candidates) {
      rows.push({
        adviceId: a.id,
        avisNummer: a.avisNummer,
        adviceAmountCents: a.gesamtBetragCents,
        adviceIban: a.zahlungsempfaengerIban,
        kostentraegerName: a.kostentraegerName,
        anchorDate: formatDate(a.anchorDate),
        invoiceCount: a.invoiceCount,
        reason: entry.reason,
        collidingAdviceIds: entry.collidingAdviceIds,
        txId: c.txId,
        txAmountCents: c.txAmountCents,
        txEmittedAt: formatDate(c.txEmittedAt),
        daysDelta: c.daysDelta,
        txCounterpartyName: c.txCounterpartyName,
        txSourceIban: c.txSourceIban,
        nameMatchesAdvisory: c.nameMatchesAdvisory,
      });
    }
  }
  return rows;
}

const AMBIGUOUS_REPORT_CSV_HEADER = [
  "advice_id",
  "avis_nummer",
  "advice_amount_eur",
  "advice_iban",
  "kostentraeger",
  "anchor_date",
  "invoice_count",
  "reason",
  "colliding_advice_ids",
  "tx_id",
  "tx_amount_eur",
  "tx_date",
  "days_delta",
  "tx_counterparty",
  "tx_source_iban",
  "name_matches_advisory",
] as const;

function csvCell(value: string | number | null): string {
  const s = value == null ? "" : String(value);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Formatiert die mehrdeutigen Avise als CSV (Semikolon-getrennt, DE-üblich) —
 * eine Kopfzeile plus eine Zeile pro konkurrierender Gutschrift. Beträge in Euro
 * (Punkt als Dezimaltrenner, CSV-neutral).
 */
export function formatAmbiguousReportCsv(ambiguous: AmbiguousAdvice[]): string {
  const rows = buildAmbiguousReportRows(ambiguous);
  const lines = [AMBIGUOUS_REPORT_CSV_HEADER.join(";")];
  for (const r of rows) {
    lines.push(
      [
        r.adviceId,
        r.avisNummer,
        (r.adviceAmountCents / 100).toFixed(2),
        r.adviceIban,
        r.kostentraegerName,
        r.anchorDate,
        r.invoiceCount,
        r.reason,
        r.collidingAdviceIds.join("|"),
        r.txId,
        (r.txAmountCents / 100).toFixed(2),
        r.txEmittedAt,
        r.daysDelta,
        r.txCounterpartyName,
        r.txSourceIban,
        r.nameMatchesAdvisory ? "ja" : "nein",
      ]
        .map(csvCell)
        .join(";"),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Verknüpft je eindeutigem Vorschlag die Gutschrift mit dem Avis. Pro Vorschlag
 * eine eigene Transaktion:
 *   - geguardetes UPDATE (tx ist noch UNverknüpft, nicht billing-irrelevant) →
 *     XOR-sicher & idempotent (zweiter Lauf trifft 0 Zeilen).
 *   - zusätzliche Absicherung: Avis darf noch an keine andere Gutschrift
 *     gebunden sein (deckt sich mit dem Partial-Unique-Index, wir prüfen aber
 *     vorab, um sauber zu überspringen statt in einen Constraint-Fehler zu
 *     laufen).
 *   - EIN Audit je betroffenem Avis (`advice_payment_reconciled`,
 *     `matchedBy: "backfill"`).
 * Die Avis-Rechnungen sind bereits `bezahlt` und werden NICHT verändert.
 * Liefert die Zahl der tatsächlich verknüpften Avise.
 */
export async function applyProposals(
  proposals: ProposedLink[],
  userId: number,
  reason: string,
): Promise<number> {
  let linked = 0;

  for (const p of proposals) {
    const adviceId = p.advice.id;
    const didLink = await db.transaction(async (tx) => {
      // Avis bereits (durch eine andere Gutschrift) gebunden? → überspringen.
      const alreadyLinked = await tx
        .select({ id: qontoTransactions.id })
        .from(qontoTransactions)
        .where(eq(qontoTransactions.matchedPaymentAdviceId, adviceId))
        .limit(1);
      if (alreadyLinked.length > 0) return false;

      const updated = await tx
        .update(qontoTransactions)
        .set({
          matchedPaymentAdviceId: adviceId,
          matchConfidence: BACKFILL_MATCH_CONFIDENCE,
        })
        .where(
          and(
            eq(qontoTransactions.id, p.txId),
            isNull(qontoTransactions.matchedInvoiceId),
            isNull(qontoTransactions.matchedPaymentAdviceId),
            isNull(qontoTransactions.billingIrrelevantAt),
          ),
        )
        .returning({ id: qontoTransactions.id });

      if (updated.length === 0) return false; // schon verknüpft/irrelevant ⇒ idempotent.

      await auditService.log(
        userId,
        "advice_payment_reconciled",
        "payment_advice",
        adviceId,
        {
          qontoTransactionId: p.txId,
          matchedBy: "backfill",
          reason,
          gate: "historical_backfill_amount_window_iban",
          invoiceCount: p.advice.invoiceCount,
          amountCents: p.txAmountCents,
          daysDelta: p.daysDelta,
          confidence: BACKFILL_MATCH_CONFIDENCE,
        },
        undefined,
        tx,
      );

      return true;
    });

    if (didLink) {
      linked += 1;
      console.log(
        `✓ Avis ${p.advice.avisNummer ?? `#${adviceId}`} → Qonto-TX #${p.txId} verknüpft ` +
          `(${formatEuro(Math.abs(p.txAmountCents))}).`,
      );
    } else {
      console.log(
        `· Avis ${p.advice.avisNummer ?? `#${adviceId}`} übersprungen ` +
          `(bereits verknüpft / nicht mehr passend).`,
      );
    }
  }

  return linked;
}

/** Stellt sicher, dass die Audit-Attribution ein aktiver Superadmin ist. */
async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db
    .select({
      id: users.id,
      isSuperAdmin: users.isSuperAdmin,
      isActive: users.isActive,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `Der Sammel-Avis-Backfill-Schreiblauf ist auf Superadmins beschränkt (GoBD-Audit).`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const userArg = get("--user=");
  const parsedUserId = userArg ? parseInt(userArg, 10) : undefined;
  const userId = parsedUserId !== undefined && Number.isFinite(parsedUserId) ? parsedUserId : undefined;
  const reason = get("--reason=");

  if (apply) {
    if (userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!reason || reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="..." (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    await assertSuperadminOrThrow(userId);
  }

  console.log("═".repeat(78));
  console.log(
    apply
      ? "Task #1680 — Backfill APPLY (Schreiblauf: Avise ↔ Sammelzahlungen)"
      : "Task #1680 — Backfill-Verifier (DRY-RUN, keine Schreibvorgänge)",
  );
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

  const { proposals, ambiguous } = computeProposals(advices, credits);

  for (const entry of ambiguous) {
    const a = entry.advice;
    console.log(
      `⚠  Avis ${a.avisNummer ?? `#${a.id}`} (${formatEuro(a.gesamtBetragCents)}): mehrdeutig — ` +
        (entry.reason === "multiple_credits"
          ? `${entry.candidates.length} passende Gutschriften`
          : `Gutschrift auch von Avis ${entry.collidingAdviceIds.map((id) => `#${id}`).join(", ")} beansprucht`) +
        ` ⇒ KEIN Vorschlag (manuelle Prüfung).`,
    );
    for (const c of entry.candidates) {
      console.log(
        `      · Qonto-TX #${c.txId} · ${formatEuro(Math.abs(c.txAmountCents))} · ` +
          `${formatDate(c.txEmittedAt)} (${c.daysDelta >= 0 ? "+" : ""}${c.daysDelta} d) · ` +
          `„${c.txCounterpartyName ?? "—"}"`,
      );
    }
  }

  // Durable Report: die mehrdeutigen Avise + ihre konkurrierenden Gutschriften
  // werden als CSV UND JSON auf Platte geschrieben, damit ein Operator sie
  // außerhalb der Konsolen-Ausgabe abarbeiten kann (Task #1683).
  if (ambiguous.length > 0) {
    const outPrefix = get("--out=") ?? "advice-backfill-ambiguous";
    const csvPath = resolve(process.cwd(), `${outPrefix}.csv`);
    const jsonPath = resolve(process.cwd(), `${outPrefix}.json`);
    writeFileSync(csvPath, formatAmbiguousReportCsv(ambiguous), "utf8");
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          ambiguousAdviceCount: ambiguous.length,
          rows: buildAmbiguousReportRows(ambiguous),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(
      `\n📄 Mehrdeutigkeits-Report geschrieben (${ambiguous.length} Avis(e)):\n` +
        `      ${csvPath}\n      ${jsonPath}`,
    );
  }

  console.log("\n" + "─".repeat(78));
  if (proposals.length === 0) {
    console.log("Keine eindeutigen Backfill-Vorschläge gefunden.");
  } else {
    console.log(
      apply
        ? `Eindeutige Vorschläge werden jetzt verknüpft: ${proposals.length}\n`
        : `Eindeutige Vorschläge (würden bei --apply verknüpft): ${proposals.length}\n`,
    );
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

  if (!apply) {
    console.log(
      `\nZusammenfassung: ${proposals.length} eindeutig · ${ambiguous.length} mehrdeutig (übersprungen).`,
    );
    if (ambiguous.length > 0) {
      console.log(
        `\nMehrdeutige Avise müssen manuell aufgelöst werden — siehe den geschriebenen ` +
          `Report (CSV/JSON) oben; jede Zeile zeigt das Avis + die konkurrierende Gutschrift.`,
      );
    }
    console.log(
      '\nScharf verknüpfen mit: --apply --user=<superadmin-id> --reason="…"' +
        "\n  WICHTIG: In Dev vorbereiten/verifizieren, --apply gegen Prod erst nach Sign-off.",
    );
    console.log("DRY-RUN beendet — es wurde NICHTS geschrieben.\n");
    return;
  }

  console.log(`\nSuperadmin: ${userId} · Begründung: ${reason}`);
  console.log("\n" + "─".repeat(78));
  const linked = await applyProposals(proposals, userId!, reason!);
  console.log("─".repeat(78));
  console.log(
    `\nAPPLY beendet: ${linked} Avis(e) verknüpft · ` +
      `${proposals.length - linked} übersprungen (idempotent) · ` +
      `${ambiguous.length} mehrdeutig.\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Backfill-Verifier fehlgeschlagen:", err);
      process.exit(1);
    });
}
