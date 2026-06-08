/**
 * Task #1050 — Verifikation des Legacy-PDF-Restore aus Backup
 * (`restoreLegacyInvoicePdfsFromBackup`).
 *
 * Kontext
 * -------
 * PDFs aus der „Wall-Clock-Ära" (pre-#1047) tragen KEINEN versiegelten
 * `pdfCreationDate` im `render_snapshot`. Ihr Re-Render reproduziert den
 * versiegelten `pdf_hash` daher NIE byte-genau — `regenerate-clobbered-invoice-
 * pdfs.ts` kann sie nur FLAGGEN. Dieser Pfad stellt stattdessen die ORIGINAL-
 * Bytes aus einem Backup-Verzeichnis wieder her, aber NUR wenn die Backup-Bytes
 * den versiegelten `pdf_hash` byte-genau reproduzieren.
 *
 * Test-Strategie
 * --------------
 *   1. REINE Entscheidungslogik (`isLegacyInvoice`, `decideBackupRestore`) +
 *      Backup-Datei-Lookup (`loadBackupBytes` gegen ein echtes Temp-Verzeichnis).
 *   2. INTEGRATION mit echtem Object Storage + INJIZIERTEM Backup-Loader: der
 *      Download/Klassifikation/Hash-Gate/Restore/Audit-Pfad läuft gegen einen
 *      geseedeten Legacy-Rechnungs-Datensatz + reale Bucket-Objekte vollständig
 *      durch, ohne vom Dateisystem abzuhängen.
 *
 * Hinweis (Memory): Object Storage ist NICHT pro Ephemeral-Test-DB isoliert —
 * dieser Test schreibt nur auf den Rechnungs-spezifischen Key seines eigenen
 * geseedeten Datensatzes und räumt ihn wieder auf.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  auditLog,
  invoices as invoicesTable,
  users,
  type InvoiceRenderSnapshot,
} from "@shared/schema";
import {
  decideBackupRestore,
  isLegacyInvoice,
  loadBackupBytes,
  restoreLegacyInvoicePdfsFromBackup,
} from "../../server/scripts/restore-legacy-invoice-pdfs-from-backup";
import { createInvoiceTx, getNextInvoiceNumberTx } from "../../server/storage/billing-storage";
import { computeDataHash } from "../../server/services/signature-integrity";
import { objectStorageClient } from "../../server/replit_integrations/object_storage/objectStorage";
import {
  buildInvoicePdfObjectKey,
  getPrivateDir,
  parseObjectPath,
} from "../../server/lib/object-storage-helpers";
import { apiPost, cleanupCustomer, getAuthCookie, runCleanup, uniqueId } from "../test-utils";

// --- Reine Entscheidungslogik -------------------------------------------------

describe("isLegacyInvoice", () => {
  it("false, wenn kein Snapshot vorhanden ist", () => {
    expect(isLegacyInvoice(null)).toBe(false);
  });

  it("false (modern), wenn der Snapshot einen versiegelten pdfCreationDate trägt", () => {
    const snap = { pdfCreationDate: "2026-04-15T10:00:00.000Z" } as InvoiceRenderSnapshot;
    expect(isLegacyInvoice(snap)).toBe(false);
  });

  it("true (legacy), wenn der Snapshot existiert aber pdfCreationDate fehlt", () => {
    const snap = {} as InvoiceRenderSnapshot;
    expect(isLegacyInvoice(snap)).toBe(true);
  });
});

describe("decideBackupRestore", () => {
  it("flag-no-backup, wenn kein Backup-Original gefunden wurde", () => {
    expect(decideBackupRestore({ backupHash: null, expectedHash: "abc" })).toBe("flag-no-backup");
  });

  it("restore NUR bei byte-genauer Hash-Reproduktion", () => {
    expect(decideBackupRestore({ backupHash: "abc", expectedHash: "abc" })).toBe("restore");
  });

  it("flag-hash-mismatch, wenn das Backup den versiegelten Hash nicht reproduziert", () => {
    expect(decideBackupRestore({ backupHash: "xyz", expectedHash: "abc" })).toBe(
      "flag-hash-mismatch",
    );
  });
});

describe("loadBackupBytes (Dateisystem-Lookup)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-backup-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("null, wenn kein Backup-Verzeichnis konfiguriert ist (Census)", () => {
    expect(loadBackupBytes(undefined, "invoices/RE-X.pdf")).toBeNull();
  });

  it("null, wenn die Datei nicht existiert", () => {
    expect(loadBackupBytes(dir, "invoices/does-not-exist.pdf")).toBeNull();
  });

  it("findet die Datei über den vollen Object-Key", () => {
    const key = "invoices/RE-FULLKEY.pdf";
    fs.mkdirSync(path.join(dir, "invoices"), { recursive: true });
    fs.writeFileSync(path.join(dir, key), Buffer.from("full-key-bytes"));
    const found = loadBackupBytes(dir, key);
    expect(found?.bytes.toString()).toBe("full-key-bytes");
  });

  it("findet die Datei über den Basename als Fallback", () => {
    fs.writeFileSync(path.join(dir, "RE-BASENAME.pdf"), Buffer.from("basename-bytes"));
    const found = loadBackupBytes(dir, "invoices/RE-BASENAME.pdf");
    expect(found?.bytes.toString()).toBe("basename-bytes");
  });
});

// --- Integration: Download / Restore / Audit ---------------------------------

const YEAR = 2026;
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

const ORIGINAL_PDF_BYTES = Buffer.from("%PDF-1.4\nlegacy-original-good\n%%EOF\n", "utf-8");
const WRONG_BACKUP_BYTES = Buffer.from("%PDF-1.4\nwrong-backup-version\n%%EOF\n", "utf-8");
const GARBAGE_BYTES = Buffer.from("dev-test-run-clobbered-this-object", "utf-8");

const ORIGINAL_HASH = computeDataHash(ORIGINAL_PDF_BYTES as unknown as string);
const BACKUP_DIR = "tmp/legacy-backup-injected";

function resolveObject(storedPath: string): { bucketName: string; objectName: string } {
  let key = storedPath;
  if (key.startsWith("/objects/")) key = key.slice("/objects/".length);
  let dir = getPrivateDir();
  if (!dir.endsWith("/")) dir = `${dir}/`;
  return parseObjectPath(`${dir}${key}`);
}

async function writeObject(storedPath: string, bytes: Buffer): Promise<void> {
  const { bucketName, objectName } = resolveObject(storedPath);
  await objectStorageClient.bucket(bucketName).file(objectName).save(bytes, {
    contentType: "application/pdf",
  });
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

describe("restoreLegacyInvoicePdfsFromBackup — Object-Restore", () => {
  let customerId: number;
  let superadminId: number;
  let invoiceId: number;
  let invoiceNumber: string;
  let pdfPath: string;

  // Injizierter Backup-Loader: liefert die ORIGINAL-Bytes (Happy-Path).
  const loadMatching = () => ({ bytes: ORIGINAL_PDF_BYTES, path: `${BACKUP_DIR}/original.pdf` });
  // Injizierter Backup-Loader: liefert ABWEICHENDE Bytes (Hash-Mismatch).
  const loadWrong = () => ({ bytes: WRONG_BACKUP_BYTES, path: `${BACKUP_DIR}/wrong.pdf` });
  // Injizierter Backup-Loader: kein Backup gefunden.
  const loadNone = () => null;

  async function seedSnapshot(opts: { legacy: boolean }): Promise<void> {
    const snapshot: InvoiceRenderSnapshot = {
      companySettings: {} as InvoiceRenderSnapshot["companySettings"],
      customer: {
        geburtsdatum: "1940-05-05",
        beihilfeBerechtigt: false,
        rechnungAnKunde: false,
        name: "Legacy Restore",
        vorname: "Legacy",
        nachname: "Restore",
        strasse: "Altweg",
        nr: "1",
        plz: "01067",
        stadt: "Dresden",
      },
      // Modern (post-#1047) trägt einen versiegelten pdfCreationDate; Legacy nicht.
      ...(opts.legacy ? {} : { pdfCreationDate: "2026-04-15T10:00:00.000Z" }),
    };
    await db
      .update(invoicesTable)
      .set({ pdfPath, pdfHash: ORIGINAL_HASH, renderSnapshot: snapshot })
      .where(eq(invoicesTable.id, invoiceId));
  }

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .limit(1);
    superadminId = admin?.id ?? auth.user.id;

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Legacy",
      nachname: `Restore-${uniqueId()}`,
      geburtsdatum: "1940-05-05",
      email: `legacy-${uniqueId()}@test.local`,
      strasse: "Altweg",
      nr: "1",
      plz: "01067",
      stadt: "Dresden",
      telefon: "+4917600000007",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    const seeded = await db.transaction(async (tx) => {
      const num = await getNextInvoiceNumberTx(tx, YEAR);
      const inv = await createInvoiceTx(
        tx,
        {
          invoiceNumber: num,
          customerId,
          billingType: "pflegekasse_gesetzlich",
          invoiceType: "rechnung",
          billingMonth: MONTH,
          billingYear: YEAR,
          recipientName: "Pflegekasse Test",
          recipientAddress: "Kassenweg 1, 01067 Dresden",
          customerName: "Legacy Restore",
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
      );
      return inv;
    });
    invoiceId = seeded.id;
    invoiceNumber = seeded.invoiceNumber;

    const safeNumber = invoiceNumber.replace(/[^a-z0-9_-]/gi, "_");
    pdfPath = `/objects/${buildInvoicePdfObjectKey(safeNumber)}`;

    // Default: Legacy-Snapshot (kein pdfCreationDate).
    await seedSnapshot({ legacy: true });
  }, 120_000);

  afterAll(async () => {
    try {
      await deleteObject(pdfPath);
    } catch {
      /* best-effort */
    }
    await cleanupCustomer(customerId);
    await runCleanup();
  });

  it("intaktes Legacy-Objekt → alreadyCorrect, kein Backup-Lookup, kein Schreiben", async () => {
    await seedSnapshot({ legacy: true });
    await writeObject(pdfPath, ORIGINAL_PDF_BYTES);

    let lookedUp = false;
    const summary = await restoreLegacyInvoicePdfsFromBackup({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Legacy-Restore Test intakt",
      backupDir: BACKUP_DIR,
      loadBackup: () => {
        lookedUp = true;
        return loadMatching();
      },
    });

    expect(summary.checked).toBe(1);
    expect(summary.alreadyCorrect).toBe(1);
    expect(summary.restoredFromBackup).toBe(0);
    expect(lookedUp).toBe(false);
    expect(await readObject(pdfPath)).toEqual(ORIGINAL_PDF_BYTES);
  }, 120_000);

  it("verklobbert + passendes Backup, Trockenlauf → reparierbar, nichts geschrieben", async () => {
    await seedSnapshot({ legacy: true });
    await writeObject(pdfPath, GARBAGE_BYTES);

    const summary = await restoreLegacyInvoicePdfsFromBackup({
      apply: false,
      customerIds: [customerId],
      invoiceIds: [],
      backupDir: BACKUP_DIR,
      loadBackup: loadMatching,
    });

    expect(summary.checked).toBe(1);
    expect(summary.restoredFromBackup).toBe(1);
    expect(summary.outcomes[0].storedState).toBe("mismatch");
    expect(summary.outcomes[0].decision).toBe("restore");
    expect(summary.outcomes[0].restored).toBe(false);
    // Trockenlauf: Objekt bleibt verklobbert.
    expect(await readObject(pdfPath)).toEqual(GARBAGE_BYTES);
  }, 120_000);

  it("verklobbert + passendes Backup, Scharflauf → byte-genau wiederhergestellt + Audit", async () => {
    await seedSnapshot({ legacy: true });
    await writeObject(pdfPath, GARBAGE_BYTES);

    const summary = await restoreLegacyInvoicePdfsFromBackup({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Legacy-Restore Test scharf (Task #1050 Verifikation)",
      backupDir: BACKUP_DIR,
      loadBackup: loadMatching,
    });

    expect(summary.restoredFromBackup).toBe(1);
    expect(summary.outcomes[0].restored).toBe(true);
    const restored = await readObject(pdfPath);
    expect(restored).toEqual(ORIGINAL_PDF_BYTES);
    expect(computeDataHash(restored as unknown as string)).toBe(ORIGINAL_HASH);

    // Append-only-Audit dokumentiert die Wiederherstellung (GoBD).
    const audits = await db
      .select({
        metadata: auditLog.metadata,
        userId: auditLog.userId,
        entityType: auditLog.entityType,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invoice_pdf_restored_from_backup"),
          eq(auditLog.entityId, invoiceId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe("invoice");
    expect(audits[0].userId).toBe(superadminId);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.task).toBe("#1050");
    expect(meta.invoiceNumber).toBe(invoiceNumber);
  }, 120_000);

  it("verklobbert + abweichendes Backup → flag-hash-mismatch, Objekt unberührt, kein Audit", async () => {
    await seedSnapshot({ legacy: true });
    await writeObject(pdfPath, GARBAGE_BYTES);
    const before = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invoice_pdf_restored_from_backup"),
          eq(auditLog.entityId, invoiceId),
        ),
      );

    const summary = await restoreLegacyInvoicePdfsFromBackup({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Legacy-Restore Test Hash-Mismatch",
      backupDir: BACKUP_DIR,
      loadBackup: loadWrong,
    });

    expect(summary.restoredFromBackup).toBe(0);
    expect(summary.flaggedHashMismatch).toBe(1);
    expect(summary.outcomes[0].decision).toBe("flag-hash-mismatch");
    expect(summary.outcomes[0].flagReason).toBeTruthy();
    // Niemals blind überschreiben: Objekt bleibt verklobbert.
    expect(await readObject(pdfPath)).toEqual(GARBAGE_BYTES);

    const after = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invoice_pdf_restored_from_backup"),
          eq(auditLog.entityId, invoiceId),
        ),
      );
    expect(after.length).toBe(before.length);
  }, 120_000);

  it("verklobbert + kein Backup → flag-no-backup, Objekt unberührt", async () => {
    await seedSnapshot({ legacy: true });
    await writeObject(pdfPath, GARBAGE_BYTES);

    const summary = await restoreLegacyInvoicePdfsFromBackup({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Legacy-Restore Test kein Backup",
      backupDir: BACKUP_DIR,
      loadBackup: loadNone,
    });

    expect(summary.restoredFromBackup).toBe(0);
    expect(summary.flaggedNoBackup).toBe(1);
    expect(summary.outcomes[0].decision).toBe("flag-no-backup");
    expect(await readObject(pdfPath)).toEqual(GARBAGE_BYTES);
  }, 120_000);

  it("Census-Modus (kein backupDir) → zählt offene Legacy-Objekte, schreibt nie", async () => {
    await seedSnapshot({ legacy: true });
    await writeObject(pdfPath, GARBAGE_BYTES);

    const summary = await restoreLegacyInvoicePdfsFromBackup({
      apply: false,
      customerIds: [customerId],
      invoiceIds: [],
    });

    expect(summary.checked).toBe(1);
    expect(summary.flaggedNoBackup).toBe(1);
    expect(summary.outcomes[0].decision).toBe("flag-no-backup");
    expect(summary.outcomes[0].flagReason).toContain("Census");
    expect(await readObject(pdfPath)).toEqual(GARBAGE_BYTES);
  }, 120_000);

  it("moderne Rechnung (mit pdfCreationDate) wird NICHT angefasst (gehört in Re-Render-Pfad)", async () => {
    await seedSnapshot({ legacy: false });
    await writeObject(pdfPath, GARBAGE_BYTES);

    const summary = await restoreLegacyInvoicePdfsFromBackup({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Legacy-Restore Test modern skip",
      backupDir: BACKUP_DIR,
      loadBackup: loadMatching,
    });

    // Moderne Rechnungen sind keine Legacy-Kandidaten → nicht geprüft.
    expect(summary.checked).toBe(0);
    expect(await readObject(pdfPath)).toEqual(GARBAGE_BYTES);

    // Zustand für nachfolgende Läufe zurücksetzen.
    await seedSnapshot({ legacy: true });
  }, 120_000);
});
