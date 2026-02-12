import { eq, and, desc, asc, lte, gte, isNull, or, inArray, sql } from "drizzle-orm";
import {
  documentTypes,
  employeeDocuments,
  type DocumentType,
  type InsertDocumentType,
  type UpdateDocumentType,
  type EmployeeDocument,
  type InsertEmployeeDocument,
} from "@shared/schema";
import { db } from "../lib/db";
import { todayISO } from "@shared/utils/datetime";

export interface IDocumentStorage {
  getDocumentTypes(activeOnly?: boolean): Promise<DocumentType[]>;
  getDocumentType(id: number): Promise<DocumentType | null>;
  createDocumentType(data: InsertDocumentType): Promise<DocumentType>;
  updateDocumentType(id: number, data: UpdateDocumentType): Promise<DocumentType | null>;

  uploadDocument(data: InsertEmployeeDocument, uploadedByUserId: number): Promise<EmployeeDocument>;
  getCurrentDocuments(employeeId: number): Promise<(EmployeeDocument & { documentType: DocumentType })[]>;
  getDocumentHistory(employeeId: number, documentTypeId: number): Promise<EmployeeDocument[]>;
  getDocumentsDueSoon(leadTimeDays?: number): Promise<(EmployeeDocument & { documentType: DocumentType; employee: { id: number; displayName: string } })[]>;
}

export class DocumentStorage implements IDocumentStorage {
  async getDocumentTypes(activeOnly = true): Promise<DocumentType[]> {
    if (activeOnly) {
      return db.select().from(documentTypes).where(eq(documentTypes.isActive, true)).orderBy(asc(documentTypes.name));
    }
    return db.select().from(documentTypes).orderBy(asc(documentTypes.name));
  }

  async getDocumentType(id: number): Promise<DocumentType | null> {
    const result = await db.select().from(documentTypes).where(eq(documentTypes.id, id)).limit(1);
    return result[0] || null;
  }

  async createDocumentType(data: InsertDocumentType): Promise<DocumentType> {
    const [result] = await db.insert(documentTypes).values({
      name: data.name,
      description: data.description || null,
      reviewIntervalMonths: data.reviewIntervalMonths || null,
      reminderLeadTimeDays: data.reminderLeadTimeDays ?? 14,
      isActive: data.isActive ?? true,
    }).returning();
    return result;
  }

  async updateDocumentType(id: number, data: UpdateDocumentType): Promise<DocumentType | null> {
    const [result] = await db
      .update(documentTypes)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(documentTypes.id, id))
      .returning();
    return result || null;
  }

  async uploadDocument(data: InsertEmployeeDocument, uploadedByUserId: number): Promise<EmployeeDocument> {
    await db
      .update(employeeDocuments)
      .set({ isCurrent: false })
      .where(
        and(
          eq(employeeDocuments.employeeId, data.employeeId),
          eq(employeeDocuments.documentTypeId, data.documentTypeId),
          eq(employeeDocuments.isCurrent, true)
        )
      );

    const docType = await this.getDocumentType(data.documentTypeId);
    let reviewDueDate: string | null = null;
    if (docType?.reviewIntervalMonths) {
      const dueDate = new Date();
      dueDate.setMonth(dueDate.getMonth() + docType.reviewIntervalMonths);
      reviewDueDate = dueDate.toISOString().split("T")[0];
    }

    const [result] = await db.insert(employeeDocuments).values({
      employeeId: data.employeeId,
      documentTypeId: data.documentTypeId,
      fileName: data.fileName,
      objectPath: data.objectPath,
      uploadedByUserId,
      reviewDueDate,
      isCurrent: true,
      notes: data.notes || null,
    }).returning();

    return result;
  }

  async getCurrentDocuments(employeeId: number): Promise<(EmployeeDocument & { documentType: DocumentType })[]> {
    const docs = await db
      .select({
        doc: employeeDocuments,
        docType: documentTypes,
      })
      .from(employeeDocuments)
      .innerJoin(documentTypes, eq(employeeDocuments.documentTypeId, documentTypes.id))
      .where(
        and(
          eq(employeeDocuments.employeeId, employeeId),
          eq(employeeDocuments.isCurrent, true)
        )
      )
      .orderBy(asc(documentTypes.name));

    return docs.map(d => ({ ...d.doc, documentType: d.docType }));
  }

  async getDocumentHistory(employeeId: number, documentTypeId: number): Promise<EmployeeDocument[]> {
    return db
      .select()
      .from(employeeDocuments)
      .where(
        and(
          eq(employeeDocuments.employeeId, employeeId),
          eq(employeeDocuments.documentTypeId, documentTypeId)
        )
      )
      .orderBy(desc(employeeDocuments.uploadedAt));
  }

  async getDocumentsDueSoon(leadTimeDays: number = 30): Promise<(EmployeeDocument & { documentType: DocumentType; employee: { id: number; displayName: string } })[]> {
    const today = todayISO();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + leadTimeDays);
    const futureDateStr = futureDate.toISOString().split("T")[0];

    const { users } = await import("@shared/schema");
    
    const docs = await db
      .select({
        doc: employeeDocuments,
        docType: documentTypes,
        employee: {
          id: users.id,
          displayName: users.displayName,
        },
      })
      .from(employeeDocuments)
      .innerJoin(documentTypes, eq(employeeDocuments.documentTypeId, documentTypes.id))
      .innerJoin(users, eq(employeeDocuments.employeeId, users.id))
      .where(
        and(
          eq(employeeDocuments.isCurrent, true),
          lte(employeeDocuments.reviewDueDate, futureDateStr),
          sql`${employeeDocuments.reviewDueDate} IS NOT NULL`
        )
      )
      .orderBy(asc(employeeDocuments.reviewDueDate));

    return docs.map(d => ({ ...d.doc, documentType: d.docType, employee: d.employee }));
  }
}

export const documentStorage = new DocumentStorage();
