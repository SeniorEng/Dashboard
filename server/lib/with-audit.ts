import { db, type Tx } from "./db";
import { auditService } from "../services/audit";
import type { AuditAction, AuditEntityType } from "@shared/schema";
import { maybeFail } from "./test-fault-injector";

/**
 * Ein einzelner Audit-Eintrag, den eine Mutation innerhalb der
 * `withAudit`-Transaktion vormerken kann.
 */
export interface AuditEntry {
  userId: number;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: number;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string;
}

export interface TxAuditRecorder {
  /**
   * Merkt einen Audit-Eintrag vor. Er wird unmittelbar vor dem Commit
   * derselben Transaktion geschrieben. Wirft der Insert, rollt die
   * gesamte Transaktion (Mutation + Audit) zurück.
   */
  record(entry: AuditEntry): void;
}

export interface WithAuditOptions {
  /**
   * Test-Fault-Set (aus `readTestFaults(req)`). Im Produktionsbetrieb
   * undefined. Erkannte Faults:
   *   - "audit_log": Wirft direkt vor dem Audit-Insert, sodass der Test
   *     verifizieren kann, dass die Mutation gerollback wird.
   */
  faults?: Set<string>;
}

/**
 * Führt Mutation und Audit-Eintrag atomar in derselben Transaktion aus.
 *
 * Anwendung:
 * ```ts
 * const invoice = await withAudit(async (tx, audit) => {
 *   const created = await createInvoiceTx(tx, data, items, userId);
 *   audit.record({
 *     userId, action: "invoice_created", entityType: "invoice",
 *     entityId: created.id, metadata: {...}, ipAddress: req.ip,
 *   });
 *   return created;
 * });
 * ```
 *
 * Wirft entweder die Mutation oder der Audit-Insert, rollt PostgreSQL die
 * gesamte Transaktion zurück. Damit ist garantiert, dass jede committete
 * Mutation auch einen Audit-Eintrag hat (GoBD).
 */
export async function withAudit<T>(
  fn: (tx: Tx, audit: TxAuditRecorder) => Promise<T>,
  options: WithAuditOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    const audits: AuditEntry[] = [];
    const recorder: TxAuditRecorder = {
      record(entry: AuditEntry) {
        audits.push(entry);
      },
    };

    const result = await fn(tx, recorder);

    // Test-Fault: simuliert einen Audit-Insert-Fehler zwischen Mutation
    // und Audit-Schreiben. Die Mutation MUSS dadurch zurückgerollt werden.
    maybeFail("audit_log", options.faults);

    for (const entry of audits) {
      await auditService.log(
        entry.userId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.metadata ?? undefined,
        entry.ipAddress,
        tx,
      );
    }

    return result;
  });
}
