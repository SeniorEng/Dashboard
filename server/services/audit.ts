import { db, type DbOrTx } from "../lib/db";
import { auditLog, type AuditAction, type AuditEntityType, type AuditLogFilter } from "@shared/schema";
import type { ActorRole } from "../lib/team-lead";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { users } from "@shared/schema";
import { parseLocalDate } from "@shared/utils/datetime";

class AuditService {
  /**
   * Schreibt einen Audit-Log-Eintrag.
   *
   * Bei Aufruf ohne `exec` (Legacy-Pfad) werden Fehler geschluckt und nur
   * geloggt — sonst würde ein gestörter Audit-Insert nachgelagerte
   * Logik in nicht-transaktionalen Callern killen.
   *
   * Bei Aufruf mit `exec = tx` (transaktions-bewusster Pfad, siehe
   * `withAudit`) MÜSSEN Fehler propagieren, damit die umschließende
   * Transaktion zurückrollt. Sonst wäre die Mutation comitted ohne
   * Audit-Eintrag — GoBD-Verstoß.
   */
  async log(
    userId: number,
    action: AuditAction,
    entityType: AuditEntityType,
    entityId: number,
    metadata?: Record<string, unknown>,
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    const values = {
      userId,
      action,
      entityType,
      entityId,
      metadata: metadata ?? null,
      ipAddress: ipAddress ?? null,
    };
    if (exec) {
      await exec.insert(auditLog).values(values);
      return;
    }
    try {
      await db.insert(auditLog).values(values);
    } catch (error) {
      console.error("[AuditService] Failed to write audit log:", error);
    }
  }

  async documentationSubmitted(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; hasSignature: boolean; performedByEmployeeId?: number | null },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "documentation_submitted", "appointment", appointmentId, metadata, ipAddress, exec);
  }

  async signatureAdded(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; signatureHash?: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "documentation_signature_added", "appointment", appointmentId, metadata, ipAddress, exec);
  }

  async serviceRecordCreated(
    userId: number,
    serviceRecordId: number,
    metadata: { customerId: number; year: number; month: number; appointmentCount: number; recordType?: string; appointmentId?: number },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "service_record_created", "service_record", serviceRecordId, metadata, ipAddress, exec);
  }

  async serviceRecordSigned(
    userId: number,
    serviceRecordId: number,
    signerType: "employee" | "customer",
    metadata: { customerId: number; signatureHash?: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    const action = signerType === "employee" ? "service_record_signed_employee" : "service_record_signed_customer";
    await this.log(userId, action, "service_record", serviceRecordId, metadata, ipAddress, exec);
  }

  async serviceRecordRevoked(
    userId: number,
    serviceRecordId: number,
    metadata: { customerId: number; reason?: string; previousStatus: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "service_record_revoked", "service_record", serviceRecordId, metadata, ipAddress, exec);
  }

  async appointmentRevoked(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; reason?: string; previousStatus: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "appointment_revoked", "appointment", appointmentId, metadata, ipAddress, exec);
  }

  async appointmentUpdated(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; changedFields: string[]; actor?: { role: ActorRole } },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "appointment_updated", "appointment", appointmentId, metadata, ipAddress, exec);
  }

  async appointmentCreated(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; assignedEmployeeId: number; date: string; actor?: { role: ActorRole } },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "appointment_created", "appointment", appointmentId, metadata, ipAddress, exec);
  }

  async appointmentDeleted(
    userId: number,
    appointmentId: number,
    metadata: { customerId: number; date: string; status: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "appointment_deleted", "appointment", appointmentId, metadata, ipAddress, exec);
  }

  async customerUpdated(
    userId: number,
    customerId: number,
    metadata: { changedFields: string[]; oldValues: Record<string, unknown>; newValues: Record<string, unknown>; actor?: { role: ActorRole } },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "customer_updated", "customer", customerId, metadata, ipAddress, exec);
  }

  async customerCareLevelChanged(
    userId: number,
    customerId: number,
    metadata: { oldPflegegrad: number | null; newPflegegrad: number; seitDatum: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "customer_care_level_changed", "customer", customerId, metadata, ipAddress, exec);
  }

  async loginSuccess(
    userId: number,
    metadata: { email: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "login_success", "user", userId, metadata, ipAddress, exec);
  }

  async loginFailed(
    userId: number,
    metadata: { email: string; reason: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "login_failed", "user", userId, metadata, ipAddress, exec);
  }

  async passwordChanged(
    userId: number,
    metadata: { method: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "password_changed", "user", userId, metadata, ipAddress, exec);
  }

  async customerCreated(
    userId: number,
    customerId: number,
    metadata: { customerName: string; billingType: string },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "customer_created", "customer", customerId, metadata, ipAddress, exec);
  }

  async customerHardDeleted(
    userId: number,
    customerId: number,
    metadata: {
      customerName: string;
      vorname: string | null;
      nachname: string | null;
      geburtsdatum: string | null;
      createdAt: string | null;
      reason: string;
    },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "customer_hard_deleted", "customer", customerId, metadata, ipAddress, exec);
  }

  async invoicePaymentReconciled(
    userId: number,
    invoiceId: number,
    metadata: {
      qontoTransactionId: number;
      qontoTransactionExternalId?: string;
      matchedBy: "auto" | "manual";
      confidence: string;
      amountCents?: number;
    },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "invoice_payment_reconciled", "invoice", invoiceId, metadata, ipAddress, exec);
  }

  async invoicePaymentUnreconciled(
    userId: number,
    invoiceId: number,
    metadata: {
      qontoTransactionId: number;
      qontoTransactionExternalId?: string;
      previousConfidence: string | null;
    },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "invoice_payment_unreconciled", "invoice", invoiceId, metadata, ipAddress, exec);
  }

  async customerContractUpdated(
    userId: number,
    customerId: number,
    metadata: { changedFields: string[]; oldValues: Record<string, unknown>; newValues: Record<string, unknown> },
    ipAddress?: string,
    exec?: DbOrTx,
  ): Promise<void> {
    await this.log(userId, "customer_contract_updated", "customer", customerId, metadata, ipAddress, exec);
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
      // Filter ist YYYY-MM-DD; parseLocalDate liefert lokale Mitternacht
      // und ist damit deterministisch unabhängig von der Server-TZ.
      conditions.push(gte(auditLog.createdAt, parseLocalDate(filter.from)));
    }
    if (filter.to) {
      // "to" ist einschließendes Tagesende der lokalen Zeit.
      const endOfDay = parseLocalDate(filter.to);
      endOfDay.setHours(23, 59, 59, 999);
      conditions.push(lte(auditLog.createdAt, endOfDay));
    }
    if (filter.batchId) {
      conditions.push(sql`${auditLog.metadata}->>'batchId' = ${filter.batchId}`);
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
