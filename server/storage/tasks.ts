import { tasks, users, customers, Task, InsertTask, UpdateTask } from "@shared/schema";
import { eq, and, desc, asc, ne, sql as sqlBuilder, inArray, count } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../lib/db";

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

export async function getTasksForUser(userId: number, includeCompleted: boolean = false): Promise<TaskWithRelations[]> {
  const baseCondition = eq(tasks.assignedToUserId, userId);
  const whereCondition = includeCompleted 
    ? baseCondition 
    : and(baseCondition, ne(tasks.status, "completed"));

  const result = await db
    .select()
    .from(tasks)
    .where(whereCondition)
    .orderBy(
      asc(tasks.status),
      desc(sqlBuilder`CASE WHEN ${tasks.priority} = 'high' THEN 1 WHEN ${tasks.priority} = 'medium' THEN 2 ELSE 3 END`),
      asc(tasks.dueDate)
    );

  return enrichTasksWithRelations(result);
}

export async function getAllTasks(includeCompleted: boolean = false): Promise<TaskWithRelations[]> {
  let query = db
    .select()
    .from(tasks)
    .orderBy(
      asc(tasks.status),
      desc(sqlBuilder`CASE WHEN ${tasks.priority} = 'high' THEN 1 WHEN ${tasks.priority} = 'medium' THEN 2 ELSE 3 END`),
      asc(tasks.dueDate)
    );

  const result = includeCompleted 
    ? await query
    : await query.where(ne(tasks.status, "completed"));

  return enrichTasksWithRelations(result);
}

export async function getTaskById(id: number): Promise<TaskWithRelations | null> {
  const result = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);

  if (!result[0]) return null;

  const enriched = await enrichTasksWithRelations([result[0]]);
  return enriched[0] || null;
}

export async function createTask(
  data: InsertTask,
  createdByUserId: number
): Promise<Task> {
  const assignedToUserId = data.assignedToUserId || createdByUserId;

  const result = await db
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
    .where(eq(tasks.id, id))
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
    .where(eq(tasks.id, id))
    .limit(1);

  if (!existing[0]) return false;

  const task = existing[0];
  if (!isAdmin && task.createdByUserId !== userId) {
    throw new Error("Nur der Ersteller oder ein Admin kann diese Aufgabe löschen");
  }

  await db.delete(tasks).where(eq(tasks.id, id));
  return true;
}

export async function getOpenTaskCount(userId: number): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedToUserId, userId),
        ne(tasks.status, "completed")
      )
    );

  return result[0]?.count ?? 0;
}
