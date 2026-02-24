import {
  type Prospect,
  type InsertProspect,
  type UpdateProspect,
  type ProspectNote,
  type InsertProspectNote,
  prospects,
  prospectNotes,
} from "@shared/schema";
import { eq, and, or, ilike, isNull, desc, sql } from "drizzle-orm";
import { db } from "../lib/db";

export const prospectStorage = {
  async create(data: InsertProspect): Promise<Prospect> {
    const [prospect] = await db.insert(prospects).values(data).returning();
    return prospect;
  },

  async getAll(filters?: {
    status?: string;
    search?: string;
  }): Promise<Prospect[]> {
    const conditions = [isNull(prospects.deletedAt)];

    if (filters?.status) {
      conditions.push(eq(prospects.status, filters.status));
    }

    if (filters?.search) {
      const term = `%${filters.search}%`;
      conditions.push(
        or(
          ilike(prospects.vorname, term),
          ilike(prospects.nachname, term),
          ilike(prospects.telefon, term),
          ilike(prospects.email, term),
          ilike(prospects.stadt, term),
        )!
      );
    }

    return db
      .select()
      .from(prospects)
      .where(and(...conditions))
      .orderBy(desc(prospects.createdAt));
  },

  async getById(id: number): Promise<Prospect | undefined> {
    const [prospect] = await db
      .select()
      .from(prospects)
      .where(and(eq(prospects.id, id), isNull(prospects.deletedAt)));
    return prospect;
  },

  async update(id: number, data: UpdateProspect): Promise<Prospect | undefined> {
    const [updated] = await db
      .update(prospects)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(prospects.id, id), isNull(prospects.deletedAt)))
      .returning();
    return updated;
  },

  async softDelete(id: number): Promise<boolean> {
    const [deleted] = await db
      .update(prospects)
      .set({ deletedAt: new Date() })
      .where(and(eq(prospects.id, id), isNull(prospects.deletedAt)))
      .returning();
    return !!deleted;
  },

  async getNotes(prospectId: number): Promise<ProspectNote[]> {
    return db
      .select()
      .from(prospectNotes)
      .where(eq(prospectNotes.prospectId, prospectId))
      .orderBy(desc(prospectNotes.createdAt));
  },

  async addNote(data: InsertProspectNote): Promise<ProspectNote> {
    const [note] = await db.insert(prospectNotes).values(data).returning();
    return note;
  },

  async getStats(): Promise<Record<string, number>> {
    const rows = await db
      .select({
        status: prospects.status,
        count: sql<number>`count(*)::int`,
      })
      .from(prospects)
      .where(isNull(prospects.deletedAt))
      .groupBy(prospects.status);

    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.status] = row.count;
    }
    return stats;
  },

  async markConverted(id: number, customerId: number): Promise<Prospect | undefined> {
    const [updated] = await db
      .update(prospects)
      .set({
        status: "erstberatung",
        convertedCustomerId: customerId,
        updatedAt: new Date(),
      })
      .where(eq(prospects.id, id))
      .returning();
    return updated;
  },
};
