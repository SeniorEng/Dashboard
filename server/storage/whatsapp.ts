import { eq, desc, and, inArray, sql as sqlBuilder } from "drizzle-orm";
import { db } from "../lib/db";
import {
  whatsappNotificationRules,
  userWhatsappPreferences,
  whatsappMessageLog,
  type WhatsAppNotificationRule,
  type InsertWhatsAppNotificationRule,
  type UserWhatsappPreferences,
  type InsertUserWhatsappPreferences,
  type WhatsAppMessageLog,
  type InsertWhatsAppMessageLog,
} from "@shared/schema";

export async function getWhatsAppNotificationRules(): Promise<WhatsAppNotificationRule[]> {
  return db
    .select()
    .from(whatsappNotificationRules)
    .orderBy(whatsappNotificationRules.eventType);
}

async function upsertWhatsAppNotificationRule(
  rule: InsertWhatsAppNotificationRule
): Promise<WhatsAppNotificationRule> {
  const result = await db
    .insert(whatsappNotificationRules)
    .values(rule)
    .onConflictDoUpdate({
      target: whatsappNotificationRules.eventType,
      set: {
        enabled: rule.enabled,
        templateName: rule.templateName,
        description: rule.description,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result[0];
}

export async function batchUpsertWhatsAppNotificationRules(
  rules: InsertWhatsAppNotificationRule[]
): Promise<WhatsAppNotificationRule[]> {
  if (rules.length === 0) return [];
  return db
    .insert(whatsappNotificationRules)
    .values(rules)
    .onConflictDoUpdate({
      target: whatsappNotificationRules.eventType,
      set: {
        enabled: sqlBuilder`excluded.enabled`,
        templateName: sqlBuilder`excluded.template_name`,
        description: sqlBuilder`excluded.description`,
        updatedAt: new Date(),
      },
    })
    .returning();
}

async function deleteWhatsAppNotificationRule(id: number): Promise<void> {
  await db
    .delete(whatsappNotificationRules)
    .where(eq(whatsappNotificationRules.id, id));
}

export async function getEnabledRuleByEvent(
  eventType: string
): Promise<WhatsAppNotificationRule | null> {
  const rows = await db
    .select()
    .from(whatsappNotificationRules)
    .where(
      and(
        eq(whatsappNotificationRules.eventType, eventType),
        eq(whatsappNotificationRules.enabled, true)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getUserWhatsAppPreferences(
  userId: number
): Promise<UserWhatsappPreferences | null> {
  const rows = await db
    .select()
    .from(userWhatsappPreferences)
    .where(eq(userWhatsappPreferences.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertUserWhatsAppPreferences(
  userId: number,
  prefs: Omit<InsertUserWhatsappPreferences, "userId">
): Promise<UserWhatsappPreferences> {
  const result = await db
    .insert(userWhatsappPreferences)
    .values({ ...prefs, userId })
    .onConflictDoUpdate({
      target: userWhatsappPreferences.userId,
      set: {
        enabled: prefs.enabled,
        whatsappNumber: prefs.whatsappNumber,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result[0];
}

export async function getUsersWithWhatsAppEnabled(
  userIds?: number[]
): Promise<UserWhatsappPreferences[]> {
  if (userIds && userIds.length === 0) {
    return [];
  }

  const conditions = [eq(userWhatsappPreferences.enabled, true)];
  if (userIds) {
    conditions.push(inArray(userWhatsappPreferences.userId, userIds));
  }

  return db
    .select()
    .from(userWhatsappPreferences)
    .where(and(...conditions));
}

export async function getMessageLog(
  limit = 50,
  offset = 0,
  statusFilter?: string
): Promise<{ entries: WhatsAppMessageLog[]; total: number }> {
  const conditions = statusFilter ? [eq(whatsappMessageLog.status, statusFilter)] : [];
  const [entries, countResult] = await Promise.all([
    db
      .select()
      .from(whatsappMessageLog)
      .where(conditions.length > 0 ? conditions[0] : undefined)
      .orderBy(desc(whatsappMessageLog.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sqlBuilder<number>`count(*)::int` })
      .from(whatsappMessageLog)
      .where(conditions.length > 0 ? conditions[0] : undefined),
  ]);
  return { entries, total: countResult[0]?.count ?? 0 };
}

async function createMessageLogEntry(
  entry: InsertWhatsAppMessageLog
): Promise<WhatsAppMessageLog> {
  const result = await db
    .insert(whatsappMessageLog)
    .values(entry)
    .returning();
  return result[0];
}
