/**
 * Task #1067 — End-to-End-Verifikation des Self-Heal-Pfads für fehlende
 * Rechnungs-PDF-Objekte (`persistInvoicePdf` → `storedObjectIsMissing` →
 * `persistInvoicePdfInner` → ggf. `logPdfReseal`).
 *
 * Kontext
 * -------
 * Task #1066 hat einen Self-Heal eingebaut: Zeigt ein bereits versiegelter
 * `pdf_path` ins Leere (Object-Storage-Objekt fehlt — z.B. nach der
 * Legacy-Key-Space-Migration oder einem gelöschten Bucket-Objekt), wird das
 * Artefakt aus dem eingefrorenen `render_snapshot` neu gerendert statt einen
 * 404 auszuliefern.
 *
 *   - Rechnungen ab #1047 (eingefrorener `pdfCreationDate`) reproduzieren beim
 *     Re-Render den versiegelten `pdf_hash` BYTE-GENAU → kein Audit-Reseal.
 *   - Pre-#1047-Bestand (kein eingefrorener Erzeugungszeitpunkt) bekommt einen
 *     frischen Zeitstempel → `pdf_hash` ändert sich → die geänderte
 *     Versiegelung wird per `invoice_pdf_reseal_on_recovery` im Audit-Log
 *     dokumentiert (NIEMALS still).
 *
 * Test-Strategie
 * --------------
 * Im Gegensatz zur Clobbered-PDF-Restore-Suite (Task #1043, injizierter
 * Re-Render) läuft dieser Test über den ECHTEN Render-Pfad (Chromium +
 * node-zugferd): Eine Rechnung wird angelegt, via `persistInvoicePdf`
 * versiegelt, das Object-Storage-Objekt gelöscht und `persistInvoicePdf`
 * erneut aufgerufen. Verifiziert wird, dass das Objekt byte-genau (bzw. bei
 * Legacy-Bestand inhaltsgleich mit Reseal-Audit) wiederhergestellt wird.
 *
 * Hinweis zur Isolation: Das Object-Storage ist NICHT pro Test-DB isoliert
 * (nur die DB ist es). Deshalb werden eindeutige Rechnungsnummern verwendet
 * (kein Bucket-Clobbering) und die Objekte am Ende best-effort gelöscht.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  auditLog,
  invoices as invoicesTable,
  users,
  type InvoiceRenderSnapshot,
} from "@shared/schema";
import { storage } from "../../server/storage";
import { persistInvoicePdf } from "../../server/services/invoice-pdf-orchestrator";
import { computeDataHash } from "../../server/services/signature-integrity";
import { createInvoiceTx } from "../../server/storage/billing-storage";
import {
  getPrivateDir,
  parseObjectPath,
} from "../../server/lib/object-storage-helpers";
import { objectStorageClient } from "../../server/replit_integrations/object_storage/objectStorage";
import {
  apiPost,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";

const YEAR = 2026;
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

const RESEAL_ACTION = "invoice_pdf_reseal_on_recovery";

function uniqueInvoiceNumber(): string {
  return `RE-${YEAR}-T1067-${uniqueId()}`.replace(/[^a-z0-9_-]/gi, "_");
}

// --- Object-Storage-Helfer (Pfad → Bucket/Objekt) ---------------------------

function resolveObject(storedPath: string): { bucketName: string; objectName: string } {
  let key = storedPath;
  if (key.startsWith("/objects/")) key = key.slice("/objects/".length);
  let dir = getPrivateDir();
  if (!dir.endsWith("/")) dir = `${dir}/`;
  return parseObjectPath(`${dir}${key}`);
}

async function readObject(storedPath: string): Promise<Buffer | null> {
  const { bucketName, objectName } = resolveObject(storedPath);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return Buffer.from(contents);
}

async function deleteObject(storedPath: string): Promise<void> {
  const { bucketName, objectName } = resolveObject(storedPath);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (exists) await file.delete();
}

async function countResealAudits(invoiceId: number, artifact: string): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.action, RESEAL_ACTION), eq(auditLog.entityId, invoiceId)));
  return rows.filter((r) => (r.metadata as Record<string, unknown> | null)?.artifact === artifact)
    .length;
}

describe("Task #1067 — Self-Heal: fehlendes Rechnungs-PDF-Objekt wird neu gerendert", () => {
  let superadminId: number;
  let postFixCustomerId: number;
  let postFixInvoiceId: number;
  let legacyCustomerId: number;
  let legacyInvoiceId: number;
  const createdInvoiceIds: number[] = [];
  const createdObjectPaths: string[] = [];

  async function seedCustomer(label: string, telefon: string): Promise<number> {
    const res = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "SelfHeal",
      nachname: `${label}-${uniqueId()}`,
      geburtsdatum: "1940-05-05",
      email: `selfheal-${label.toLowerCase()}-${uniqueId()}@test.local`,
      strasse: "Heilweg",
      nr: "1",
      plz: "01067",
      stadt: "Dresden",
      telefon,
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      beihilfeBerechtigt: false,
    });
    expect(res.status, `create customer ${label}: ${JSON.stringify(res.data)}`).toBe(201);
    return res.data.id;
  }

  async function seedInvoice(customerId: number): Promise<number> {
    const inv = await db.transaction(async (tx) =>
      createInvoiceTx(
        tx,
        {
          invoiceNumber: uniqueInvoiceNumber(),
          customerId,
          billingType: "pflegekasse_gesetzlich",
          invoiceType: "rechnung",
          billingMonth: MONTH,
          billingYear: YEAR,
          recipientName: "Pflegekasse Test",
          recipientAddress: "Kassenweg 1, 01067 Dresden",
          customerName: "Self Heal",
          pflegegrad: 3,
          netAmountCents: 5000,
          vatAmountCents: 0,
          grossAmountCents: 5000,
          vatRate: 0,
          status: "entwurf",
          budgetType: "entlastungsbetrag_45b",
        },
        [
          {
            appointmentId: null,
            appointmentDate: APPT_DATE,
            serviceDescription: "Alltagsbegleitung",
            serviceCode: "alltagsbegleitung",
            durationMinutes: 30,
            unitPriceCents: 5000,
            totalCents: 5000,
            employeeName: "Erik",
          },
        ],
        superadminId,
      ),
    );
    createdInvoiceIds.push(inv.id);
    return inv.id;
  }

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .limit(1);
    superadminId = admin?.id ?? auth.user.id;

    postFixCustomerId = await seedCustomer("Post1047", "+4917600000020");
    postFixInvoiceId = await seedInvoice(postFixCustomerId);

    legacyCustomerId = await seedCustomer("Legacy", "+4917600000021");
    legacyInvoiceId = await seedInvoice(legacyCustomerId);

    // Versiegeln: rendert + speichert die PDFs, friert pdfCreationDate im
    // render_snapshot ein und schreibt pdf_hash.
    await persistInvoicePdf(postFixInvoiceId);
    await persistInvoicePdf(legacyInvoiceId);

    for (const id of [postFixInvoiceId, legacyInvoiceId]) {
      const inv = await storage.getInvoice(id);
      if (inv?.pdfPath) createdObjectPaths.push(inv.pdfPath);
      if (inv?.leistungsnachweisPath) createdObjectPaths.push(inv.leistungsnachweisPath);
    }
  }, 240_000);

  afterAll(async () => {
    for (const p of createdObjectPaths) {
      try {
        await deleteObject(p);
      } catch {
        /* best-effort */
      }
    }
    for (const id of createdInvoiceIds) {
      try {
        await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
      } catch {
        /* best-effort */
      }
    }
    await cleanupCustomer(postFixCustomerId);
    await cleanupCustomer(legacyCustomerId);
    await runCleanup();
  });

  it("post-#1047: gelöschtes Objekt wird byte-genau wiederhergestellt, pdf_hash unverändert, KEIN Reseal-Audit", async () => {
    const before = await storage.getInvoice(postFixInvoiceId);
    expect(before, "Rechnung muss existieren").toBeTruthy();
    expect(before!.pdfPath, "pdf_path muss versiegelt sein").toBeTruthy();
    expect(before!.pdfHash, "pdf_hash muss versiegelt sein").toBeTruthy();
    const snapshot = before!.renderSnapshot as InvoiceRenderSnapshot;
    expect(snapshot?.pdfCreationDate, "pdfCreationDate muss eingefroren sein (post-#1047)").toBeTruthy();

    const sealedHash = before!.pdfHash!;
    const pdfPath = before!.pdfPath!;

    // Vorher: Objekt existiert.
    expect(await readObject(pdfPath), "Objekt muss vor dem Löschen existieren").not.toBeNull();
    const resealBefore = await countResealAudits(postFixInvoiceId, "invoice");

    // Object-Storage-Objekt löschen (simuliert fehlendes/gelöschtes Artefakt).
    await deleteObject(pdfPath);
    expect(await readObject(pdfPath), "Objekt muss nach dem Löschen fehlen").toBeNull();

    // Self-Heal: re-rendert aus dem eingefrorenen Snapshot.
    await persistInvoicePdf(postFixInvoiceId);

    // Objekt ist wiederhergestellt …
    const restored = await readObject(pdfPath);
    expect(restored, "Objekt muss self-healed wiederhergestellt sein").not.toBeNull();
    // … und byte-genau (reproduziert den versiegelten Hash).
    expect(computeDataHash(restored as unknown as string)).toBe(sealedHash);

    // pdf_hash in der DB bleibt unverändert (gleiche Versiegelung).
    const after = await storage.getInvoice(postFixInvoiceId);
    expect(after!.pdfHash).toBe(sealedHash);
    expect(after!.pdfPath).toBe(pdfPath);

    // KEIN neuer Reseal-Audit-Eintrag (byte-genaue Reproduktion).
    const resealAfter = await countResealAudits(postFixInvoiceId, "invoice");
    expect(resealAfter).toBe(resealBefore);
  }, 240_000);

  it("legacy (kein pdfCreationDate): Objekt wird inhaltsgleich neu gerendert, pdf_hash ändert sich, Reseal wird auditiert", async () => {
    const sealed = await storage.getInvoice(legacyInvoiceId);
    expect(sealed, "Rechnung muss existieren").toBeTruthy();
    const pdfPath = sealed!.pdfPath!;
    const sealedHash = sealed!.pdfHash!;
    expect(pdfPath).toBeTruthy();
    expect(sealedHash).toBeTruthy();

    // Pre-#1047-Bestand simulieren: den eingefrorenen Erzeugungszeitpunkt aus
    // dem render_snapshot entfernen. Der restliche Snapshot (Company/Kunde/
    // Rechnung) bleibt erhalten → der Re-Render ist deterministisch bis auf den
    // dann frischen Zeitstempel. UPDATE auf Rechnungen ist trigger-erlaubt.
    const fullSnapshot = sealed!.renderSnapshot as InvoiceRenderSnapshot;
    expect(fullSnapshot?.pdfCreationDate, "Setup-Vorbedingung: Snapshot hat anfangs pdfCreationDate").toBeTruthy();
    const { pdfCreationDate: _drop, ...legacySnapshot } = fullSnapshot;
    void _drop;
    await db
      .update(invoicesTable)
      .set({ renderSnapshot: legacySnapshot as InvoiceRenderSnapshot })
      .where(eq(invoicesTable.id, legacyInvoiceId));

    const resealBefore = await countResealAudits(legacyInvoiceId, "invoice");

    // Object-Storage-Objekt löschen.
    await deleteObject(pdfPath);
    expect(await readObject(pdfPath)).toBeNull();

    // Self-Heal: re-rendert ohne eingefrorenen Zeitstempel → frischer
    // Erzeugungszeitpunkt → andere Bytes.
    await persistInvoicePdf(legacyInvoiceId);

    // Objekt ist wiederhergestellt.
    const restored = await readObject(pdfPath);
    expect(restored, "Objekt muss self-healed wiederhergestellt sein").not.toBeNull();
    const newHash = computeDataHash(restored as unknown as string);

    // pdf_hash hat sich geändert (frischer Zeitstempel) …
    expect(newHash).not.toBe(sealedHash);
    const after = await storage.getInvoice(legacyInvoiceId);
    expect(after!.pdfHash).toBe(newHash);

    // … und die geänderte Versiegelung ist als Audit-Eintrag dokumentiert.
    const resealAfter = await countResealAudits(legacyInvoiceId, "invoice");
    expect(resealAfter).toBe(resealBefore + 1);

    const resealRows = await db
      .select({ metadata: auditLog.metadata, entityType: auditLog.entityType })
      .from(auditLog)
      .where(and(eq(auditLog.action, RESEAL_ACTION), eq(auditLog.entityId, legacyInvoiceId)));
    const invoiceReseal = resealRows.find(
      (r) => (r.metadata as Record<string, unknown> | null)?.artifact === "invoice",
    );
    expect(invoiceReseal, "Reseal-Audit für das Invoice-Artefakt muss existieren").toBeTruthy();
    expect(invoiceReseal!.entityType).toBe("invoice");
    const meta = invoiceReseal!.metadata as Record<string, unknown>;
    expect(meta.oldHash).toBe(sealedHash);
    expect(meta.newHash).toBe(newHash);
    expect(meta.invoiceNumber).toBe(sealed!.invoiceNumber);
  }, 240_000);
});
