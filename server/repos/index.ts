/**
 * Task #447 — Zentrale Repos für soft-deletable Tabellen.
 *
 * Jeder Eintrag ist hand-getippt (nicht über eine generische Factory), damit
 * Drizzles `db.select().from(<konkreteTabelle>)`-Returntyp voll erhalten bleibt
 * — `findById`/`selectFrom` liefern den korrekten Row-Typ ohne `any`-Casts.
 * Die Factory-Variante scheitert an Drizzles `TableLikeHasEmptySelection<T>`-
 * Guard (generisches `T` erfüllt diesen Check nicht), siehe Review-Notiz.
 *
 * Neue soft-deletable Tabelle:
 *   1. Eintrag in `eslint/soft-deletable-tables.mjs` ergänzen
 *   2. Hier ein neues Repo nach demselben Muster definieren
 *
 * Die Liste in `eslint/soft-deletable-tables.mjs` ist Single Source of Truth
 * für ESLint-Regel + Architektur-Snapshot-Test.
 */
import { eq, and, isNull, type SQL } from "drizzle-orm";
import { db, type DbOrTx } from "../lib/db";
import { activeOnly, withActive } from "../lib/db-helpers";
import {
  customers,
  appointments,
  prospects,
  customerServicePrices,
  employeeTimeEntries,
  employeeDocuments,
  customerDocuments,
  monthlyServiceRecords,
  tasks,
  paymentAdvices,
  qualifications,
  employeeQualifications,
  employeeDocumentProofs,
  budgetAllocations,
} from "@shared/schema";

export { SOFT_DELETABLE_TABLE_IDENTS } from "../../eslint/soft-deletable-tables.mjs";

// -- customers -----------------------------------------------------------
export const customersRepo = {
  table: customers,
  activeOnly: (): SQL => activeOnly(customers),
  withActive: (extra?: SQL | undefined): SQL => withActive(customers, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(customers)
      .where(and(eq(customers.id, id), isNull(customers.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(customers).where(eq(customers.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(customers),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(customers),
};

// -- appointments --------------------------------------------------------
export const appointmentsRepo = {
  table: appointments,
  activeOnly: (): SQL => activeOnly(appointments),
  withActive: (extra?: SQL | undefined): SQL => withActive(appointments, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(appointments)
      .where(and(eq(appointments.id, id), isNull(appointments.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(appointments).where(eq(appointments.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(appointments),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(appointments),
};

// -- prospects -----------------------------------------------------------
export const prospectsRepo = {
  table: prospects,
  activeOnly: (): SQL => activeOnly(prospects),
  withActive: (extra?: SQL | undefined): SQL => withActive(prospects, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(prospects)
      .where(and(eq(prospects.id, id), isNull(prospects.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(prospects).where(eq(prospects.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(prospects),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(prospects),
};

// -- customerServicePrices ----------------------------------------------
export const customerServicePricesRepo = {
  table: customerServicePrices,
  activeOnly: (): SQL => activeOnly(customerServicePrices),
  withActive: (extra?: SQL | undefined): SQL => withActive(customerServicePrices, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(customerServicePrices)
      .where(and(eq(customerServicePrices.id, id), isNull(customerServicePrices.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(customerServicePrices).where(eq(customerServicePrices.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(customerServicePrices),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(customerServicePrices),
};

// -- employeeTimeEntries -------------------------------------------------
export const employeeTimeEntriesRepo = {
  table: employeeTimeEntries,
  activeOnly: (): SQL => activeOnly(employeeTimeEntries),
  withActive: (extra?: SQL | undefined): SQL => withActive(employeeTimeEntries, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(employeeTimeEntries)
      .where(and(eq(employeeTimeEntries.id, id), isNull(employeeTimeEntries.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(employeeTimeEntries).where(eq(employeeTimeEntries.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(employeeTimeEntries),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(employeeTimeEntries),
};

// -- employeeDocuments ---------------------------------------------------
export const employeeDocumentsRepo = {
  table: employeeDocuments,
  activeOnly: (): SQL => activeOnly(employeeDocuments),
  withActive: (extra?: SQL | undefined): SQL => withActive(employeeDocuments, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(employeeDocuments)
      .where(and(eq(employeeDocuments.id, id), isNull(employeeDocuments.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(employeeDocuments).where(eq(employeeDocuments.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(employeeDocuments),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(employeeDocuments),
};

// -- customerDocuments ---------------------------------------------------
export const customerDocumentsRepo = {
  table: customerDocuments,
  activeOnly: (): SQL => activeOnly(customerDocuments),
  withActive: (extra?: SQL | undefined): SQL => withActive(customerDocuments, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(customerDocuments)
      .where(and(eq(customerDocuments.id, id), isNull(customerDocuments.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(customerDocuments).where(eq(customerDocuments.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(customerDocuments),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(customerDocuments),
};

// -- monthlyServiceRecords -----------------------------------------------
export const monthlyServiceRecordsRepo = {
  table: monthlyServiceRecords,
  activeOnly: (): SQL => activeOnly(monthlyServiceRecords),
  withActive: (extra?: SQL | undefined): SQL => withActive(monthlyServiceRecords, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(monthlyServiceRecords)
      .where(and(eq(monthlyServiceRecords.id, id), isNull(monthlyServiceRecords.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(monthlyServiceRecords).where(eq(monthlyServiceRecords.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(monthlyServiceRecords),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(monthlyServiceRecords),
};

// -- tasks ---------------------------------------------------------------
export const tasksRepo = {
  table: tasks,
  activeOnly: (): SQL => activeOnly(tasks),
  withActive: (extra?: SQL | undefined): SQL => withActive(tasks, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(tasks)
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(tasks),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(tasks),
};

// -- paymentAdvices ------------------------------------------------------
export const paymentAdvicesRepo = {
  table: paymentAdvices,
  activeOnly: (): SQL => activeOnly(paymentAdvices),
  withActive: (extra?: SQL | undefined): SQL => withActive(paymentAdvices, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(paymentAdvices)
      .where(and(eq(paymentAdvices.id, id), isNull(paymentAdvices.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(paymentAdvices).where(eq(paymentAdvices.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(paymentAdvices),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(paymentAdvices),
};

// -- qualifications ------------------------------------------------------
export const qualificationsRepo = {
  table: qualifications,
  activeOnly: (): SQL => activeOnly(qualifications),
  withActive: (extra?: SQL | undefined): SQL => withActive(qualifications, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(qualifications)
      .where(and(eq(qualifications.id, id), isNull(qualifications.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(qualifications).where(eq(qualifications.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(qualifications),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(qualifications),
};

// -- employeeQualifications ----------------------------------------------
export const employeeQualificationsRepo = {
  table: employeeQualifications,
  activeOnly: (): SQL => activeOnly(employeeQualifications),
  withActive: (extra?: SQL | undefined): SQL => withActive(employeeQualifications, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(employeeQualifications)
      .where(and(eq(employeeQualifications.id, id), isNull(employeeQualifications.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(employeeQualifications).where(eq(employeeQualifications.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(employeeQualifications),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(employeeQualifications),
};

// -- employeeDocumentProofs ----------------------------------------------
export const employeeDocumentProofsRepo = {
  table: employeeDocumentProofs,
  activeOnly: (): SQL => activeOnly(employeeDocumentProofs),
  withActive: (extra?: SQL | undefined): SQL => withActive(employeeDocumentProofs, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(employeeDocumentProofs)
      .where(and(eq(employeeDocumentProofs.id, id), isNull(employeeDocumentProofs.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(employeeDocumentProofs).where(eq(employeeDocumentProofs.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(employeeDocumentProofs),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(employeeDocumentProofs),
};

// -- budgetAllocations ---------------------------------------------------
export const budgetAllocationsRepo = {
  table: budgetAllocations,
  activeOnly: (): SQL => activeOnly(budgetAllocations),
  withActive: (extra?: SQL | undefined): SQL => withActive(budgetAllocations, extra),
  async findById(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(budgetAllocations)
      .where(and(eq(budgetAllocations.id, id), isNull(budgetAllocations.deletedAt))).limit(1);
    return rows[0] ?? null;
  },
  async findByIdIncludingDeleted(id: number, tx: DbOrTx = db) {
    const rows = await tx.select().from(budgetAllocations).where(eq(budgetAllocations.id, id)).limit(1);
    return rows[0] ?? null;
  },
  selectFrom: (tx: DbOrTx = db) => tx.select().from(budgetAllocations),
  selectColumnsFrom: <C extends Parameters<DbOrTx["select"]>[0] & object>(columns: C, tx: DbOrTx = db) =>
    tx.select(columns).from(budgetAllocations),
};
