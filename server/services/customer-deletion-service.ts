import { eq, and, isNull, sql } from "drizzle-orm";
import type { Tx } from "../lib/db";
import {
  customers,
  appointments,
  monthlyServiceRecords,
  tasks,
  customerDocuments,
  customerContracts,
  customerServicePrices,
  budgetAllocations,
  budgetTransactions,
  customerBudgetTypeSettings,
  invoices as invoicesTable,
  prospects,
  type AuditAction,
  type AuditEntityType,
} from "@shared/schema";
import { auditService } from "./audit";

/**
 * Task #448: Customer-Hard-Delete: Per-Child-Audit + Soft-Default
 *
 * Statt FK-Cascades alle abhängigen Datensätze stillschweigend mitlöschen zu
 * lassen, wird jeder Child-Datensatz hier explizit soft-gelöscht und mit einem
 * eigenen Audit-Log-Eintrag versehen, der per `parentDeletionId` auf den
 * Eintrag des Parent-Löschvorgangs verweist. Das macht eine forensische
 * Rekonstruktion „was wurde mit dem Kunden mitgelöscht?" möglich.
 */

interface ChildAuditTarget {
  /** Identifier für den Child-Typ — landet in metadata.childTable */
  table: string;
  /** Drizzle-Action-Identifier — generisch `customer_child_soft_deleted` */
  action: AuditAction;
  /** Welche Entität wird im Audit-Log eingetragen? */
  entityType: AuditEntityType;
  /** Anzahl der betroffenen Zeilen — wird per UPDATE … RETURNING ermittelt. */
  ids: number[];
}

export interface SoftCascadeResult {
  parentAuditId: number;
  childAudits: number;
  perTable: Record<string, number>;
}

/**
 * Soft-löscht alle abhängigen Datensätze eines Kunden, schreibt pro Child
 * einen `customer_child_soft_deleted`-Audit-Eintrag (verlinkt mit
 * `parentDeletionId`), und soft-löscht abschließend den Kunden selbst.
 *
 * MUSS innerhalb einer Transaktion aufgerufen werden — Aufrufer kümmert sich
 * um Row-Locking (SELECT … FOR UPDATE auf den Customer) und um etwaige
 * Eskalation auf echten Hard-Delete (siehe Route).
 */
export async function softDeleteCustomerWithCascade(args: {
  tx: Tx;
  customerId: number;
  userId: number;
  ipAddress?: string;
  reason: string;
  snapshot: Record<string, unknown>;
  /**
   * Wenn true, wird `customer_hard_deleted` (statt `customer_soft_deleted`)
   * als Parent-Audit verwendet — der Aufrufer entfernt im Anschluss noch
   * die Kunden-Zeile per `tx.delete(customers)`. FK-Cascades treffen dann
   * nur noch Tabellen ohne `deletedAt`, deren Inhalt zuvor durch diese
   * Routine nicht angefasst wurde (z.B. customer_contacts).
   */
  hardDelete?: boolean;
  complianceOfficerSignoff?: string | null;
}): Promise<SoftCascadeResult> {
  const { tx, customerId, userId, ipAddress, reason, snapshot, hardDelete, complianceOfficerSignoff } = args;
  const now = new Date();

  // 1) Parent-Audit zuerst schreiben — Children referenzieren dessen ID.
  const parentAction: AuditAction = hardDelete ? "customer_hard_deleted" : "customer_soft_deleted";
  const parentAuditId = await auditService.log(
    userId,
    parentAction,
    "customer",
    customerId,
    {
      ...snapshot,
      reason,
      hardDelete: !!hardDelete,
      complianceOfficerSignoff: complianceOfficerSignoff ?? null,
    },
    ipAddress,
    tx,
    null,
  );

  if (!parentAuditId) {
    throw new Error("Parent-Audit konnte nicht geschrieben werden — Lösch-Vorgang abgebrochen");
  }

  // 2) Child-Tabellen mit `deleted_at` — soft-löschen und IDs zurückgeben.
  const targets: ChildAuditTarget[] = [];

  // Termine
  {
    const rows = await tx.update(appointments)
      .set({ deletedAt: now })
      .where(and(eq(appointments.customerId, customerId), isNull(appointments.deletedAt)))
      .returning({ id: appointments.id });
    targets.push({ table: "appointments", action: "customer_child_soft_deleted", entityType: "appointment", ids: rows.map(r => r.id) });
  }

  // Leistungsnachweise
  {
    const rows = await tx.update(monthlyServiceRecords)
      .set({ deletedAt: now })
      .where(and(eq(monthlyServiceRecords.customerId, customerId), isNull(monthlyServiceRecords.deletedAt)))
      .returning({ id: monthlyServiceRecords.id });
    targets.push({ table: "monthly_service_records", action: "customer_child_soft_deleted", entityType: "service_record", ids: rows.map(r => r.id) });
  }

  // Aufgaben (FK ON DELETE SET NULL, aber wir wollen Audit-Spur)
  {
    const rows = await tx.update(tasks)
      .set({ deletedAt: now })
      .where(and(eq(tasks.customerId, customerId), isNull(tasks.deletedAt)))
      .returning({ id: tasks.id });
    targets.push({ table: "tasks", action: "customer_child_soft_deleted", entityType: "customer", ids: rows.map(r => r.id) });
  }

  // Kundendokumente
  {
    const rows = await tx.update(customerDocuments)
      .set({ deletedAt: now })
      .where(and(eq(customerDocuments.customerId, customerId), isNull(customerDocuments.deletedAt)))
      .returning({ id: customerDocuments.id });
    targets.push({ table: "customer_documents", action: "customer_child_soft_deleted", entityType: "customer", ids: rows.map(r => r.id) });
  }

  // Verträge (History-Einträge — append-only, daher nur fehlende deletedAt-Spalten
  // gibt es bei `customer_contracts` nicht; FK-Cascade lassen wir greifen.
  // Wir schreiben aber dennoch einen Audit-Eintrag pro Vertrag.)
  {
    const rows = await tx.select({ id: customerContracts.id })
      .from(customerContracts)
      .where(eq(customerContracts.customerId, customerId));
    targets.push({ table: "customer_contracts", action: "customer_child_soft_deleted", entityType: "customer", ids: rows.map(r => r.id) });
  }

  // Custom Pricing (Kundenpreise)
  {
    const rows = await tx.update(customerServicePrices)
      .set({ deletedAt: now })
      .where(and(eq(customerServicePrices.customerId, customerId), isNull(customerServicePrices.deletedAt)))
      .returning({ id: customerServicePrices.id });
    targets.push({ table: "customer_service_prices", action: "customer_child_soft_deleted", entityType: "customer", ids: rows.map(r => r.id) });
  }

  // Budget-Allocations
  {
    const rows = await tx.update(budgetAllocations)
      .set({ deletedAt: now })
      .where(and(eq(budgetAllocations.customerId, customerId), isNull(budgetAllocations.deletedAt)))
      .returning({ id: budgetAllocations.id });
    targets.push({ table: "budget_allocations", action: "customer_child_soft_deleted", entityType: "budget", ids: rows.map(r => r.id) });
  }

  // Budget-Transaktionen — keine `deletedAt`-Spalte; nur Audit-Spur.
  {
    const rows = await tx.select({ id: budgetTransactions.id })
      .from(budgetTransactions)
      .where(eq(budgetTransactions.customerId, customerId));
    targets.push({ table: "budget_transactions", action: "customer_child_soft_deleted", entityType: "budget", ids: rows.map(r => r.id) });
  }

  // Budget-Type-Settings — append-only; schließe offene Zeilen über validTo.
  {
    const rows = await tx.update(customerBudgetTypeSettings)
      .set({ validTo: sql`CURRENT_DATE` })
      .where(and(eq(customerBudgetTypeSettings.customerId, customerId), isNull(customerBudgetTypeSettings.validTo)))
      .returning({ id: customerBudgetTypeSettings.id });
    targets.push({ table: "customer_budget_type_settings", action: "customer_child_soft_deleted", entityType: "budget", ids: rows.map(r => r.id) });
  }

  // Rechnungen — keine `deletedAt`; nur Audit-Spur. Status bleibt unverändert
  // (GoBD: ausgestellte Rechnungen werden nicht „gelöscht").
  {
    const rows = await tx.select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(eq(invoicesTable.customerId, customerId));
    targets.push({ table: "invoices", action: "customer_child_soft_deleted", entityType: "invoice", ids: rows.map(r => r.id) });
  }

  // Prospect-Backreferenzen (convertedCustomerId) — nur Audit-Spur.
  {
    const rows = await tx.select({ id: prospects.id })
      .from(prospects)
      .where(eq(prospects.convertedCustomerId, customerId));
    targets.push({ table: "prospects", action: "customer_child_soft_deleted", entityType: "prospect", ids: rows.map(r => r.id) });
  }

  // 3) Pro Child einen Audit-Eintrag mit parentDeletionId.
  let childAudits = 0;
  const perTable: Record<string, number> = {};
  for (const t of targets) {
    perTable[t.table] = t.ids.length;
    for (const childId of t.ids) {
      await auditService.log(
        userId,
        t.action,
        t.entityType,
        childId,
        { customerId, childTable: t.table },
        ipAddress,
        tx,
        parentAuditId,
      );
      childAudits++;
    }
  }

  // 4) Erst danach den Kunden selbst soft-löschen.
  await tx.update(customers)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(customers.id, customerId));

  return { parentAuditId, childAudits, perTable };
}
