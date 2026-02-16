import { documentStorage } from "../storage/documents";
import { createTask } from "../storage/tasks";
import { tasks, users, systemSettings } from "@shared/schema";
import { db } from "../lib/db";
import { eq, and, like } from "drizzle-orm";

const TASK_PREFIX = "[Dokument]";
const REVIEW_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function shouldRunDocumentReview(): Promise<boolean> {
  const settings = await db.select({ lastRun: systemSettings.lastDocumentReviewAt }).from(systemSettings).limit(1);
  if (!settings[0]?.lastRun) return true;
  return Date.now() - new Date(settings[0].lastRun).getTime() >= REVIEW_INTERVAL_MS;
}

async function updateLastRunTimestamp(): Promise<void> {
  const existing = await db.select({ id: systemSettings.id }).from(systemSettings).limit(1);
  if (existing.length > 0) {
    await db.update(systemSettings).set({ lastDocumentReviewAt: new Date() }).where(eq(systemSettings.id, existing[0].id));
  }
}

async function getFirstAdminId(): Promise<number | null> {
  const adminUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.isActive, true)))
    .limit(1);
  return adminUsers[0]?.id ?? null;
}

export async function generateDocumentReviewTasks(): Promise<number> {
  let tasksCreated = 0;

  const adminId = await getFirstAdminId();
  if (!adminId) {
    console.warn("Document review: No active admin user found, skipping task generation");
    return 0;
  }

  const [employeeDocs, customerDocs] = await Promise.all([
    documentStorage.getEmployeeDocumentsDueSoon(90),
    documentStorage.getCustomerDocumentsDueSoon(90),
  ]);

  for (const doc of employeeDocs) {
    const adminTitle = `${TASK_PREFIX} ${doc.documentType.name} von ${doc.employee.displayName} prüfen`;
    const employeeTitle = `${TASK_PREFIX} ${doc.documentType.name} erneut einreichen`;

    const existingAdmin = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          like(tasks.title, `${TASK_PREFIX} ${doc.documentType.name} von ${doc.employee.displayName}%`),
          eq(tasks.status, "open"),
          eq(tasks.assignedToUserId, adminId)
        )
      )
      .limit(1);

    if (existingAdmin.length === 0) {
      await createTask({
        title: adminTitle,
        description: `Das Dokument "${doc.documentType.name}" von ${doc.employee.displayName} muss bis zum ${doc.reviewDueDate} geprüft werden. Datei: ${doc.fileName}`,
        dueDate: doc.reviewDueDate,
        priority: "medium",
        assignedToUserId: adminId,
      }, adminId);
      tasksCreated++;
    }

    const existingForEmployee = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          like(tasks.title, `${TASK_PREFIX} ${doc.documentType.name} erneut%`),
          eq(tasks.assignedToUserId, doc.employeeId),
          eq(tasks.status, "open")
        )
      )
      .limit(1);

    if (existingForEmployee.length === 0) {
      await createTask({
        title: employeeTitle,
        description: `Bitte reichen Sie Ihr Dokument "${doc.documentType.name}" erneut ein. Fällig bis: ${doc.reviewDueDate}`,
        dueDate: doc.reviewDueDate,
        priority: "medium",
        assignedToUserId: doc.employeeId,
      }, adminId);
      tasksCreated++;
    }
  }

  for (const doc of customerDocs) {
    const adminTitle = `${TASK_PREFIX} ${doc.documentType.name} für ${doc.customer.name} prüfen`;

    const existingAdmin = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          like(tasks.title, `${TASK_PREFIX} ${doc.documentType.name} für ${doc.customer.name}%`),
          eq(tasks.status, "open"),
          eq(tasks.assignedToUserId, adminId)
        )
      )
      .limit(1);

    if (existingAdmin.length === 0) {
      await createTask({
        title: adminTitle,
        description: `Das Kundendokument "${doc.documentType.name}" für ${doc.customer.name} muss bis zum ${doc.reviewDueDate} geprüft werden. Datei: ${doc.fileName}`,
        dueDate: doc.reviewDueDate,
        priority: "medium",
        assignedToUserId: adminId,
      }, adminId);
      tasksCreated++;
    }
  }

  await updateLastRunTimestamp();
  return tasksCreated;
}
