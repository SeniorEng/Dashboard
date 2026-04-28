import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { documentStorage } from "../server/storage/documents";
import { createTask } from "../server/storage/tasks";
import {
  documentTemplates,
  generatedDocuments,
  documentSigningTokens,
  tasks,
  users,
} from "../shared/schema";

const SLUG_PREFIX = "test-tx-tpl-";
const FILE_PREFIX = "test-tx-doc-";

let templateId: number;
let adminUserId: number;
const createdDocIds: number[] = [];
const createdTokenIds: number[] = [];
const createdTaskIds: number[] = [];

beforeAll(async () => {
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1);
  expect(admin).toBeDefined();
  adminUserId = admin.id;

  const slug = `${SLUG_PREFIX}${Date.now()}`;
  const [tpl] = await db
    .insert(documentTemplates)
    .values({
      slug,
      name: "TX-Regression-Template",
      htmlContent: "<p>test</p>",
      version: 1,
      isSystem: false,
      isActive: true,
      context: "beide",
      targetType: "employee",
      requiresCustomerSignature: false,
      requiresEmployeeSignature: true,
    })
    .returning();
  templateId = tpl.id;
});

afterAll(async () => {
  if (createdTaskIds.length > 0) {
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (createdTokenIds.length > 0) {
    await db.delete(documentSigningTokens).where(inArray(documentSigningTokens.id, createdTokenIds));
  }
  if (createdDocIds.length > 0) {
    await db.delete(generatedDocuments).where(inArray(generatedDocuments.id, createdDocIds));
  }
  if (templateId) {
    await db.delete(documentTemplates).where(eq(documentTemplates.id, templateId));
  }
});

async function seedDocAndToken(): Promise<{ docId: number; tokenId: number }> {
  const [doc] = await db
    .insert(generatedDocuments)
    .values({
      employeeId: adminUserId,
      templateId,
      templateVersion: 1,
      fileName: `${FILE_PREFIX}${Date.now()}-${Math.random()}.pdf`,
      objectPath: `/.private/${FILE_PREFIX}${Date.now()}.pdf`,
      renderedHtml: "<p>x</p>",
      signingStatus: "pending_employee_signature",
      generatedByUserId: adminUserId,
    })
    .returning();
  createdDocIds.push(doc.id);

  const [tok] = await db
    .insert(documentSigningTokens)
    .values({
      documentId: doc.id,
      tokenHash: `txtest-${Date.now()}-${Math.random()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  createdTokenIds.push(tok.id);

  return { docId: doc.id, tokenId: tok.id };
}

describe("F8-TX – Public-Signing Transaktion (Regression)", () => {
  it("F8-TX.1 – markSigningTokenUsed: zweiter Aufruf liefert false (atomarer Claim)", async () => {
    const { tokenId } = await seedDocAndToken();
    const first = await documentStorage.markSigningTokenUsed(tokenId);
    const second = await documentStorage.markSigningTokenUsed(tokenId);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("F8-TX.2 – updateGeneratedDocumentAfterSigning respektiert Status-Lock (zweiter Aufruf liefert null)", async () => {
    const { docId } = await seedDocAndToken();
    const first = await documentStorage.updateGeneratedDocumentAfterSigning(
      docId,
      "data:image/png;base64,AAA",
      "hash1",
      "/.private/x.pdf",
      "x.pdf",
      "127.0.0.1",
      null,
    );
    const second = await documentStorage.updateGeneratedDocumentAfterSigning(
      docId,
      "data:image/png;base64,BBB",
      "hash2",
      "/.private/y.pdf",
      "y.pdf",
      "127.0.0.1",
      null,
    );
    expect(first).not.toBeNull();
    expect(first!.signingStatus).toBe("complete");
    expect(second).toBeNull();
  });

  it("F8-TX.3 – Atomare Transaktion: Token-Claim, Doc-Update und Task-Insert schlagen gemeinsam fehl bei Rollback", async () => {
    const { docId, tokenId } = await seedDocAndToken();

    // Manually pre-mark the document as complete to simulate concurrent winning request.
    await db
      .update(generatedDocuments)
      .set({ signingStatus: "complete", signedAt: new Date() })
      .where(eq(generatedDocuments.id, docId));

    let txTaskId: number | null = null;
    const result = await db.transaction(async (tx) => {
      const claimed = await documentStorage.markSigningTokenUsed(tokenId, tx);
      expect(claimed).toBe(true);

      const updated = await documentStorage.updateGeneratedDocumentAfterSigning(
        docId, "sig", "hash", "/.private/z.pdf", "z.pdf", null, null, tx,
      );
      if (!updated) {
        const t = await createTask({
          title: "Should-Be-Rolled-Back",
          assignedToUserId: adminUserId,
          priority: "low",
        }, adminUserId, tx);
        txTaskId = t.id;
        throw new Error("__TEST_ROLLBACK__");
      }
      return updated;
    }).catch((err: unknown) => {
      if (err instanceof Error && err.message === "__TEST_ROLLBACK__") return null;
      throw err;
    });

    expect(result).toBeNull();
    expect(txTaskId).not.toBeNull();

    // Rollback verification: the task that was inserted inside the rolled-back tx must NOT exist.
    const [stillThere] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, txTaskId!)).limit(1);
    expect(stillThere).toBeUndefined();

    // Token-claim must also have been rolled back (usedAt back to NULL).
    const [tok] = await db.select({ usedAt: documentSigningTokens.usedAt }).from(documentSigningTokens).where(eq(documentSigningTokens.id, tokenId)).limit(1);
    expect(tok.usedAt).toBeNull();
  });
});
