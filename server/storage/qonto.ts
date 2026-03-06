import {
  qontoTransactions,
  paymentAdvices,
  type QontoTransaction,
  type InsertQontoTransaction,
  type PaymentAdvice,
  type InsertPaymentAdvice,
} from "@shared/schema";
import { eq, and, isNull, isNotNull, desc, gte, lte, sql } from "drizzle-orm";
import { db } from "../lib/db";

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

  async createPaymentAdvice(data: InsertPaymentAdvice): Promise<PaymentAdvice> {
    const [created] = await db.insert(paymentAdvices)
      .values(data)
      .returning();
    return created;
  }

  async getPaymentAdvices(): Promise<PaymentAdvice[]> {
    return db.select()
      .from(paymentAdvices)
      .where(isNull(paymentAdvices.deletedAt))
      .orderBy(desc(paymentAdvices.uploadedAt));
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
