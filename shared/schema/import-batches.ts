import { pgTable, text, integer, serial, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { timestamp } from "./common";
import { users } from "./users";

/**
 * Task #819 — Import-Batch-Protokoll.
 *
 * Jeder ausgeführte Excel-Import erzeugt einen `import_batches`-Eintrag. Der
 * `file_hash` (SHA-256 des hochgeladenen Datei-Puffers) erlaubt das Erkennen
 * von Doppel-Importen derselben Datei (GoBD-Nachvollziehbarkeit). Die
 * erzeugten/aktualisierten Termine und Budget-Buchungen referenzieren den
 * Batch über `import_batch_id`, sodass ein kompletter Import-Lauf jederzeit
 * forensisch rekonstruierbar ist.
 */
export const importBatches = pgTable("import_batches", {
  id: serial("id").primaryKey(),
  fileName: text("file_name"),
  fileHash: text("file_hash").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  importedCount: integer("imported_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
}, (table) => [
  index("import_batches_file_hash_idx").on(table.fileHash),
  uniqueIndex("import_batches_id_idx").on(table.id),
]);

export const insertImportBatchSchema = createInsertSchema(importBatches).omit({
  id: true,
  createdAt: true,
});

export type ImportBatch = typeof importBatches.$inferSelect;
export type InsertImportBatch = z.infer<typeof insertImportBatchSchema>;
