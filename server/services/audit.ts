import { db } from "../lib/db";
import { auditLog, type AuditAction, type AuditEntityType, type AuditLogFilter } from "@shared/schema";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { users } from "@shared/schema";

class AuditService {
  async log(
    userId: number,
    action: AuditAction,
    entityType: AuditEntityType,
    entityId: number,
    metadata?: Record<string, unknown>,
    ipAddress?: string
  ): Promise<void> {
    try {
      await db.insert(auditLog).values({
        userId,
        action,
        entityType,
        entityId,
        metadata: metadata ?? null,
        ipAddress: ipAddress ?? null,
      });
    } catch (error) {
      console.error("[AuditService] Failed to write audit log:", error);
    }
  }

  async documentationSubmitted(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; hasSignature: boolean; performedByEmployeeId?: number | null },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "documentation_submitted", "appointment", appointmentId, metadata, ipAddress);
  }

  async signatureAdded(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; signatureHash?: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "documentation_signature_added", "appointment", appointmentId, metadata, ipAddress);
  }

  async serviceRecordCreated(
    userId: number,
    serviceRecordId: number,
    metadata: { customerId: number; year: number; month: number; appointmentCount: number },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "service_record_created", "service_record", serviceRecordId, metadata, ipAddress);
  }

  async serviceRecordSigned(
    userId: number,
    serviceRecordId: number,
    signerType: "employee" | "customer",
    metadata: { customerId: number; signatureHash?: string },
    ipAddress?: string
  ): Promise<void> {
    const action = signerType === "employee" ? "service_record_signed_employee" : "service_record_signed_customer";
    await this.log(userId, action, "service_record", serviceRecordId, metadata, ipAddress);
  }

  async serviceRecordRevoked(
    userId: number,
    serviceRecordId: number,
    metadata: { customerId: number; reason?: string; previousStatus: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "service_record_revoked", "service_record", serviceRecordId, metadata, ipAddress);
  }

  async appointmentRevoked(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; reason?: string; previousStatus: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "appointment_revoked", "appointment", appointmentId, metadata, ipAddress);
  }

  async appointmentUpdated(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; changedFields: string[] },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "appointment_updated", "appointment", appointmentId, metadata, ipAddress);
  }

  async appointmentDeleted(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; date: string; status: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "appointment_deleted", "appointment", appointmentId, metadata, ipAddress);
  }

  async customerUpdated(
    userId: number,
    customerId: number,
    metadata: { changedFields: string[]; oldValues: Record<string, unknown>; newValues: Record<string, unknown> },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "customer_updated", "customer", customerId, metadata, ipAddress);
  }

  async customerCareLevelChanged(
    userId: number,
    customerId: number,
    metadata: { oldPflegegrad: number | null; newPflegegrad: number; seitDatum: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "customer_care_level_changed", "customer", customerId, metadata, ipAddress);
  }

  async loginSuccess(
    userId: number,
    metadata: { email: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "login_success", "user", userId, metadata, ipAddress);
  }

  async loginFailed(
    userId: number,
    metadata: { email: string; reason: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "login_failed", "user", userId, metadata, ipAddress);
  }

  async passwordChanged(
    userId: number,
    metadata: { method: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "password_changed", "user", userId, metadata, ipAddress);
  }

  async customerCreated(
    userId: number,
    customerId: number,
    metadata: { customerName: string; billingType: string },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "customer_created", "customer", customerId, metadata, ipAddress);
  }

  async customerContractUpdated(
    userId: number,
    customerId: number,
    metadata: { changedFields: string[]; oldValues: Record<string, unknown>; newValues: Record<string, unknown> },
    ipAddress?: string
  ): Promise<void> {
    await this.log(userId, "customer_contract_updated", "customer", customerId, metadata, ipAddress);
  }

  async getEntries(filter: AuditLogFilter): Promise<{ entries: Array<{
    id: number;
    userId: number;
    userName: string;
    action: string;
    entityType: string;
    entityId: number;
    metadata: unknown;
    ipAddress: string | null;
    createdAt: Date;
  }>; total: number }> {
    const conditions = [];

    if (filter.entityType) {
      conditions.push(eq(auditLog.entityType, filter.entityType));
    }
    if (filter.entityId) {
      conditions.push(eq(auditLog.entityId, filter.entityId));
    }
    if (filter.userId) {
      conditions.push(eq(auditLog.userId, filter.userId));
    }
    if (filter.action) {
      conditions.push(eq(auditLog.action, filter.action));
    }
    if (filter.from) {
      conditions.push(gte(auditLog.createdAt, new Date(filter.from)));
    }
    if (filter.to) {
      conditions.push(lte(auditLog.createdAt, new Date(filter.to)));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [entries, countResult] = await Promise.all([
      db
        .select({
          id: auditLog.id,
          userId: auditLog.userId,
          userName: users.displayName,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          metadata: auditLog.metadata,
          ipAddress: auditLog.ipAddress,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .innerJoin(users, eq(auditLog.userId, users.id))
        .where(whereClause)
        .orderBy(desc(auditLog.createdAt))
        .limit(filter.limit)
        .offset(filter.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(whereClause),
    ]);

    return {
      entries,
      total: countResult[0]?.count ?? 0,
    };
  }
}

export const auditService = new AuditService();
