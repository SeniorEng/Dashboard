import { db } from "../lib/db";
import { importBatches, type ImportBatch, type InsertImportBatch } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

/**
 * Task #819 — Storage-Layer für Import-Batch-Protokoll.
 */
export const importBatchesStorage = {
  async create(data: InsertImportBatch): Promise<ImportBatch> {
    const [row] = await db.insert(importBatches).values(data).returning();
    return row;
  },

  async list(limit = 50): Promise<ImportBatch[]> {
    return db
      .select()
      .from(importBatches)
      .orderBy(desc(importBatches.createdAt))
      .limit(limit);
  },

  async updateCounts(
    id: number,
    counts: { importedCount: number; updatedCount: number; skippedCount: number },
  ): Promise<void> {
    await db.update(importBatches).set(counts).where(eq(importBatches.id, id));
  },

  async findByHash(fileHash: string): Promise<ImportBatch | null> {
    const [row] = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.fileHash, fileHash))
      .orderBy(desc(importBatches.createdAt))
      .limit(1);
    return row ?? null;
  },
};
