import {
  qontoTransactions,
  qontoHideRules,
  paymentAdvices,
  paymentAdviceItems,
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
import { db } from "../lib/db";
import { parseLocalDate } from "@shared/utils/datetime";
import { paymentAdvicesRepo } from "../repos";

interface PaymentAdviceWithItems extends PaymentAdvice {
  items: PaymentAdviceItem[];
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
      conditions.push(isNotNull(qontoTransactions.matchedInvoiceId));
    } else if (filters.matched === "unmatched") {
      // „Offen" = weder zugeordnet NOCH als nicht abrechnungsrelevant markiert.
      conditions.push(isNull(qontoTransactions.matchedInvoiceId));
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
