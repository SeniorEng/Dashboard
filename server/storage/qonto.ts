import {
  qontoTransactions,
  qontoHideRules,
  paymentAdvices,
  paymentAdviceItems,
  invoices,
  type QontoTransaction,
  type InsertQontoTransaction,
  type QontoHideRule,
  type InsertQontoHideRule,
  type PaymentAdvice,
  type InsertPaymentAdvice,
  type PaymentAdviceItem,
  type InsertPaymentAdviceItem,
} from "@shared/schema";
import { eq, and, isNull, isNotNull, desc, gte, lte, sql, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { parseLocalDate } from "@shared/utils/datetime";
import { paymentAdvicesRepo } from "../repos";

interface PaymentAdviceWithItems extends PaymentAdvice {
  items: PaymentAdviceItem[];
}

/**
 * Task #1742 — Anzeige-Zeile einer Rechnung, die in eine Zahlung eingeflossen ist.
 * Rein lesend/anzeigend: keine Buchungslogik, keine Beträge außer dem Brutto.
 */
export interface MatchedInvoiceDisplay {
  id: number;
  invoiceNumber: string;
  recipientName: string;
  customerName: string | null;
  grossAmountCents: number;
  status: string;
  /** Rechnungs-/Erstellungsdatum (ISO), für die Anzeige. */
  createdAt: string;
}

/**
 * Task #1742 — die einer Qonto-Zahlung zugeordneten Rechnungen (1:1 ODER
 * Sammel-Avis), inkl. Summe und Zahlbetrag für die Abgleich-Zeile.
 */
export interface MatchedInvoicesForTransaction {
  matchType: "single" | "bulk" | "none";
  /** Betrag der Zahlung (Betrag der Gutschrift, positiv). */
  transactionAmountCents: number;
  invoices: MatchedInvoiceDisplay[];
  /** Σ der Rechnungs-Brutto-Beträge (Integer-Cents). */
  sumCents: number;
}

class QontoStorage {
  async getTransactions(filters: {
    from?: string;
    to?: string;
    matched?: "matched" | "unmatched" | "ignored" | "all";
    limit?: number;
    offset?: number;
  } = {}): Promise<{ transactions: QontoTransaction[]; total: number }> {
    const conditions = [eq(qontoTransactions.side, "credit")];

    if (filters.from) {
      // Filter kommt als YYYY-MM-DD-String. Wir vergleichen gegen
      // emittedAt (timestamptz). parseLocalDate() liefert lokale
      // Mitternacht und ist damit unabhängig von der Server-TZ
      // konsistent zu allen anderen Datums-Operationen im Projekt.
      conditions.push(gte(qontoTransactions.emittedAt, parseLocalDate(filters.from)));
    }
    if (filters.to) {
      // "to" ist ein einschließendes Tagesende: lokale 23:59:59 des Tages.
      const endOfDay = parseLocalDate(filters.to);
      endOfDay.setHours(23, 59, 59, 999);
      conditions.push(lte(qontoTransactions.emittedAt, endOfDay));
    }
    if (filters.matched === "matched") {
      // Task #1672 — „zugeordnet" = an eine Rechnung ODER an einen Sammel-Avis gebunden.
      conditions.push(sql`(${qontoTransactions.matchedInvoiceId} IS NOT NULL OR ${qontoTransactions.matchedPaymentAdviceId} IS NOT NULL)`);
    } else if (filters.matched === "unmatched") {
      // „Offen" = weder zugeordnet (Rechnung/Avis) NOCH nicht abrechnungsrelevant.
      conditions.push(isNull(qontoTransactions.matchedInvoiceId));
      conditions.push(isNull(qontoTransactions.matchedPaymentAdviceId));
      conditions.push(isNull(qontoTransactions.billingIrrelevantAt));
    } else if (filters.matched === "ignored") {
      conditions.push(isNotNull(qontoTransactions.billingIrrelevantAt));
    }

    const where = and(...conditions);

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` })
      .from(qontoTransactions)
      .where(where);

    const transactions = await db.select()
      .from(qontoTransactions)
      .where(where)
      .orderBy(desc(qontoTransactions.emittedAt))
      .limit(filters.limit || 50)
      .offset(filters.offset || 0);

    return { transactions, total: countResult?.count ?? 0 };
  }

  async getTransaction(id: number): Promise<QontoTransaction | undefined> {
    const [tx] = await db.select()
      .from(qontoTransactions)
      .where(eq(qontoTransactions.id, id));
    return tx;
  }

  async getTransactionByQontoId(qontoId: string): Promise<QontoTransaction | null> {
    const [result] = await db.select()
      .from(qontoTransactions)
      .where(eq(qontoTransactions.qontoTransactionId, qontoId))
      .limit(1);
    return result ?? null;
  }

  async upsertTransaction(data: InsertQontoTransaction): Promise<QontoTransaction> {
    const existing = await db.select()
      .from(qontoTransactions)
      .where(eq(qontoTransactions.qontoTransactionId, data.qontoTransactionId))
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await db.update(qontoTransactions)
        .set({
          amountCents: data.amountCents,
          status: data.status,
          counterpartyName: data.counterpartyName,
          reference: data.reference,
          label: data.label,
          sourceIban: data.sourceIban,
          rawData: data.rawData,
          syncedAt: new Date(),
        })
        .where(eq(qontoTransactions.id, existing[0].id))
        .returning();
      return updated;
    }

    const [created] = await db.insert(qontoTransactions)
      .values(data)
      .returning();
    return created;
  }

  async updateTransactionMatch(
    id: number,
    matchedInvoiceId: number | null,
    confidence: string | null,
    tx?: Pick<typeof db, 'update'>
  ): Promise<QontoTransaction | undefined> {
    const executor = tx ?? db;
    const [updated] = await executor.update(qontoTransactions)
      .set({ matchedInvoiceId, matchConfidence: confidence })
      .where(eq(qontoTransactions.id, id))
      .returning();
    return updated;
  }

  async getUnmatchedTransactions(): Promise<QontoTransaction[]> {
    // Auto-Abgleich ignoriert als „nicht abrechnungsrelevant" markierte
    // Eingänge (billing_irrelevant_at IS NOT NULL) — konsistent zur „Offen"-Liste.
    return db.select()
      .from(qontoTransactions)
      .where(and(
        isNull(qontoTransactions.matchedInvoiceId),
        isNull(qontoTransactions.matchedPaymentAdviceId),
        isNull(qontoTransactions.billingIrrelevantAt),
        eq(qontoTransactions.side, "credit")
      ))
      .orderBy(desc(qontoTransactions.emittedAt));
  }

  // Task #1599 — Auto-Ausblenden-Regeln.
  async getHideRules(): Promise<QontoHideRule[]> {
    return db.select()
      .from(qontoHideRules)
      .where(isNull(qontoHideRules.deletedAt))
      .orderBy(desc(qontoHideRules.createdAt));
  }

  async getHideRule(id: number): Promise<QontoHideRule | undefined> {
    const [rule] = await db.select()
      .from(qontoHideRules)
      .where(and(eq(qontoHideRules.id, id), isNull(qontoHideRules.deletedAt)));
    return rule;
  }

  async createHideRule(data: InsertQontoHideRule): Promise<QontoHideRule> {
    const [created] = await db.insert(qontoHideRules).values(data).returning();
    return created;
  }

  async deleteHideRule(id: number): Promise<QontoHideRule | undefined> {
    const [deleted] = await db.update(qontoHideRules)
      .set({ deletedAt: new Date() })
      .where(and(eq(qontoHideRules.id, id), isNull(qontoHideRules.deletedAt)))
      .returning();
    return deleted;
  }

  /**
   * Task #1599 — Kandidaten für das automatische Ausblenden: offene
   * Zahlungseingänge (credit), die weder zugeordnet noch bereits ausgeblendet
   * sind und für die der Nutzer keine manuelle „doch relevant"-Entscheidung
   * getroffen hat (Override). Die eigentliche Regel-Prüfung erfolgt in JS über
   * die geteilte matchesAnyHideRule()-Logik.
   */
  async getAutoHideCandidates(): Promise<QontoTransaction[]> {
    return db.select()
      .from(qontoTransactions)
      .where(and(
        eq(qontoTransactions.side, "credit"),
        isNull(qontoTransactions.matchedInvoiceId),
        isNull(qontoTransactions.billingIrrelevantAt),
        isNull(qontoTransactions.billingRelevantOverrideAt),
      ));
  }

  /** Markiert die übergebenen Transaktionen als automatisch ausgeblendet. */
  async markTransactionsIrrelevantAuto(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const updated = await db.update(qontoTransactions)
      .set({ billingIrrelevantAt: new Date(), billingIrrelevantSource: "auto" })
      .where(and(
        inArray(qontoTransactions.id, ids),
        isNull(qontoTransactions.billingIrrelevantAt),
        isNull(qontoTransactions.matchedInvoiceId),
        isNull(qontoTransactions.billingRelevantOverrideAt),
      ))
      .returning({ id: qontoTransactions.id });
    return updated.length;
  }

  async getLastSyncTime(): Promise<Date | null> {
    const [result] = await db.select({ syncedAt: qontoTransactions.syncedAt })
      .from(qontoTransactions)
      .orderBy(desc(qontoTransactions.syncedAt))
      .limit(1);
    return result?.syncedAt ?? null;
  }

  async findDuplicateAdvice(fileName: string, avisNummer?: string | null, gesamtBetragCents?: number | null, zahlungsDatum?: string | null): Promise<PaymentAdvice | null> {
    const fileMatch = await paymentAdvicesRepo.selectFrom(db)
      .where(and(eq(paymentAdvices.fileName, fileName), isNull(paymentAdvices.deletedAt)))
      .limit(1);
    if (fileMatch.length > 0) return fileMatch[0];

    if (avisNummer && gesamtBetragCents != null && zahlungsDatum) {
      const fieldMatch = await paymentAdvicesRepo.selectFrom(db)
        .where(and(
          eq(paymentAdvices.avisNummer, avisNummer),
          eq(paymentAdvices.gesamtBetragCents, gesamtBetragCents),
          eq(paymentAdvices.zahlungsDatum, zahlungsDatum),
          isNull(paymentAdvices.deletedAt),
        ))
        .limit(1);
      if (fieldMatch.length > 0) return fieldMatch[0];
    }

    return null;
  }

  async createPaymentAdvice(data: InsertPaymentAdvice): Promise<PaymentAdvice> {
    const [created] = await db.insert(paymentAdvices)
      .values(data)
      .returning();
    return created;
  }

  async createPaymentAdviceWithItems(
    adviceData: InsertPaymentAdvice,
    items: Omit<InsertPaymentAdviceItem, "paymentAdviceId">[]
  ): Promise<PaymentAdviceWithItems> {
    return await db.transaction(async (tx) => {
      const [advice] = await tx.insert(paymentAdvices)
        .values(adviceData)
        .returning();

      const createdItems: PaymentAdviceItem[] = [];
      if (items.length > 0) {
        const itemsWithAdviceId = items.map(item => ({
          ...item,
          paymentAdviceId: advice.id,
        }));
        const inserted = await tx.insert(paymentAdviceItems)
          .values(itemsWithAdviceId)
          .returning();
        createdItems.push(...inserted);
      }

      return { ...advice, items: createdItems };
    });
  }

  async getPaymentAdvices(): Promise<PaymentAdviceWithItems[]> {
    const advices = await paymentAdvicesRepo.selectFrom(db)
      .where(isNull(paymentAdvices.deletedAt))
      .orderBy(desc(paymentAdvices.uploadedAt));

    if (advices.length === 0) return [];

    const adviceIds = advices.map(a => a.id);
    const allItems = await db.select()
      .from(paymentAdviceItems)
      .where(sql`${paymentAdviceItems.paymentAdviceId} IN (${sql.join(adviceIds.map(id => sql`${id}`), sql`, `)})`);

    const itemsByAdviceId = new Map<number, PaymentAdviceItem[]>();
    for (const item of allItems) {
      const list = itemsByAdviceId.get(item.paymentAdviceId) || [];
      list.push(item);
      itemsByAdviceId.set(item.paymentAdviceId, list);
    }

    return advices.map(a => ({
      ...a,
      items: itemsByAdviceId.get(a.id) || [],
    }));
  }

  async getPaymentAdviceById(id: number): Promise<PaymentAdviceWithItems | null> {
    const [advice] = await paymentAdvicesRepo.selectFrom(db)
      .where(and(eq(paymentAdvices.id, id), isNull(paymentAdvices.deletedAt)));

    if (!advice) return null;

    const items = await db.select()
      .from(paymentAdviceItems)
      .where(eq(paymentAdviceItems.paymentAdviceId, id));

    return { ...advice, items };
  }

  /**
   * Task #1672 — offene Avise für den Sammel-Avis-Match: nicht gelöschte Avise
   * mit gesetztem Gesamtbetrag, die mindestens eine zugeordnete Rechnung im
   * Status `versendet`/`avis_erhalten` tragen (bezahlt/storniert zählen NICHT).
   * Liefert je Avis die offenen Rechnungs-IDs und ihre Summe (Integer-Cents) für
   * die Triple-Equality. Bereits per Sammelzahlung geschlossene Avise fallen
   * automatisch heraus (ihre Rechnungen sind dann `bezahlt` ⇒ keine offenen).
   */
  async getOpenAdvicesForMatching(): Promise<Array<{
    id: number;
    avisNummer: string | null;
    gesamtBetragCents: number | null;
    zahlungsempfaengerIban: string | null;
    openInvoiceIds: number[];
    sumOpenInvoiceCents: number;
  }>> {
    const advices = await paymentAdvicesRepo.selectFrom(db)
      .where(and(paymentAdvicesRepo.activeOnly(), isNotNull(paymentAdvices.gesamtBetragCents)));

    if (advices.length === 0) return [];

    const adviceIds = advices.map(a => a.id);
    const rows = await db.select({
      adviceId: paymentAdviceItems.paymentAdviceId,
      invoiceId: invoices.id,
      grossAmountCents: invoices.grossAmountCents,
    })
      .from(paymentAdviceItems)
      .innerJoin(invoices, eq(paymentAdviceItems.matchedInvoiceId, invoices.id))
      .where(and(
        inArray(paymentAdviceItems.paymentAdviceId, adviceIds),
        inArray(invoices.status, ["versendet", "avis_erhalten"]),
      ));

    const byAdvice = new Map<number, { ids: number[]; sum: number }>();
    for (const r of rows) {
      const agg = byAdvice.get(r.adviceId) ?? { ids: [], sum: 0 };
      if (!agg.ids.includes(r.invoiceId)) {
        agg.ids.push(r.invoiceId);
        agg.sum += r.grossAmountCents;
      }
      byAdvice.set(r.adviceId, agg);
    }

    return advices
      .map(a => {
        const agg = byAdvice.get(a.id);
        return {
          id: a.id,
          avisNummer: a.avisNummer,
          gesamtBetragCents: a.gesamtBetragCents,
          zahlungsempfaengerIban: a.zahlungsempfaengerIban,
          openInvoiceIds: agg?.ids ?? [],
          sumOpenInvoiceCents: agg?.sum ?? 0,
        };
      })
      .filter(a => a.openInvoiceIds.length > 0);
  }

  /**
   * Task #1672 — Anzeige-Zusammenfassung mehrerer Avise (für die Transaktions-
   * liste: „Avis 2026-0812 · 25 Rechnungen · 12.847,50 €"). invoiceCount zählt
   * ALLE dem Avis zugeordneten Rechnungen (nicht nur offene), damit die Anzeige
   * nach dem Bezahlen stabil bleibt.
   */
  async getAdviceSummariesByIds(ids: number[]): Promise<Map<number, {
    id: number;
    avisNummer: string | null;
    gesamtBetragCents: number | null;
    invoiceCount: number;
  }>> {
    const result = new Map<number, { id: number; avisNummer: string | null; gesamtBetragCents: number | null; invoiceCount: number }>();
    if (ids.length === 0) return result;

    const advices = await paymentAdvicesRepo.selectColumnsFrom({
      id: paymentAdvices.id,
      avisNummer: paymentAdvices.avisNummer,
      gesamtBetragCents: paymentAdvices.gesamtBetragCents,
    }, db)
      .where(and(inArray(paymentAdvices.id, ids), paymentAdvicesRepo.activeOnly()));

    const counts = await db.select({
      adviceId: paymentAdviceItems.paymentAdviceId,
      cnt: sql<number>`count(*)::int`,
    })
      .from(paymentAdviceItems)
      .where(and(
        inArray(paymentAdviceItems.paymentAdviceId, ids),
        isNotNull(paymentAdviceItems.matchedInvoiceId),
      ))
      .groupBy(paymentAdviceItems.paymentAdviceId);

    const countByAdvice = new Map(counts.map(c => [c.adviceId, c.cnt]));
    for (const a of advices) {
      result.set(a.id, {
        id: a.id,
        avisNummer: a.avisNummer,
        gesamtBetragCents: a.gesamtBetragCents,
        invoiceCount: countByAdvice.get(a.id) ?? 0,
      });
    }
    return result;
  }

  /**
   * Summe der Brutto-Forderung(en), die einer Qonto-Zahlung zugeordnet sind —
   * batched über viele Transaktionen für den Listen-Lesepfad. Für 1:1-Matches ist
   * es das Rechnungs-Brutto, für Sammel-Avis-Bindungen die Σ der über das Avis
   * verknüpften Rechnungen. Reines Anzeige-Plumbing; die fachliche Bewertung
   * „passt der Betrag?" macht ausschließlich `classifyPaymentDifference` (SSoT).
   */
  async getMatchedGrossByTxIds(
    txs: { id: number; matchedInvoiceId: number | null; matchedPaymentAdviceId: number | null }[],
  ): Promise<Map<number, number>> {
    const result = new Map<number, number>();

    const invoiceIds = Array.from(new Set(
      txs.map(t => t.matchedInvoiceId).filter((v): v is number => v != null),
    ));
    const adviceIds = Array.from(new Set(
      txs.map(t => t.matchedPaymentAdviceId).filter((v): v is number => v != null),
    ));

    const grossByInvoiceId = new Map<number, number>();
    if (invoiceIds.length > 0) {
      const rows = await db.select({ id: invoices.id, grossAmountCents: invoices.grossAmountCents })
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds));
      for (const r of rows) grossByInvoiceId.set(r.id, r.grossAmountCents);
    }

    const grossByAdviceId = new Map<number, number>();
    if (adviceIds.length > 0) {
      const rows = await db.select({
        adviceId: paymentAdviceItems.paymentAdviceId,
        grossSum: sql<number>`coalesce(sum(${invoices.grossAmountCents}), 0)::int`,
      })
        .from(paymentAdviceItems)
        .innerJoin(invoices, eq(paymentAdviceItems.matchedInvoiceId, invoices.id))
        .where(and(
          inArray(paymentAdviceItems.paymentAdviceId, adviceIds),
          isNotNull(paymentAdviceItems.matchedInvoiceId),
        ))
        .groupBy(paymentAdviceItems.paymentAdviceId);
      for (const r of rows) grossByAdviceId.set(r.adviceId, r.grossSum);
    }

    for (const t of txs) {
      if (t.matchedInvoiceId != null) {
        const gross = grossByInvoiceId.get(t.matchedInvoiceId);
        if (gross != null) result.set(t.id, gross);
      } else if (t.matchedPaymentAdviceId != null) {
        const gross = grossByAdviceId.get(t.matchedPaymentAdviceId);
        if (gross != null) result.set(t.id, gross);
      }
    }
    return result;
  }

  /**
   * Task #1672 — abgelehnter Vorschlag: Zeitstempel setzen, damit derselbe
   * rückwirkende Sammel-Avis-Vorschlag nach dem nächsten Sync/Import nicht
   * erneut angeboten wird. Nur auf noch nicht zugeordneten Transaktionen sinnvoll.
   */
  async dismissAdviceSuggestion(txId: number): Promise<QontoTransaction | undefined> {
    const [updated] = await db.update(qontoTransactions)
      .set({ adviceSuggestionDismissedAt: new Date() })
      .where(eq(qontoTransactions.id, txId))
      .returning();
    return updated;
  }

  async updatePaymentAdviceItemMatch(
    itemId: number,
    matchedInvoiceId: number | null
  ): Promise<PaymentAdviceItem | undefined> {
    const [updated] = await db.update(paymentAdviceItems)
      .set({ matchedInvoiceId })
      .where(eq(paymentAdviceItems.id, itemId))
      .returning();
    return updated;
  }

  /**
   * Task #1710 — Doppelzählungs-Guard für die manuelle Mehrfach-Zuordnung:
   * liefert aus den übergebenen Kandidaten-Rechnungs-IDs die Teilmenge, die
   * bereits durch eine Zahlung „beansprucht" ist — d.h. entweder 1:1 an eine
   * Qonto-Transaktion gebunden (`matched_invoice_id`) ODER Mitglied eines noch
   * nicht gelöschten (importierten oder manuellen) Zahlungsavis. Wird sowohl im
   * Picker-Lesepfad als auch im Schreib-Guard des Bulk-Match innerhalb der
   * Transaktion verwendet, damit dieselbe Rechnung nie zwei Zahlungen zufällt.
   */
  async getClaimedInvoiceIds(exec: DbOrTx, candidateIds: number[]): Promise<Set<number>> {
    const claimed = new Set<number>();
    if (candidateIds.length === 0) return claimed;

    const adviceRows = await exec.select({ invoiceId: paymentAdviceItems.matchedInvoiceId })
      .from(paymentAdviceItems)
      .innerJoin(paymentAdvices, eq(paymentAdviceItems.paymentAdviceId, paymentAdvices.id))
      .where(and(
        inArray(paymentAdviceItems.matchedInvoiceId, candidateIds),
        isNull(paymentAdvices.deletedAt),
      ));
    for (const r of adviceRows) {
      if (r.invoiceId != null) claimed.add(r.invoiceId);
    }

    const txRows = await exec.select({ invoiceId: qontoTransactions.matchedInvoiceId })
      .from(qontoTransactions)
      .where(inArray(qontoTransactions.matchedInvoiceId, candidateIds));
    for (const r of txRows) {
      if (r.invoiceId != null) claimed.add(r.invoiceId);
    }

    return claimed;
  }

  /**
   * Task #1742 — Transparenz-Leser: welche Rechnungen stecken in EINER Zahlung?
   * Deckt beide Zuordnungswege ab (1:1 `matchedInvoiceId` ODER Sammel-Avis
   * `matchedPaymentAdviceId`, egal ob manuell oder automatisch verknüpft) und
   * wiederverwendet dafür den bestehenden Avis-Leser (`getPaymentAdviceById`) —
   * kein dritter, paralleler Pfad. Rein lesend, keine Buchungslogik.
   * Gibt `null` zurück, wenn die Transaktion nicht existiert.
   */
  async getMatchedInvoicesForTransaction(
    txId: number,
  ): Promise<MatchedInvoicesForTransaction | null> {
    const tx = await this.getTransaction(txId);
    if (!tx) return null;

    const transactionAmountCents = Math.abs(tx.amountCents);

    let matchType: MatchedInvoicesForTransaction["matchType"] = "none";
    let invoiceIds: number[] = [];

    if (tx.matchedInvoiceId) {
      matchType = "single";
      invoiceIds = [tx.matchedInvoiceId];
    } else if (tx.matchedPaymentAdviceId) {
      matchType = "bulk";
      const advice = await this.getPaymentAdviceById(tx.matchedPaymentAdviceId);
      invoiceIds = (advice?.items ?? [])
        .map(it => it.matchedInvoiceId)
        .filter((v): v is number => v != null);
    }

    if (invoiceIds.length === 0) {
      return { matchType, transactionAmountCents, invoices: [], sumCents: 0 };
    }

    // Deduplizieren, Reihenfolge der IDs erhalten.
    const uniqueIds = Array.from(new Set(invoiceIds));
    const rows = await db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      recipientName: invoices.recipientName,
      customerName: invoices.customerName,
      grossAmountCents: invoices.grossAmountCents,
      status: invoices.status,
      createdAt: invoices.createdAt,
    })
      .from(invoices)
      .where(inArray(invoices.id, uniqueIds));

    const byId = new Map(rows.map(r => [r.id, r]));
    const displayInvoices: MatchedInvoiceDisplay[] = [];
    for (const id of uniqueIds) {
      const r = byId.get(id);
      if (!r) continue;
      displayInvoices.push({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        recipientName: r.recipientName,
        customerName: r.customerName,
        grossAmountCents: r.grossAmountCents,
        status: r.status,
        createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
      });
    }

    const sumCents = displayInvoices.reduce((acc, inv) => acc + inv.grossAmountCents, 0);
    return { matchType, transactionAmountCents, invoices: displayInvoices, sumCents };
  }

  async deletePaymentAdvice(id: number): Promise<boolean> {
    const [result] = await db.update(paymentAdvices)
      .set({ deletedAt: new Date() })
      .where(and(
        eq(paymentAdvices.id, id),
        isNull(paymentAdvices.deletedAt)
      ))
      .returning();
    return !!result;
  }
}

export const qontoStorage = new QontoStorage();
