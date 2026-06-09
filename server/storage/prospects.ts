import {
  type Prospect,
  type InsertProspect,
  type UpdateProspect,
  type ProspectNote,
  type InsertProspectNote,
  type ProspectOffer,
  type ProspectWithErstberatung,
  type ProspectErstberatungInfo,
  prospects,
  prospectNotes,
  prospectOffers,
  appointments,
  users,
} from "@shared/schema";
import { eq, and, or, ilike, isNull, ne, asc, desc, sql, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../lib/db";
import { parseLocalDate } from "@shared/utils/datetime";
import { attributeAppointmentToEmployees } from "@shared/domain/appointment-attribution";
import { appointmentsRepo, prospectsRepo } from "../repos";

export const prospectStorage = {
  async create(data: InsertProspect): Promise<Prospect> {
    const [prospect] = await db.insert(prospects).values(data).returning();
    return prospect;
  },

  async getAll(filters?: {
    status?: string;
    search?: string;
  }): Promise<ProspectWithErstberatung[]> {
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

    const rows = await prospectsRepo.selectFrom(db)
      .where(and(...conditions))
      .orderBy(desc(prospects.createdAt));

    const erstberatungByProspect = await this.getErstberatungInfoForProspects(
      rows.map(p => p.id),
    );

    return rows.map(p => ({
      ...p,
      erstberatung: erstberatungByProspect.get(p.id) ?? null,
    }));
  },

  /**
   * Lädt für die übergebenen Interessenten den jeweils relevanten
   * Erstberatungstermin (Termin-Typ `Erstberatung`, nicht storniert, nicht
   * gelöscht). Bei mehreren Terminen wird der aktuellste (spätestes Datum +
   * Startzeit) gewählt. Der verantwortliche Mitarbeiter wird über die zentrale
   * Termin→Mitarbeiter-Regel (`attributeAppointmentToEmployees`) bestimmt:
   * durchgeführt → performedBy, sonst zugewiesen.
   */
  async getErstberatungInfoForProspects(
    prospectIds: number[],
  ): Promise<Map<number, ProspectErstberatungInfo>> {
    const result = new Map<number, ProspectErstberatungInfo>();
    if (prospectIds.length === 0) return result;

    const assignedUser = alias(users, "erstberatung_assigned_user");
    const performedUser = alias(users, "erstberatung_performed_user");

    // Aufsteigend sortiert: pro Interessent gewinnt damit die letzte (aktuellste) Zeile.
    const apptRows = await appointmentsRepo
      .selectColumnsFrom({
        prospectId: appointments.prospectId,
        date: appointments.date,
        scheduledStart: appointments.scheduledStart,
        status: appointments.status,
        assignedEmployeeId: appointments.assignedEmployeeId,
        performedByEmployeeId: appointments.performedByEmployeeId,
        assignedName: assignedUser.displayName,
        performedName: performedUser.displayName,
      }, db)
      .leftJoin(assignedUser, eq(appointments.assignedEmployeeId, assignedUser.id))
      .leftJoin(performedUser, eq(appointments.performedByEmployeeId, performedUser.id))
      .where(and(
        inArray(appointments.prospectId, prospectIds),
        eq(appointments.appointmentType, "Erstberatung"),
        isNull(appointments.deletedAt),
        ne(appointments.status, "cancelled"),
      ))
      .orderBy(asc(appointments.date), asc(appointments.scheduledStart));

    for (const row of apptRows) {
      if (row.prospectId == null) continue;

      const employeeIds = attributeAppointmentToEmployees(
        {
          status: row.status,
          assignedEmployeeId: row.assignedEmployeeId,
          performedByEmployeeId: row.performedByEmployeeId,
        },
        null,
      );
      const employeeId = employeeIds[0] ?? null;
      let employeeName: string | null = null;
      if (employeeId != null && employeeId === row.performedByEmployeeId) {
        employeeName = row.performedName;
      } else if (employeeId != null && employeeId === row.assignedEmployeeId) {
        employeeName = row.assignedName;
      }

      // Aufsteigend sortiert ⇒ Überschreiben behält den aktuellsten Termin.
      result.set(row.prospectId, {
        date: row.date,
        scheduledStart: row.scheduledStart,
        status: row.status,
        employeeName,
      });
    }

    return result;
  },

  async getById(id: number): Promise<Prospect | undefined> {
    const [prospect] = await prospectsRepo.selectFrom(db)
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
    const rows = await prospectsRepo.selectColumnsFrom({
        status: prospects.status,
        count: sql<number>`count(*)::int`,
      }, db)
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
    const prospect = await prospectsRepo.selectFrom(db)
      .where(and(eq(prospects.id, prospectId), isNull(prospects.deletedAt)))
      .then(rows => rows[0]);

    if (!prospect) return null;

    const prospectAppointments = await appointmentsRepo.selectFrom(db)
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
