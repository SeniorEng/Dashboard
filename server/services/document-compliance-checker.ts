import { db } from "../lib/db";
import { employeeDocumentProofs, users, userRoles, documentTypes as documentTypesTable } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { evaluateTriggersForEmployee } from "./document-trigger-engine";

interface EmployeeForCompliance {
  id: number;
  roles: string[];
  employmentType?: string;
  haustierAkzeptiert?: boolean;
}

export async function syncRequirementsForEmployee(employee: EmployeeForCompliance): Promise<{ created: number; existing: number }> {
  const requirements = await evaluateTriggersForEmployee({
    roles: employee.roles,
    employmentType: employee.employmentType,
    haustierAkzeptiert: employee.haustierAkzeptiert,
  });

  const existingProofs = await db
    .select()
    .from(employeeDocumentProofs)
    .where(and(
      eq(employeeDocumentProofs.employeeId, employee.id),
      isNull(employeeDocumentProofs.deletedAt),
    ));

  const existingDocTypeIds = new Set(existingProofs.map(p => p.documentTypeId));
  let created = 0;

  for (const req of requirements) {
    if (!existingDocTypeIds.has(req.documentType.id)) {
      await db.insert(employeeDocumentProofs).values({
        employeeId: employee.id,
        documentTypeId: req.documentType.id,
        qualificationId: null,
        status: "pending",
      }).onConflictDoNothing();
      created++;
    }
  }

  return { created, existing: existingProofs.length };
}

export async function syncRequirementsForAllEmployees(): Promise<{ totalCreated: number; employeesProcessed: number }> {
  const employees = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.isAdmin, false),
      isNull(users.deactivatedAt),
    ));

  let totalCreated = 0;
  for (const emp of employees) {
    const roles = await db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, emp.id));
    const result = await syncRequirementsForEmployee({
      id: emp.id,
      roles: roles.map(r => r.role),
    });
    totalCreated += result.created;
  }

  return { totalCreated, employeesProcessed: employees.length };
}

export async function checkExpiringDocuments(): Promise<{ warnings: number; expired: number }> {
  const proofs = await db
    .select()
    .from(employeeDocumentProofs)
    .where(and(
      eq(employeeDocumentProofs.status, "approved"),
      isNull(employeeDocumentProofs.deletedAt),
    ));

  const docTypes = await db
    .select()
    .from(documentTypesTable)
    .where(eq(documentTypesTable.isActive, true));

  const docTypeMap = new Map(docTypes.map(dt => [dt.id, dt]));
  let warnings = 0;
  let expired = 0;
  const now = new Date();

  for (const proof of proofs) {
    const dt = docTypeMap.get(proof.documentTypeId);
    if (!dt?.renewalDays || !proof.uploadedAt) continue;

    const uploadDate = new Date(proof.uploadedAt);
    const expiryDate = new Date(uploadDate.getTime() + dt.renewalDays * 24 * 60 * 60 * 1000);
    const leadTimeDays = dt.reminderLeadTimeDays ?? 30;
    const warningDate = new Date(expiryDate.getTime() - leadTimeDays * 24 * 60 * 60 * 1000);

    if (now >= expiryDate) {
      const existing = await db
        .select()
        .from(employeeDocumentProofs)
        .where(and(
          eq(employeeDocumentProofs.employeeId, proof.employeeId),
          eq(employeeDocumentProofs.documentTypeId, proof.documentTypeId),
          eq(employeeDocumentProofs.status, "pending"),
          isNull(employeeDocumentProofs.deletedAt),
        ));

      if (existing.length === 0) {
        await db.insert(employeeDocumentProofs).values({
          employeeId: proof.employeeId,
          documentTypeId: proof.documentTypeId,
          qualificationId: null,
          status: "pending",
        }).onConflictDoNothing();
        expired++;
      }
    } else if (now >= warningDate) {
      warnings++;
    }
  }

  return { warnings, expired };
}
