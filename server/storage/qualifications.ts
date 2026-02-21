import { eq, and, asc, desc, inArray } from "drizzle-orm";
import {
  qualifications,
  qualificationDocuments,
  employeeQualifications,
  employeeDocumentProofs,
  documentTypes,
  users,
  type Qualification,
  type InsertQualification,
  type UpdateQualification,
  type QualificationDocument,
  type EmployeeQualification,
  type EmployeeDocumentProof,
} from "@shared/schema";
import { db } from "../lib/db";

export class QualificationStorage {
  async getQualifications(activeOnly = true): Promise<Qualification[]> {
    if (activeOnly) {
      return db.select().from(qualifications).where(eq(qualifications.isActive, true)).orderBy(asc(qualifications.name));
    }
    return db.select().from(qualifications).orderBy(asc(qualifications.name));
  }

  async getQualification(id: number): Promise<Qualification | null> {
    const result = await db.select().from(qualifications).where(eq(qualifications.id, id)).limit(1);
    return result[0] || null;
  }

  async createQualification(data: InsertQualification): Promise<Qualification> {
    const [result] = await db.insert(qualifications).values({
      name: data.name,
      description: data.description || null,
      isActive: data.isActive ?? true,
    }).returning();
    return result;
  }

  async updateQualification(id: number, data: UpdateQualification): Promise<Qualification | null> {
    const [result] = await db
      .update(qualifications)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(qualifications.id, id))
      .returning();
    return result || null;
  }

  async deleteQualification(id: number): Promise<boolean> {
    const result = await db.delete(qualifications).where(eq(qualifications.id, id)).returning();
    return result.length > 0;
  }

  async getQualificationDocuments(qualificationId: number): Promise<(QualificationDocument & { documentType: { id: number; name: string } })[]> {
    const results = await db
      .select({
        id: qualificationDocuments.id,
        qualificationId: qualificationDocuments.qualificationId,
        documentTypeId: qualificationDocuments.documentTypeId,
        isRequired: qualificationDocuments.isRequired,
        sortOrder: qualificationDocuments.sortOrder,
        documentType: {
          id: documentTypes.id,
          name: documentTypes.name,
        },
      })
      .from(qualificationDocuments)
      .innerJoin(documentTypes, eq(qualificationDocuments.documentTypeId, documentTypes.id))
      .where(eq(qualificationDocuments.qualificationId, qualificationId))
      .orderBy(asc(qualificationDocuments.sortOrder));
    return results;
  }

  async setQualificationDocuments(qualificationId: number, docTypeIds: number[]): Promise<void> {
    await db.delete(qualificationDocuments).where(eq(qualificationDocuments.qualificationId, qualificationId));
    if (docTypeIds.length > 0) {
      await db.insert(qualificationDocuments).values(
        docTypeIds.map((documentTypeId, index) => ({
          qualificationId,
          documentTypeId,
          sortOrder: index,
        }))
      );
    }
  }

  async getEmployeeQualifications(employeeId: number): Promise<(EmployeeQualification & { qualification: Qualification })[]> {
    const results = await db
      .select({
        id: employeeQualifications.id,
        employeeId: employeeQualifications.employeeId,
        qualificationId: employeeQualifications.qualificationId,
        assignedAt: employeeQualifications.assignedAt,
        assignedByUserId: employeeQualifications.assignedByUserId,
        qualification: qualifications,
      })
      .from(employeeQualifications)
      .innerJoin(qualifications, eq(employeeQualifications.qualificationId, qualifications.id))
      .where(eq(employeeQualifications.employeeId, employeeId))
      .orderBy(asc(qualifications.name));
    return results;
  }

  async assignQualification(employeeId: number, qualificationId: number, assignedByUserId: number): Promise<void> {
    await db.insert(employeeQualifications).values({
      employeeId,
      qualificationId,
      assignedByUserId,
    }).onConflictDoNothing();

    const requiredDocs = await db
      .select({ documentTypeId: qualificationDocuments.documentTypeId })
      .from(qualificationDocuments)
      .where(eq(qualificationDocuments.qualificationId, qualificationId));

    for (const doc of requiredDocs) {
      await db.insert(employeeDocumentProofs).values({
        employeeId,
        qualificationId,
        documentTypeId: doc.documentTypeId,
        status: "pending",
      }).onConflictDoNothing();
    }
  }

  async removeQualification(employeeId: number, qualificationId: number): Promise<void> {
    await db.delete(employeeQualifications).where(
      and(
        eq(employeeQualifications.employeeId, employeeId),
        eq(employeeQualifications.qualificationId, qualificationId)
      )
    );
    await db.delete(employeeDocumentProofs).where(
      and(
        eq(employeeDocumentProofs.employeeId, employeeId),
        eq(employeeDocumentProofs.qualificationId, qualificationId)
      )
    );
  }

  async getEmployeeProofs(employeeId: number): Promise<(EmployeeDocumentProof & { documentType: { id: number; name: string }; qualification: { id: number; name: string } })[]> {
    const results = await db
      .select({
        id: employeeDocumentProofs.id,
        employeeId: employeeDocumentProofs.employeeId,
        qualificationId: employeeDocumentProofs.qualificationId,
        documentTypeId: employeeDocumentProofs.documentTypeId,
        status: employeeDocumentProofs.status,
        fileName: employeeDocumentProofs.fileName,
        objectPath: employeeDocumentProofs.objectPath,
        uploadedAt: employeeDocumentProofs.uploadedAt,
        reviewedAt: employeeDocumentProofs.reviewedAt,
        reviewedByUserId: employeeDocumentProofs.reviewedByUserId,
        rejectionReason: employeeDocumentProofs.rejectionReason,
        createdAt: employeeDocumentProofs.createdAt,
        updatedAt: employeeDocumentProofs.updatedAt,
        documentType: {
          id: documentTypes.id,
          name: documentTypes.name,
        },
        qualification: {
          id: qualifications.id,
          name: qualifications.name,
        },
      })
      .from(employeeDocumentProofs)
      .innerJoin(documentTypes, eq(employeeDocumentProofs.documentTypeId, documentTypes.id))
      .innerJoin(qualifications, eq(employeeDocumentProofs.qualificationId, qualifications.id))
      .where(eq(employeeDocumentProofs.employeeId, employeeId))
      .orderBy(asc(qualifications.name), asc(documentTypes.name));
    return results;
  }

  async uploadProof(proofId: number, fileName: string, objectPath: string): Promise<EmployeeDocumentProof | null> {
    const [result] = await db
      .update(employeeDocumentProofs)
      .set({
        status: "uploaded",
        fileName,
        objectPath,
        uploadedAt: new Date(),
        rejectionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(employeeDocumentProofs.id, proofId))
      .returning();
    return result || null;
  }

  async reviewProof(proofId: number, approved: boolean, reviewedByUserId: number, rejectionReason?: string): Promise<EmployeeDocumentProof | null> {
    const [result] = await db
      .update(employeeDocumentProofs)
      .set({
        status: approved ? "approved" : "rejected",
        reviewedAt: new Date(),
        reviewedByUserId,
        rejectionReason: approved ? null : (rejectionReason || null),
        updatedAt: new Date(),
      })
      .where(eq(employeeDocumentProofs.id, proofId))
      .returning();
    return result || null;
  }

  async getPendingReviewProofs(): Promise<(EmployeeDocumentProof & { documentType: { id: number; name: string }; qualification: { id: number; name: string }; employee: { id: number; displayName: string } })[]> {
    const results = await db
      .select({
        id: employeeDocumentProofs.id,
        employeeId: employeeDocumentProofs.employeeId,
        qualificationId: employeeDocumentProofs.qualificationId,
        documentTypeId: employeeDocumentProofs.documentTypeId,
        status: employeeDocumentProofs.status,
        fileName: employeeDocumentProofs.fileName,
        objectPath: employeeDocumentProofs.objectPath,
        uploadedAt: employeeDocumentProofs.uploadedAt,
        reviewedAt: employeeDocumentProofs.reviewedAt,
        reviewedByUserId: employeeDocumentProofs.reviewedByUserId,
        rejectionReason: employeeDocumentProofs.rejectionReason,
        createdAt: employeeDocumentProofs.createdAt,
        updatedAt: employeeDocumentProofs.updatedAt,
        documentType: {
          id: documentTypes.id,
          name: documentTypes.name,
        },
        qualification: {
          id: qualifications.id,
          name: qualifications.name,
        },
        employee: {
          id: users.id,
          displayName: users.displayName,
        },
      })
      .from(employeeDocumentProofs)
      .innerJoin(documentTypes, eq(employeeDocumentProofs.documentTypeId, documentTypes.id))
      .innerJoin(qualifications, eq(employeeDocumentProofs.qualificationId, qualifications.id))
      .innerJoin(users, eq(employeeDocumentProofs.employeeId, users.id))
      .where(eq(employeeDocumentProofs.status, "uploaded"))
      .orderBy(desc(employeeDocumentProofs.uploadedAt));
    return results;
  }

  async getProofById(id: number): Promise<EmployeeDocumentProof | null> {
    const result = await db.select().from(employeeDocumentProofs).where(eq(employeeDocumentProofs.id, id)).limit(1);
    return result[0] || null;
  }

  async getPendingProofCount(employeeId: number): Promise<number> {
    const results = await db
      .select({ id: employeeDocumentProofs.id })
      .from(employeeDocumentProofs)
      .where(and(
        eq(employeeDocumentProofs.employeeId, employeeId),
        inArray(employeeDocumentProofs.status, ["pending", "rejected"])
      ));
    return results.length;
  }

  async getUploadedProofCountForAdmin(): Promise<number> {
    const results = await db
      .select({ id: employeeDocumentProofs.id })
      .from(employeeDocumentProofs)
      .where(eq(employeeDocumentProofs.status, "uploaded"));
    return results.length;
  }
}

export const qualificationStorage = new QualificationStorage();
