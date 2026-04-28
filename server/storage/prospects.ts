import {
  type Prospect,
  type InsertProspect,
  type UpdateProspect,
  type ProspectNote,
  type InsertProspectNote,
  type ProspectOffer,
  prospects,
  prospectNotes,
  prospectOffers,
  appointments,
} from "@shared/schema";
import { eq, and, or, ilike, isNull, desc, sql, inArray } from "drizzle-orm";
import { db } from "../lib/db";
import { parseLocalDate } from "@shared/utils/datetime";

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
      const statuses = filters.status.split(",").map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        conditions.push(eq(prospects.status, statuses[0]));
      } else if (statuses.length > 1) {
        conditions.push(inArray(prospects.status, statuses));
      }
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
        status: "gewonnen",
        convertedCustomerId: customerId,
        updatedAt: new Date(),
      })
      .where(eq(prospects.id, id))
      .returning();
    return updated;
  },

  async getAppointmentData(prospectId: number) {
    const prospect = await db
      .select()
      .from(prospects)
      .where(and(eq(prospects.id, prospectId), isNull(prospects.deletedAt)))
      .then(rows => rows[0]);

    if (!prospect) return null;

    const prospectAppointments = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.prospectId, prospectId), isNull(appointments.deletedAt)));

    return { prospect, appointments: prospectAppointments };
  },

  async createOffer(prospectId: number, wizardData: Record<string, unknown>, userId: number, expiresAt?: string | null): Promise<ProspectOffer> {
    const [offer] = await db.insert(prospectOffers).values({
      prospectId,
      wizardData,
      createdBy: userId,
      expiresAt: expiresAt ? parseLocalDate(expiresAt) : null,
    }).returning();
    return offer;
  },

  async getOpenOffer(prospectId: number): Promise<ProspectOffer | undefined> {
    const [offer] = await db
      .select()
      .from(prospectOffers)
      .where(and(
        eq(prospectOffers.prospectId, prospectId),
        eq(prospectOffers.status, "offen"),
      ))
      .orderBy(desc(prospectOffers.createdAt))
      .limit(1);
    return offer;
  },

  async updateOfferStatus(offerId: number, status: "angenommen" | "abgelehnt"): Promise<ProspectOffer | undefined> {
    const [updated] = await db
      .update(prospectOffers)
      .set({ status })
      .where(eq(prospectOffers.id, offerId))
      .returning();
    return updated;
  },

  async qualify(id: number, geoQualified: boolean | null): Promise<Prospect | undefined> {
    const [updated] = await db
      .update(prospects)
      .set({
        status: "qualifiziert",
        geoQualified: geoQualified ?? true,
        updatedAt: new Date(),
      })
      .where(and(eq(prospects.id, id), isNull(prospects.deletedAt)))
      .returning();
    return updated;
  },

  async disqualify(id: number, reason: string): Promise<Prospect | undefined> {
    const [updated] = await db
      .update(prospects)
      .set({
        status: "disqualifiziert",
        disqualificationReason: reason,
        updatedAt: new Date(),
      })
      .where(and(eq(prospects.id, id), isNull(prospects.deletedAt)))
      .returning();
    return updated;
  },
};
