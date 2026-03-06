import {
  qontoTransactions,
  paymentAdvices,
  paymentAdviceItems,
  type QontoTransaction,
  type InsertQontoTransaction,
  type PaymentAdvice,
  type InsertPaymentAdvice,
  type PaymentAdviceItem,
  type InsertPaymentAdviceItem,
} from "@shared/schema";
import { eq, and, isNull, isNotNull, desc, gte, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";

export interface PaymentAdviceWithItems extends PaymentAdvice {
  items: PaymentAdviceItem[];
}

class QontoStorage {
  async getTransactions(filters: {
    from?: string;
    to?: string;
    matched?: "matched" | "unmatched" | "all";
    limit?: number;
    offset?: number;
  } = {}): Promise<{ transactions: QontoTransaction[]; total: number }> {
    const conditions = [eq(qontoTransactions.side, "credit")];

    if (filters.from) {
      conditions.push(gte(qontoTransactions.emittedAt, new Date(filters.from)));
    }
    if (filters.to) {
      conditions.push(lte(qontoTransactions.emittedAt, new Date(filters.to + "T23:59:59")));
    }
    if (filters.matched === "matched") {
      conditions.push(isNotNull(qontoTransactions.matchedInvoiceId));
    } else if (filters.matched === "unmatched") {
      conditions.push(isNull(qontoTransactions.matchedInvoiceId));
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
    confidence: string | null
  ): Promise<QontoTransaction | undefined> {
    const [updated] = await db.update(qontoTransactions)
      .set({ matchedInvoiceId, matchConfidence: confidence })
      .where(eq(qontoTransactions.id, id))
      .returning();
    return updated;
  }

  async getUnmatchedTransactions(): Promise<QontoTransaction[]> {
    return db.select()
      .from(qontoTransactions)
      .where(and(
        isNull(qontoTransactions.matchedInvoiceId),
        eq(qontoTransactions.side, "credit")
      ))
      .orderBy(desc(qontoTransactions.emittedAt));
  }

  async getLastSyncTime(): Promise<Date | null> {
    const [result] = await db.select({ syncedAt: qontoTransactions.syncedAt })
      .from(qontoTransactions)
      .orderBy(desc(qontoTransactions.syncedAt))
      .limit(1);
    return result?.syncedAt ?? null;
  }

  async findDuplicateAdvice(fileName: string, avisNummer?: string | null, gesamtBetragCents?: number | null, zahlungsDatum?: string | null): Promise<PaymentAdvice | null> {
    const fileMatch = await db.select()
      .from(paymentAdvices)
      .where(and(eq(paymentAdvices.fileName, fileName), isNull(paymentAdvices.deletedAt)))
      .limit(1);
    if (fileMatch.length > 0) return fileMatch[0];

    if (avisNummer && gesamtBetragCents != null && zahlungsDatum) {
      const fieldMatch = await db.select()
        .from(paymentAdvices)
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
    const advices = await db.select()
      .from(paymentAdvices)
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
    const [advice] = await db.select()
      .from(paymentAdvices)
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
