/**
 * Task #447 — Single Source of Truth: Schema-Identifier aller soft-deletable
 * Tabellen (= `pgTable("...", ...)`-Variablenname). Wird sowohl von der ESLint-
 * Regel `restrictSoftDeleteFrom` (`eslint.config.js`) als auch vom Architektur-
 * Test (`tests/architecture/soft-delete-coverage.test.ts`) und dem Repo-Index
 * (`server/repos/index.ts`) konsumiert. Neue Tabelle mit `deletedAt`-Spalte?
 * Hier eintragen — die anderen Layer ziehen automatisch nach.
 */
export const SOFT_DELETABLE_TABLE_IDENTS = Object.freeze([
  "customers",
  "appointments",
  "prospects",
  "customerServicePrices",
  "employeeTimeEntries",
  "employeeDocuments",
  "customerDocuments",
  "monthlyServiceRecords",
  "tasks",
  "paymentAdvices",
  "qualifications",
  "employeeQualifications",
  "employeeDocumentProofs",
  "budgetAllocations",
]);
