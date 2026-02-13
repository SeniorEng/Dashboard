import { eq, and, desc, asc, lte, sql } from "drizzle-orm";
import { formatDateISO } from "@shared/utils/datetime";
import {
  documentTypes,
  employeeDocuments,
  customerDocuments,
  customers,
  type DocumentType,
  type InsertDocumentType,
  type UpdateDocumentType,
  type EmployeeDocument,
  type InsertEmployeeDocument,
  type CustomerDocument,
  type InsertCustomerDocument,
} from "@shared/schema";
import { db } from "../lib/db";

export interface IDocumentStorage {
  getDocumentTypes(activeOnly?: boolean, targetType?: string): Promise<DocumentType[]>;
  getDocumentType(id: number): Promise<DocumentType | null>;
  createDocumentType(data: InsertDocumentType): Promise<DocumentType>;
  updateDocumentType(id: number, data: UpdateDocumentType): Promise<DocumentType | null>;

  uploadDocument(data: InsertEmployeeDocument, uploadedByUserId: number): Promise<EmployeeDocument>;
  getCurrentDocuments(employeeId: number): Promise<(EmployeeDocument & { documentType: DocumentType })[]>;
  getDocumentHistory(employeeId: number, documentTypeId: number): Promise<EmployeeDocument[]>;
  getEmployeeDocumentsDueSoon(leadTimeDays?: number): Promise<(EmployeeDocument & { documentType: DocumentType; employee: { id: number; displayName: string } })[]>;

  uploadCustomerDocument(data: InsertCustomerDocument, uploadedByUserId: number): Promise<CustomerDocument>;
  getCurrentCustomerDocuments(customerId: number): Promise<(CustomerDocument & { documentType: DocumentType })[]>;
  getCustomerDocumentHistory(customerId: number, documentTypeId: number): Promise<CustomerDocument[]>;
  getCustomerDocumentsDueSoon(leadTimeDays?: number): Promise<(CustomerDocument & { documentType: DocumentType; customer: { id: number; name: string } })[]>;
}

export class DocumentStorage implements IDocumentStorage {
  async getDocumentTypes(activeOnly = true, targetType?: string): Promise<DocumentType[]> {
    const conditions = [];
    if (activeOnly) conditions.push(eq(documentTypes.isActive, true));
    if (targetType) conditions.push(eq(documentTypes.targetType, targetType));

    if (conditions.length > 0) {
      return db.select().from(documentTypes).where(and(...conditions)).orderBy(asc(documentTypes.name));
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
      targetType: data.targetType ?? "employee",
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

  private async calculateReviewDueDate(documentTypeId: number): Promise<string | null> {
    const docType = await this.getDocumentType(documentTypeId);
    if (!docType?.reviewIntervalMonths) return null;
    const dueDate = new Date();
    dueDate.setMonth(dueDate.getMonth() + docType.reviewIntervalMonths);
    return formatDateISO(dueDate);
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

    const reviewDueDate = await this.calculateReviewDueDate(data.documentTypeId);

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

  async getEmployeeDocumentsDueSoon(leadTimeDays: number = 30): Promise<(EmployeeDocument & { documentType: DocumentType; employee: { id: number; displayName: string } })[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + leadTimeDays);
    const futureDateStr = formatDateISO(futureDate);

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

  async uploadCustomerDocument(data: InsertCustomerDocument, uploadedByUserId: number): Promise<CustomerDocument> {
    await db
      .update(customerDocuments)
      .set({ isCurrent: false })
      .where(
        and(
          eq(customerDocuments.customerId, data.customerId),
          eq(customerDocuments.documentTypeId, data.documentTypeId),
          eq(customerDocuments.isCurrent, true)
        )
      );

    const reviewDueDate = await this.calculateReviewDueDate(data.documentTypeId);

    const [result] = await db.insert(customerDocuments).values({
      customerId: data.customerId,
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

  async getCurrentCustomerDocuments(customerId: number): Promise<(CustomerDocument & { documentType: DocumentType })[]> {
    const docs = await db
      .select({
        doc: customerDocuments,
        docType: documentTypes,
      })
      .from(customerDocuments)
      .innerJoin(documentTypes, eq(customerDocuments.documentTypeId, documentTypes.id))
      .where(
        and(
          eq(customerDocuments.customerId, customerId),
          eq(customerDocuments.isCurrent, true)
        )
      )
      .orderBy(asc(documentTypes.name));

    return docs.map(d => ({ ...d.doc, documentType: d.docType }));
  }

  async getCustomerDocumentHistory(customerId: number, documentTypeId: number): Promise<CustomerDocument[]> {
    return db
      .select()
      .from(customerDocuments)
      .where(
        and(
          eq(customerDocuments.customerId, customerId),
          eq(customerDocuments.documentTypeId, documentTypeId)
        )
      )
      .orderBy(desc(customerDocuments.uploadedAt));
  }

  async getCustomerDocumentsDueSoon(leadTimeDays: number = 30): Promise<(CustomerDocument & { documentType: DocumentType; customer: { id: number; name: string } })[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + leadTimeDays);
    const futureDateStr = formatDateISO(futureDate);

    const docs = await db
      .select({
        doc: customerDocuments,
        docType: documentTypes,
        customer: {
          id: customers.id,
          name: customers.name,
        },
      })
      .from(customerDocuments)
      .innerJoin(documentTypes, eq(customerDocuments.documentTypeId, documentTypes.id))
      .innerJoin(customers, eq(customerDocuments.customerId, customers.id))
      .where(
        and(
          eq(customerDocuments.isCurrent, true),
          lte(customerDocuments.reviewDueDate, futureDateStr),
          sql`${customerDocuments.reviewDueDate} IS NOT NULL`
        )
      )
      .orderBy(asc(customerDocuments.reviewDueDate));

    return docs.map(d => ({ ...d.doc, documentType: d.docType, customer: d.customer }));
  }
}

export const documentStorage = new DocumentStorage();
