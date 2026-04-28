import { tasks, users, customers, Task, InsertTask, UpdateTask } from "@shared/schema";
import { eq, and, desc, asc, ne, sql as sqlBuilder, inArray, count, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type DbOrTx } from "../lib/db";
import { parseLocalDate } from "@shared/utils/datetime";

const creatorUsers = alias(users, "creator_users");
const assigneeUsers = alias(users, "assignee_users");

export interface TaskWithRelations extends Task {
  createdBy: { id: number; displayName: string } | null;
  assignedTo: { id: number; displayName: string } | null;
  customer: { id: number; name: string } | null;
}

async function enrichTasksWithRelations(taskRows: Task[]): Promise<TaskWithRelations[]> {
  if (taskRows.length === 0) return [];

  const userIds = new Set<number>();
  const customerIds = new Set<number>();

  for (const task of taskRows) {
    userIds.add(task.createdByUserId);
    userIds.add(task.assignedToUserId);
    if (task.customerId) customerIds.add(task.customerId);
  }

  const usersData = userIds.size > 0 
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, Array.from(userIds)))
    : [];

  const customersData = customerIds.size > 0
    ? await db
        .select({ id: customers.id, vorname: customers.vorname, nachname: customers.nachname })
        .from(customers)
        .where(inArray(customers.id, Array.from(customerIds)))
    : [];

  const userMap = new Map(usersData.map(u => [u.id, u]));
  const customerMap = new Map(customersData.map(c => [c.id, c]));

  return taskRows.map(task => {
    const createdByUser = userMap.get(task.createdByUserId);
    const assignedToUser = userMap.get(task.assignedToUserId);
    const customerData = task.customerId ? customerMap.get(task.customerId) : null;

    return {
      ...task,
      createdBy: createdByUser ? { id: createdByUser.id, displayName: createdByUser.displayName } : null,
      assignedTo: assignedToUser ? { id: assignedToUser.id, displayName: assignedToUser.displayName } : null,
      customer: customerData ? { id: customerData.id, name: `${customerData.vorname} ${customerData.nachname}` } : null,
    };
  });
}

async function queryTasks(extraConditions: ReturnType<typeof eq>[] = []): Promise<TaskWithRelations[]> {
  const conditions = [isNull(tasks.deletedAt), ...extraConditions];

  const result = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(
      asc(tasks.status),
      asc(sqlBuilder`CASE WHEN ${tasks.priority} = 'high' THEN 1 WHEN ${tasks.priority} = 'medium' THEN 2 ELSE 3 END`),
      asc(tasks.dueDate)
    );

  return enrichTasksWithRelations(result);
}

export async function getTasksForUser(userId: number, includeCompleted: boolean = false): Promise<TaskWithRelations[]> {
  const extra: ReturnType<typeof eq>[] = [eq(tasks.assignedToUserId, userId)];
  if (!includeCompleted) extra.push(ne(tasks.status, "completed"));
  return queryTasks(extra);
}

export async function getAllTasks(includeCompleted: boolean = false): Promise<TaskWithRelations[]> {
  const extra: ReturnType<typeof eq>[] = [];
  if (!includeCompleted) extra.push(ne(tasks.status, "completed"));
  return queryTasks(extra);
}

export async function getTaskById(id: number): Promise<TaskWithRelations | null> {
  const result = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .limit(1);

  if (!result[0]) return null;

  const enriched = await enrichTasksWithRelations([result[0]]);
  return enriched[0] || null;
}

export async function createTask(
  data: InsertTask,
  createdByUserId: number,
  txOrDb: DbOrTx = db,
): Promise<Task> {
  const assignedToUserId = data.assignedToUserId || createdByUserId;

  const result = await txOrDb
    .insert(tasks)
    .values({
      title: data.title,
      description: data.description || null,
      dueDate: data.dueDate || null,
      priority: data.priority || "medium",
      status: "open",
      createdByUserId,
      assignedToUserId,
      customerId: data.customerId || null,
    })
    .returning();

  return result[0];
}

export async function updateTask(
  id: number,
  data: UpdateTask,
  userId: number,
  isAdmin: boolean
): Promise<Task | null> {
  const existing = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .limit(1);

  if (!existing[0]) return null;

  const task = existing[0];
  if (!isAdmin && task.assignedToUserId !== userId && task.createdByUserId !== userId) {
    throw new Error("Keine Berechtigung zum Bearbeiten dieser Aufgabe");
  }

  const updateData: Partial<Task> = {
    updatedAt: new Date(),
  };

  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.dueDate !== undefined) updateData.dueDate = data.dueDate;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.customerId !== undefined) updateData.customerId = data.customerId;
  
  if (data.status !== undefined) {
    updateData.status = data.status;
    if (data.status === "completed") {
      updateData.completedAt = new Date();
    } else {
      updateData.completedAt = null;
    }
  }

  if (isAdmin && data.assignedToUserId !== undefined) {
    updateData.assignedToUserId = data.assignedToUserId;
  }

  const result = await db
    .update(tasks)
    .set(updateData)
    .where(eq(tasks.id, id))
    .returning();

  return result[0] || null;
}

export async function deleteTask(
  id: number,
  userId: number,
  isAdmin: boolean
): Promise<boolean> {
  const existing = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .limit(1);

  if (!existing[0]) return false;

  const task = existing[0];
  if (!isAdmin && task.createdByUserId !== userId) {
    throw new Error("Nur der Ersteller oder ein Admin kann diese Aufgabe löschen");
  }

  await db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, id));
  return true;
}

export async function getOpenTaskCount(userId: number): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedToUserId, userId),
        ne(tasks.status, "completed"),
        isNull(tasks.deletedAt)
      )
    );

  return result[0]?.count ?? 0;
}

const MONTH_CLOSING_TITLE_PREFIX = "Monatsabschluss";

function getMonthClosingTaskTitle(month: number, year: number): string {
  const monthNames = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];
  return `${MONTH_CLOSING_TITLE_PREFIX} ${monthNames[month - 1]} ${year}`;
}

const MONTH_CLOSING_DESCRIPTION = `So schließt du deinen Monat ab:

1. Gehe auf die Zeiten-Seite
2. Prüfe deine Zeiteinträge auf Vollständigkeit
3. Kontrolliere fehlende Pausendokumentationen (blaue Markierungen im Kalender)
4. Klicke auf "Monat abschließen"

Hinweis: Alle Termine des Monats müssen dokumentiert sein, bevor der Abschluss möglich ist.`;

export async function findMonthClosingTask(
  userId: number,
  month: number,
  year: number,
  txOrDb: DbOrTx = db
): Promise<Task | null> {
  const title = getMonthClosingTaskTitle(month, year);
  const result = await txOrDb
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedToUserId, userId),
        eq(tasks.title, title),
        isNull(tasks.deletedAt)
      )
    )
    .limit(1);
  return result[0] || null;
}

export async function ensureMonthClosingTask(
  userId: number,
  month: number,
  year: number,
  txOrDb: DbOrTx = db
): Promise<Task> {
  const existing = await findMonthClosingTask(userId, month, year, txOrDb);
  if (existing) return existing;

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const dueDate = `${nextYear}-${nextMonth.toString().padStart(2, "0")}-05`;

  const result = await txOrDb
    .insert(tasks)
    .values({
      title: getMonthClosingTaskTitle(month, year),
      description: MONTH_CLOSING_DESCRIPTION,
      dueDate,
      priority: "high",
      status: "open",
      createdByUserId: userId,
      assignedToUserId: userId,
      customerId: null,
    })
    .returning();

  return result[0];
}

export async function completeMonthClosingTask(
  userId: number,
  month: number,
  year: number,
  txOrDb: DbOrTx = db
): Promise<void> {
  const existing = await findMonthClosingTask(userId, month, year, txOrDb);
  if (existing && existing.status !== "completed") {
    await txOrDb
      .update(tasks)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, existing.id));
  }
}

export async function reopenMonthClosingTask(
  userId: number,
  month: number,
  year: number
): Promise<void> {
  const existing = await findMonthClosingTask(userId, month, year);
  if (existing && existing.status === "completed") {
    await db
      .update(tasks)
      .set({
        status: "open",
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, existing.id));
  }
}

const BIRTHDAY_MARKER_PREFIX = "[birthday:";

function getBirthdayTaskTitle(personType: "customer" | "employee", name: string): string {
  return personType === "employee"
    ? `Gutschein versenden für ${name}`
    : `Geburtstagskarte versenden für ${name}`;
}

function getBirthdayTaskMarker(personType: string, personId: number, year: number): string {
  return `${BIRTHDAY_MARKER_PREFIX}${personType}:${personId}:${year}]`;
}

export function parseBirthdayMarker(description: string | null): { personType: "customer" | "employee"; personId: number; year: number } | null {
  if (!description) return null;
  const match = description.match(/\[birthday:(customer|employee):(\d+):(\d+)\]/);
  if (!match) return null;
  return {
    personType: match[1] as "customer" | "employee",
    personId: parseInt(match[2], 10),
    year: parseInt(match[3], 10),
  };
}

export async function findBirthdayTask(
  adminUserId: number,
  personType: string,
  personId: number,
  year: number,
  txOrDb: DbOrTx = db
): Promise<Task | null> {
  const marker = getBirthdayTaskMarker(personType, personId, year);
  const result = await txOrDb
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedToUserId, adminUserId),
        sqlBuilder`${tasks.description} LIKE ${'%' + marker + '%'}`,
        isNull(tasks.deletedAt)
      )
    )
    .limit(1);
  return result[0] || null;
}

export async function ensureBirthdayTask(
  adminUserId: number,
  personType: "customer" | "employee",
  personId: number,
  name: string,
  birthdayDateISO: string,
  year: number,
  customerId: number | null = null,
  txOrDb: DbOrTx = db
): Promise<Task> {
  const existing = await findBirthdayTask(adminUserId, personType, personId, year, txOrDb);
  if (existing) return existing;

  const title = getBirthdayTaskTitle(personType, name);
  const marker = getBirthdayTaskMarker(personType, personId, year);
  const description = personType === "employee"
    ? `Amazon-Gutschein zum Geburtstag versenden.\n${marker}`
    : `Geburtstagskarte versenden.\n${marker}`;

  const today = new Date();
  const birthdayDate = parseLocalDate(birthdayDateISO);
  const nextBirthday = new Date(year, birthdayDate.getMonth(), birthdayDate.getDate());
  const dueDate = `${nextBirthday.getFullYear()}-${(nextBirthday.getMonth() + 1).toString().padStart(2, "0")}-${nextBirthday.getDate().toString().padStart(2, "0")}`;

  const result = await txOrDb
    .insert(tasks)
    .values({
      title,
      description,
      dueDate,
      priority: "high",
      status: "open",
      createdByUserId: adminUserId,
      assignedToUserId: adminUserId,
      customerId: personType === "customer" ? customerId ?? personId : null,
    })
    .returning();

  return result[0];
}

export async function completeBirthdayTask(
  adminUserId: number,
  personType: string,
  personId: number,
  year: number,
  txOrDb: DbOrTx = db
): Promise<void> {
  const existing = await findBirthdayTask(adminUserId, personType, personId, year, txOrDb);
  if (existing && existing.status !== "completed") {
    await txOrDb
      .update(tasks)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, existing.id));
  }
}

export async function reopenBirthdayTask(
  adminUserId: number,
  personType: string,
  personId: number,
  year: number,
  txOrDb: DbOrTx = db
): Promise<void> {
  const existing = await findBirthdayTask(adminUserId, personType, personId, year, txOrDb);
  if (existing && existing.status === "completed") {
    await txOrDb
      .update(tasks)
      .set({
        status: "open",
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, existing.id));
  }
}

export async function completeAllBirthdayTasks(
  personType: string,
  personId: number,
  year: number,
  txOrDb: DbOrTx = db
): Promise<void> {
  const marker = getBirthdayTaskMarker(personType, personId, year);
  await txOrDb
    .update(tasks)
    .set({
      status: "completed",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        sqlBuilder`${tasks.description} LIKE ${'%' + marker + '%'}`,
        ne(tasks.status, "completed"),
        isNull(tasks.deletedAt)
      )
    );
}

export async function reopenAllBirthdayTasks(
  personType: string,
  personId: number,
  year: number,
  txOrDb: DbOrTx = db
): Promise<void> {
  const marker = getBirthdayTaskMarker(personType, personId, year);
  await txOrDb
    .update(tasks)
    .set({
      status: "open",
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        sqlBuilder`${tasks.description} LIKE ${'%' + marker + '%'}`,
        eq(tasks.status, "completed"),
        isNull(tasks.deletedAt)
      )
    );
}
