import { eq, and, desc, asc, lte, sql, isNull } from "drizzle-orm";
import { formatDateISO } from "@shared/utils/datetime";
import {
  documentTypes,
  employeeDocuments,
  customerDocuments,
  customers,
  documentTemplates,
  documentTemplateBillingTypes,
  generatedDocuments,
  documentSigningTokens,
  type DocumentType,
  type InsertDocumentType,
  type UpdateDocumentType,
  type EmployeeDocument,
  type InsertEmployeeDocument,
  type CustomerDocument,
  type InsertCustomerDocument,
  type DocumentTemplate,
  type InsertDocumentTemplate,
  type UpdateDocumentTemplate,
  type DocumentTemplateBillingType,
  type GeneratedDocument,
  type InsertGeneratedDocument,
  type DocumentSigningToken,
} from "@shared/schema";
import { db } from "../lib/db";

export interface DocumentBatch {
  batchId: string;
  batchLabel: string | null;
  uploadedAt: string;
  files: (EmployeeDocument | CustomerDocument)[];
}

export interface GroupedDocumentsByType {
  documentType: DocumentType;
  currentBatches: DocumentBatch[];
  archivedBatches: DocumentBatch[];
}

export interface IDocumentStorage {
  getDocumentTypes(activeOnly?: boolean, targetType?: string): Promise<DocumentType[]>;
  getDocumentType(id: number): Promise<DocumentType | null>;
  createDocumentType(data: InsertDocumentType): Promise<DocumentType>;
  updateDocumentType(id: number, data: UpdateDocumentType): Promise<DocumentType | null>;

  uploadDocument(data: InsertEmployeeDocument, uploadedByUserId: number, options?: { skipDeactivation?: boolean; batchId?: string; batchLabel?: string }): Promise<EmployeeDocument>;
  getCurrentDocuments(employeeId: number): Promise<(EmployeeDocument & { documentType: DocumentType })[]>;
  getGroupedDocuments(employeeId: number): Promise<GroupedDocumentsByType[]>;
  getDocumentHistory(employeeId: number, documentTypeId: number): Promise<EmployeeDocument[]>;
  getEmployeeDocumentsDueSoon(leadTimeDays?: number): Promise<(EmployeeDocument & { documentType: DocumentType; employee: { id: number; displayName: string } })[]>;

  uploadCustomerDocument(data: InsertCustomerDocument, uploadedByUserId: number, options?: { skipDeactivation?: boolean; batchId?: string; batchLabel?: string }): Promise<CustomerDocument>;
  getCurrentCustomerDocuments(customerId: number): Promise<(CustomerDocument & { documentType: DocumentType })[]>;
  getGroupedCustomerDocuments(customerId: number): Promise<GroupedDocumentsByType[]>;
  getCustomerDocumentHistory(customerId: number, documentTypeId: number): Promise<CustomerDocument[]>;
  getCustomerDocumentsDueSoon(leadTimeDays?: number): Promise<(CustomerDocument & { documentType: DocumentType; customer: { id: number; name: string } })[]>;

  softDeleteDocument(documentId: number): Promise<void>;
  softDeleteBatch(batchId: string): Promise<number>;
  softDeleteCustomerDocument(documentId: number): Promise<void>;
  softDeleteCustomerBatch(batchId: string): Promise<number>;
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

  async getDocumentTypesWithTemplateInfo(activeOnly = true, targetType?: string): Promise<(DocumentType & { hasTemplate: boolean; templateName: string | null; templateSlug: string | null })[]> {
    const types = await this.getDocumentTypes(activeOnly, targetType);
    if (types.length === 0) return [];

    const typeIds = types.map(t => t.id);
    const templates = await db
      .select({
        documentTypeId: documentTemplates.documentTypeId,
        name: documentTemplates.name,
        slug: documentTemplates.slug,
      })
      .from(documentTemplates)
      .where(and(
        sql`${documentTemplates.documentTypeId} IN (${sql.join(typeIds.map(id => sql`${id}`), sql`, `)})`,
        eq(documentTemplates.isActive, true)
      ));

    const templateMap = new Map<number, { name: string; slug: string }>();
    for (const t of templates) {
      if (t.documentTypeId != null) {
        templateMap.set(t.documentTypeId, { name: t.name, slug: t.slug });
      }
    }

    return types.map(dt => ({
      ...dt,
      hasTemplate: templateMap.has(dt.id),
      templateName: templateMap.get(dt.id)?.name || null,
      templateSlug: templateMap.get(dt.id)?.slug || null,
    }));
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
      context: data.context ?? "beide",
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

  async uploadDocument(data: InsertEmployeeDocument, uploadedByUserId: number, options?: { skipDeactivation?: boolean; batchId?: string; batchLabel?: string }): Promise<EmployeeDocument> {
    const reviewDueDate = await this.calculateReviewDueDate(data.documentTypeId);

    return db.transaction(async (tx) => {
      if (!options?.skipDeactivation) {
        await tx
          .update(employeeDocuments)
          .set({ isCurrent: false })
          .where(
            and(
              eq(employeeDocuments.employeeId, data.employeeId),
              eq(employeeDocuments.documentTypeId, data.documentTypeId),
              eq(employeeDocuments.isCurrent, true),
              isNull(employeeDocuments.deletedAt)
            )
          );
      }

      const [result] = await tx.insert(employeeDocuments).values({
        employeeId: data.employeeId,
        documentTypeId: data.documentTypeId,
        fileName: data.fileName,
        objectPath: data.objectPath,
        uploadedByUserId,
        reviewDueDate,
        isCurrent: true,
        notes: data.notes || null,
        ...(options?.batchId ? { batchId: options.batchId } : {}),
        ...(options?.batchLabel !== undefined ? { batchLabel: options.batchLabel || null } : {}),
      }).returning();

      return result;
    });
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
          eq(employeeDocuments.isCurrent, true),
          isNull(employeeDocuments.deletedAt)
        )
      )
      .orderBy(asc(documentTypes.name));

    return docs.map(d => ({ ...d.doc, documentType: d.docType }));
  }

  async getGroupedDocuments(employeeId: number): Promise<GroupedDocumentsByType[]> {
    const docs = await db
      .select({
        doc: employeeDocuments,
        docType: documentTypes,
      })
      .from(employeeDocuments)
      .innerJoin(documentTypes, eq(employeeDocuments.documentTypeId, documentTypes.id))
      .where(and(eq(employeeDocuments.employeeId, employeeId), isNull(employeeDocuments.deletedAt)))
      .orderBy(asc(documentTypes.name), desc(employeeDocuments.uploadedAt));

    const typeMap = new Map<number, { documentType: DocumentType; docs: EmployeeDocument[] }>();
    for (const d of docs) {
      if (!typeMap.has(d.docType.id)) {
        typeMap.set(d.docType.id, { documentType: d.docType, docs: [] });
      }
      typeMap.get(d.docType.id)!.docs.push(d.doc);
    }

    const result: GroupedDocumentsByType[] = [];
    for (const entry of Array.from(typeMap.values())) {
      const { documentType, docs: typeDocs } = entry;
      const batchMap = new Map<string, { batchLabel: string | null; uploadedAt: string; files: EmployeeDocument[] }>();
      for (const doc of typeDocs) {
        if (!batchMap.has(doc.batchId)) {
          batchMap.set(doc.batchId, { batchLabel: doc.batchLabel, uploadedAt: doc.uploadedAt as unknown as string, files: [] });
        }
        batchMap.get(doc.batchId)!.files.push(doc);
      }

      const currentBatches: DocumentBatch[] = [];
      const archivedBatches: DocumentBatch[] = [];
      for (const [batchId, batch] of Array.from(batchMap.entries())) {
        const batchObj: DocumentBatch = { batchId, batchLabel: batch.batchLabel, uploadedAt: batch.uploadedAt, files: batch.files };
        if (batch.files.some((f: EmployeeDocument) => f.isCurrent)) {
          currentBatches.push(batchObj);
        } else {
          archivedBatches.push(batchObj);
        }
      }

      result.push({ documentType, currentBatches, archivedBatches });
    }

    return result;
  }

  async getDocumentHistory(employeeId: number, documentTypeId: number): Promise<EmployeeDocument[]> {
    return db
      .select()
      .from(employeeDocuments)
      .where(
        and(
          eq(employeeDocuments.employeeId, employeeId),
          eq(employeeDocuments.documentTypeId, documentTypeId),
          isNull(employeeDocuments.deletedAt)
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
          sql`${employeeDocuments.reviewDueDate} IS NOT NULL`,
          isNull(employeeDocuments.deletedAt)
        )
      )
      .orderBy(asc(employeeDocuments.reviewDueDate));

    return docs.map(d => ({ ...d.doc, documentType: d.docType, employee: d.employee }));
  }

  async uploadCustomerDocument(data: InsertCustomerDocument, uploadedByUserId: number, options?: { skipDeactivation?: boolean; batchId?: string; batchLabel?: string }): Promise<CustomerDocument> {
    const reviewDueDate = await this.calculateReviewDueDate(data.documentTypeId);

    return db.transaction(async (tx) => {
      if (!options?.skipDeactivation) {
        await tx
          .update(customerDocuments)
          .set({ isCurrent: false })
          .where(
            and(
              eq(customerDocuments.customerId, data.customerId),
              eq(customerDocuments.documentTypeId, data.documentTypeId),
              eq(customerDocuments.isCurrent, true),
              isNull(customerDocuments.deletedAt)
            )
          );
      }

      const [result] = await tx.insert(customerDocuments).values({
        customerId: data.customerId,
        documentTypeId: data.documentTypeId,
        fileName: data.fileName,
        objectPath: data.objectPath,
        uploadedByUserId,
        reviewDueDate,
        isCurrent: true,
        notes: data.notes || null,
        ...(options?.batchId ? { batchId: options.batchId } : {}),
        ...(options?.batchLabel !== undefined ? { batchLabel: options.batchLabel || null } : {}),
      }).returning();

      return result;
    });
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
          eq(customerDocuments.isCurrent, true),
          isNull(customerDocuments.deletedAt)
        )
      )
      .orderBy(asc(documentTypes.name));

    return docs.map(d => ({ ...d.doc, documentType: d.docType }));
  }

  async getGroupedCustomerDocuments(customerId: number): Promise<GroupedDocumentsByType[]> {
    const docs = await db
      .select({
        doc: customerDocuments,
        docType: documentTypes,
      })
      .from(customerDocuments)
      .innerJoin(documentTypes, eq(customerDocuments.documentTypeId, documentTypes.id))
      .where(and(eq(customerDocuments.customerId, customerId), isNull(customerDocuments.deletedAt)))
      .orderBy(asc(documentTypes.name), desc(customerDocuments.uploadedAt));

    const typeMap = new Map<number, { documentType: DocumentType; docs: CustomerDocument[] }>();
    for (const d of docs) {
      if (!typeMap.has(d.docType.id)) {
        typeMap.set(d.docType.id, { documentType: d.docType, docs: [] });
      }
      typeMap.get(d.docType.id)!.docs.push(d.doc);
    }

    const result: GroupedDocumentsByType[] = [];
    for (const entry of Array.from(typeMap.values())) {
      const { documentType, docs: typeDocs } = entry;
      const batchMap = new Map<string, { batchLabel: string | null; uploadedAt: string; files: CustomerDocument[] }>();
      for (const doc of typeDocs) {
        if (!batchMap.has(doc.batchId)) {
          batchMap.set(doc.batchId, { batchLabel: doc.batchLabel, uploadedAt: doc.uploadedAt as unknown as string, files: [] });
        }
        batchMap.get(doc.batchId)!.files.push(doc);
      }

      const currentBatches: DocumentBatch[] = [];
      const archivedBatches: DocumentBatch[] = [];
      for (const [batchId, batch] of Array.from(batchMap.entries())) {
        const batchObj: DocumentBatch = { batchId, batchLabel: batch.batchLabel, uploadedAt: batch.uploadedAt, files: batch.files };
        if (batch.files.some((f: CustomerDocument) => f.isCurrent)) {
          currentBatches.push(batchObj);
        } else {
          archivedBatches.push(batchObj);
        }
      }

      result.push({ documentType, currentBatches, archivedBatches });
    }

    return result;
  }

  async getCustomerDocumentHistory(customerId: number, documentTypeId: number): Promise<CustomerDocument[]> {
    return db
      .select()
      .from(customerDocuments)
      .where(
        and(
          eq(customerDocuments.customerId, customerId),
          eq(customerDocuments.documentTypeId, documentTypeId),
          isNull(customerDocuments.deletedAt)
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
          sql`${customerDocuments.reviewDueDate} IS NOT NULL`,
          isNull(customerDocuments.deletedAt)
        )
      )
      .orderBy(asc(customerDocuments.reviewDueDate));

    return docs.map(d => ({ ...d.doc, documentType: d.docType, customer: d.customer }));
  }

  async softDeleteDocument(documentId: number): Promise<void> {
    await db
      .update(employeeDocuments)
      .set({ deletedAt: new Date() })
      .where(and(eq(employeeDocuments.id, documentId), isNull(employeeDocuments.deletedAt)));
  }

  async softDeleteBatch(batchId: string): Promise<number> {
    const result = await db
      .update(employeeDocuments)
      .set({ deletedAt: new Date() })
      .where(and(eq(employeeDocuments.batchId, batchId), isNull(employeeDocuments.deletedAt)))
      .returning({ id: employeeDocuments.id });
    return result.length;
  }

  async softDeleteCustomerDocument(documentId: number): Promise<void> {
    await db
      .update(customerDocuments)
      .set({ deletedAt: new Date() })
      .where(and(eq(customerDocuments.id, documentId), isNull(customerDocuments.deletedAt)));
  }

  async softDeleteCustomerBatch(batchId: string): Promise<number> {
    const result = await db
      .update(customerDocuments)
      .set({ deletedAt: new Date() })
      .where(and(eq(customerDocuments.batchId, batchId), isNull(customerDocuments.deletedAt)))
      .returning({ id: customerDocuments.id });
    return result.length;
  }
  async getDocumentTemplates(activeOnly = true): Promise<DocumentTemplate[]> {
    const conditions = [];
    if (activeOnly) conditions.push(eq(documentTemplates.isActive, true));

    if (conditions.length > 0) {
      return db.select().from(documentTemplates).where(and(...conditions)).orderBy(asc(documentTemplates.name));
    }
    return db.select().from(documentTemplates).orderBy(asc(documentTemplates.name));
  }

  async getDocumentTemplate(id: number): Promise<DocumentTemplate | null> {
    const result = await db.select().from(documentTemplates).where(eq(documentTemplates.id, id)).limit(1);
    return result[0] || null;
  }

  async getDocumentTemplateBySlug(slug: string): Promise<DocumentTemplate | null> {
    const result = await db.select().from(documentTemplates).where(eq(documentTemplates.slug, slug)).limit(1);
    return result[0] || null;
  }

  async getTemplatesForBillingType(billingType: string): Promise<(DocumentTemplate & { requirement: string; sortOrder: number })[]> {
    const rows = await db
      .select({
        template: documentTemplates,
        requirement: documentTemplateBillingTypes.requirement,
        sortOrder: documentTemplateBillingTypes.sortOrder,
      })
      .from(documentTemplateBillingTypes)
      .innerJoin(documentTemplates, eq(documentTemplateBillingTypes.templateId, documentTemplates.id))
      .where(
        and(
          eq(documentTemplateBillingTypes.billingType, billingType),
          eq(documentTemplates.isActive, true)
        )
      )
      .orderBy(asc(documentTemplateBillingTypes.sortOrder));

    return rows.map(r => ({
      ...r.template,
      requirement: r.requirement,
      sortOrder: r.sortOrder,
    }));
  }

  async createDocumentTemplate(data: InsertDocumentTemplate): Promise<DocumentTemplate> {
    const [result] = await db.insert(documentTemplates).values({
      slug: data.slug,
      name: data.name,
      description: data.description || null,
      htmlContent: data.htmlContent,
      isSystem: data.isSystem ?? false,
      isActive: data.isActive ?? true,
      documentTypeId: data.documentTypeId ?? null,
      context: data.context ?? "beide",
      targetType: data.targetType ?? "customer",
      requiresCustomerSignature: data.requiresCustomerSignature ?? true,
      requiresEmployeeSignature: data.requiresEmployeeSignature ?? true,
    }).returning();
    return result;
  }

  async updateDocumentTemplate(id: number, data: UpdateDocumentTemplate): Promise<DocumentTemplate | null> {
    const existing = await this.getDocumentTemplate(id);
    if (!existing) return null;

    const newVersion = data.htmlContent && data.htmlContent !== existing.htmlContent
      ? existing.version + 1
      : existing.version;

    const [result] = await db
      .update(documentTemplates)
      .set({ ...data, version: newVersion, updatedAt: new Date() })
      .where(eq(documentTemplates.id, id))
      .returning();
    return result || null;
  }

  async getGeneratedDocuments(customerId: number): Promise<(GeneratedDocument & { template: DocumentTemplate })[]> {
    const rows = await db
      .select({
        doc: generatedDocuments,
        template: documentTemplates,
      })
      .from(generatedDocuments)
      .innerJoin(documentTemplates, eq(generatedDocuments.templateId, documentTemplates.id))
      .where(eq(generatedDocuments.customerId, customerId))
      .orderBy(desc(generatedDocuments.generatedAt));

    return rows.map(r => ({ ...r.doc, template: r.template }));
  }

  async createGeneratedDocument(data: InsertGeneratedDocument, generatedByUserId: number): Promise<GeneratedDocument> {
    const [result] = await db.insert(generatedDocuments).values({
      customerId: data.customerId ?? null,
      employeeId: data.employeeId ?? null,
      templateId: data.templateId,
      templateVersion: data.templateVersion,
      documentTypeId: data.documentTypeId ?? null,
      fileName: data.fileName,
      objectPath: data.objectPath,
      renderedHtml: data.renderedHtml ?? null,
      customerSignatureData: data.customerSignatureData || null,
      employeeSignatureData: data.employeeSignatureData || null,
      signingStatus: data.signingStatus ?? "complete",
      integrityHash: data.integrityHash || null,
      signingIp: data.signingIp ?? null,
      signingLocation: data.signingLocation ?? null,
      generatedByUserId,
    }).returning();
    return result;
  }

  async getGeneratedDocumentsByEmployee(employeeId: number): Promise<(GeneratedDocument & { template: DocumentTemplate })[]> {
    const rows = await db
      .select({
        doc: generatedDocuments,
        template: documentTemplates,
      })
      .from(generatedDocuments)
      .innerJoin(documentTemplates, eq(generatedDocuments.templateId, documentTemplates.id))
      .where(eq(generatedDocuments.employeeId, employeeId))
      .orderBy(desc(generatedDocuments.generatedAt));

    return rows.map(r => ({ ...r.doc, template: r.template }));
  }

  async getGeneratedDocument(id: number): Promise<GeneratedDocument | null> {
    const result = await db.select().from(generatedDocuments).where(eq(generatedDocuments.id, id)).limit(1);
    return result[0] || null;
  }

  async getTemplatesByContext(context: string, targetType: string): Promise<DocumentTemplate[]> {
    const conditions = [
      eq(documentTemplates.isActive, true),
    ];
    if (context !== "alle") {
      conditions.push(sql`${documentTemplates.context} IN (${context}, 'beide')`);
    }
    if (targetType !== "beide") {
      conditions.push(sql`${documentTemplates.targetType} IN (${targetType}, 'beide')`);
    }
    return db.select().from(documentTemplates).where(and(...conditions)).orderBy(asc(documentTemplates.name));
  }

  async updateGeneratedDocumentSignature(
    id: number,
    customerSignatureData: string | null,
    employeeSignatureData: string | null,
    signedByEmployeeId: number,
    integrityHash: string
  ): Promise<GeneratedDocument | null> {
    const [result] = await db
      .update(generatedDocuments)
      .set({
        customerSignatureData,
        employeeSignatureData,
        signedAt: new Date(),
        signedByEmployeeId,
        integrityHash,
      })
      .where(eq(generatedDocuments.id, id))
      .returning();
    return result || null;
  }

  async getTemplateBillingTypes(templateId: number): Promise<DocumentTemplateBillingType[]> {
    return db
      .select()
      .from(documentTemplateBillingTypes)
      .where(eq(documentTemplateBillingTypes.templateId, templateId))
      .orderBy(asc(documentTemplateBillingTypes.sortOrder));
  }

  async getAllTemplateBillingTypes(): Promise<DocumentTemplateBillingType[]> {
    return db
      .select()
      .from(documentTemplateBillingTypes)
      .orderBy(asc(documentTemplateBillingTypes.templateId), asc(documentTemplateBillingTypes.sortOrder));
  }

  async setTemplateBillingTypes(
    templateId: number,
    assignments: { billingType: string; requirement: string; sortOrder: number }[]
  ): Promise<DocumentTemplateBillingType[]> {
    return db.transaction(async (tx) => {
      await tx
        .delete(documentTemplateBillingTypes)
        .where(eq(documentTemplateBillingTypes.templateId, templateId));

      if (assignments.length === 0) return [];

      const rows = await tx
        .insert(documentTemplateBillingTypes)
        .values(assignments.map(a => ({ templateId, ...a })))
        .returning();

      return rows;
    });
  }

  async createSigningToken(documentId: number, tokenHash: string, expiresAt: Date): Promise<DocumentSigningToken> {
    const [result] = await db.insert(documentSigningTokens).values({
      documentId,
      tokenHash,
      expiresAt,
    }).returning();
    return result;
  }

  async getSigningTokenByHash(tokenHash: string): Promise<(DocumentSigningToken & { document: GeneratedDocument }) | null> {
    const rows = await db
      .select({
        token: documentSigningTokens,
        document: generatedDocuments,
      })
      .from(documentSigningTokens)
      .innerJoin(generatedDocuments, eq(documentSigningTokens.documentId, generatedDocuments.id))
      .where(eq(documentSigningTokens.tokenHash, tokenHash))
      .limit(1);

    if (rows.length === 0) return null;
    return { ...rows[0].token, document: rows[0].document };
  }

  async markSigningTokenUsed(id: number): Promise<boolean> {
    const [result] = await db
      .update(documentSigningTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(documentSigningTokens.id, id), isNull(documentSigningTokens.usedAt)))
      .returning();
    return !!result;
  }

  async updateGeneratedDocumentAfterSigning(
    id: number,
    employeeSignatureData: string,
    integrityHash: string,
    objectPath: string,
    fileName: string,
    signingIp?: string | null,
    signingLocation?: string | null,
  ): Promise<GeneratedDocument | null> {
    const [result] = await db
      .update(generatedDocuments)
      .set({
        employeeSignatureData,
        signingStatus: "complete",
        signedAt: new Date(),
        integrityHash,
        objectPath,
        fileName,
        ...(signingIp ? { signingIp } : {}),
        ...(signingLocation ? { signingLocation } : {}),
      })
      .where(eq(generatedDocuments.id, id))
      .returning();
    return result || null;
  }

  async ensureCustomerDocumentTypes(): Promise<void> {
    const existing = await this.getDocumentTypes(false, "customer");
    const existingNames = new Set(existing.map(t => t.name));

    const defaultTypes = [
      { name: "Schlüsselübergabeprotokoll", description: "Protokoll über die Übergabe von Schlüsseln an den Pflegedienst", targetType: "customer" as const, context: "beide" as const },
      { name: "Vollmacht", description: "Vollmacht des Kunden für den Pflegedienst", targetType: "customer" as const, context: "beide" as const },
      { name: "Einwilligungserklärung", description: "Einwilligung des Kunden zu bestimmten Maßnahmen", targetType: "customer" as const, context: "beide" as const },
      { name: "Sonstiges Dokument", description: "Allgemeines Dokument ohne spezifische Kategorie", targetType: "customer" as const, context: "beide" as const },
      { name: "Ärztliche Verordnung", description: "Verordnung oder Bescheinigung vom Arzt", targetType: "customer" as const, context: "bestandskunde" as const },
      { name: "Pflegegradbescheid", description: "Bescheid über den zugewiesenen Pflegegrad", targetType: "customer" as const, context: "bestandskunde" as const },
    ];

    for (const dt of defaultTypes) {
      if (!existingNames.has(dt.name)) {
        await this.createDocumentType({ ...dt, isActive: true, reminderLeadTimeDays: 30 });
      }
    }
  }

  async ensureTemplateBillingTypes(): Promise<void> {
    const existing = await db.select().from(documentTemplateBillingTypes);
    if (existing.length > 0) return;

    const templates = await this.getDocumentTemplates(false);
    const slugToId: Record<string, number> = {};
    for (const t of templates) {
      slugToId[t.slug] = t.id;
    }

    const mappings: { templateId: number; billingType: string; requirement: string; sortOrder: number }[] = [];

    const addMapping = (slug: string, billingType: string, requirement: string, sortOrder: number) => {
      if (slugToId[slug]) {
        mappings.push({ templateId: slugToId[slug], billingType, requirement, sortOrder });
      }
    };

    addMapping("betreuungsvertrag_pflegekasse", "pflegekasse_gesetzlich", "pflicht", 1);
    addMapping("datenschutzvereinbarung", "pflegekasse_gesetzlich", "pflicht", 2);
    addMapping("forderungsabtretung", "pflegekasse_gesetzlich", "pflicht", 3);

    addMapping("betreuungsvertrag_pflegekasse", "pflegekasse_privat", "pflicht", 1);
    addMapping("datenschutzvereinbarung", "pflegekasse_privat", "pflicht", 2);
    addMapping("sepa_lastschriftmandat", "pflegekasse_privat", "optional", 3);

    addMapping("dienstleistungsvertrag_selbstzahler", "selbstzahler", "pflicht", 1);
    addMapping("datenschutzvereinbarung", "selbstzahler", "pflicht", 2);
    addMapping("sepa_lastschriftmandat", "selbstzahler", "optional", 3);

    if (mappings.length > 0) {
      await db.insert(documentTemplateBillingTypes).values(mappings);
    }
  }
}

export const documentStorage = new DocumentStorage();
