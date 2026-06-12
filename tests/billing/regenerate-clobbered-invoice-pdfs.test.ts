/**
 * Task #1043 — Verifikation des Clobbered-PDF-Restore
 * (`regenerateClobberedInvoicePdfs`).
 *
 * Kontext
 * -------
 * Vor der Object-Storage-Isolation (Task #1042) überschrieben Dev-/Test-Läufe
 * die PRODUKTIONS-PDF-Bytes im geteilten Bucket (kollidierende
 * Rechnungsnummern). Die DB blieb intakt (`render_snapshot`, `pdf_hash`,
 * `zugferd_xml`). Dieses Skript rendert die betroffenen PDFs aus dem
 * versiegelten Snapshot neu und schreibt sie NUR dann zurück, wenn der
 * Re-Render den versiegelten `pdf_hash` byte-genau reproduziert; andernfalls
 * wird das Objekt für manuelle Prüfung geflaggt.
 *
 * Test-Strategie
 * --------------
 *   1. REINE Entscheidungslogik (`classifyStoredObject`, `decideRestore`) —
 *      schnell, deterministisch, ohne DB/Storage/Chromium.
 *   2. INTEGRATION mit echtem Object Storage + INJIZIERTEM Re-Render: Da
 *      eingebettete PDFs nicht byte-stabil sind (Puppeteer-Timestamps), lässt
 *      sich der Reparatur-Pfad nicht über einen echten Chromium-Render
 *      deterministisch testen. Stattdessen wird der Re-Render injiziert, so dass
 *      der Download/Klassifikation/Restore/Audit-Pfad gegen einen seedeten
 *      Rechnungs-Datensatz + reale Bucket-Objekte vollständig durchläuft.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasObjectStorageEnv } from "../helpers/object-storage";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import {
  auditLog,
  invoices as invoicesTable,
  users,
  type InvoiceRenderSnapshot,
} from "@shared/schema";
import {
  classifyStoredObject,
  decideRestore,
  regenerateClobberedInvoicePdfs,
  type RenderInvoiceFn,
} from "../../server/scripts/regenerate-clobbered-invoice-pdfs";
import { createInvoiceTx, getNextInvoiceNumberTx } from "../../server/storage/billing-storage";
import { computeDataHash } from "../../server/services/signature-integrity";
import { objectStorageClient } from "../../server/replit_integrations/object_storage/objectStorage";
import {
  buildInvoicePdfObjectKey,
  getPrivateDir,
  parseObjectPath,
} from "../../server/lib/object-storage-helpers";
import {
  apiPost,
  cleanupCustomer,
  getAuthCookie,
  runCleanup,
  uniqueId,
} from "../test-utils";

// --- Reine Entscheidungslogik -------------------------------------------------

describe("classifyStoredObject", () => {
  it("missing, wenn das Objekt nicht existiert", () => {
    expect(classifyStoredObject({ exists: false, storedHash: null, expectedHash: "abc" })).toBe(
      "missing",
    );
  });

  it("missing, wenn kein Hash berechnet werden konnte", () => {
    expect(classifyStoredObject({ exists: true, storedHash: null, expectedHash: "abc" })).toBe(
      "missing",
    );
  });

  it("correct, wenn der gespeicherte Hash byte-genau passt", () => {
    expect(classifyStoredObject({ exists: true, storedHash: "abc", expectedHash: "abc" })).toBe(
      "correct",
    );
  });

  it("mismatch, wenn vorhanden aber Hash abweicht (verklobbert)", () => {
    expect(classifyStoredObject({ exists: true, storedHash: "xyz", expectedHash: "abc" })).toBe(
      "mismatch",
    );
  });
});

describe("decideRestore", () => {
  it("repair NUR bei byte-genauer Hash-Reproduktion", () => {
    expect(decideRestore({ rerenderHash: "abc", expectedHash: "abc" })).toBe("repair");
  });

  it("flag, wenn der Re-Render den versiegelten Hash nicht reproduziert", () => {
    expect(decideRestore({ rerenderHash: "def", expectedHash: "abc" })).toBe("flag");
  });
});

// --- Integration: Download / Restore / Audit ---------------------------------

const YEAR = 2026;
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

const KNOWN_PDF_BYTES = Buffer.from("%PDF-1.4\nclobber-restore-known-good\n%%EOF\n", "utf-8");
const DIFFERENT_PDF_BYTES = Buffer.from("%PDF-1.4\nre-render-does-not-match\n%%EOF\n", "utf-8");
const GARBAGE_BYTES = Buffer.from("dev-test-run-clobbered-this-object", "utf-8");

const KNOWN_HASH = computeDataHash(KNOWN_PDF_BYTES as unknown as string);

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

describe.skipIf(!hasObjectStorageEnv)("regenerateClobberedInvoicePdfs — Object-Restore", () => {
  let customerId: number;
  let superadminId: number;
  let invoiceId: number;
  let invoiceNumber: string;
  let pdfPath: string;

  // Re-Render, der byte-genau die versiegelten Bytes reproduziert (Happy-Path).
  const renderMatching: RenderInvoiceFn = async () => ({
    pdf: KNOWN_PDF_BYTES,
    leistungsnachweisPdf: null,
  });
  // Re-Render, der den versiegelten Hash NICHT reproduziert (Flag-Path) —
  // realistisch für nicht-byte-stabile PDFs (Creation-Timestamps).
  const renderDifferent: RenderInvoiceFn = async () => ({
    pdf: DIFFERENT_PDF_BYTES,
    leistungsnachweisPdf: null,
  });

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .limit(1);
    superadminId = admin?.id ?? auth.user.id;

    const custRes = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Clobber",
      nachname: `Restore-${uniqueId()}`,
      geburtsdatum: "1940-05-05",
      email: `clobber-${uniqueId()}@test.local`,
      strasse: "Clobberweg",
      nr: "1",
      plz: "01067",
      stadt: "Dresden",
      telefon: "+4917600000004",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
    });
    expect(custRes.status, `create customer: ${JSON.stringify(custRes.data)}`).toBe(201);
    customerId = custRes.data.id;

    // Rechnung anlegen (Status entwurf → UPDATE erlaubt, Cleanup unproblematisch).
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
          customerName: "Clobber Restore",
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

    // Versiegelte Felder nachtragen (UPDATE ist trigger-erlaubt für Rechnungen):
    // ein minimaler Snapshot (Inhalt egal, der Re-Render ist injiziert) + der
    // pdf_hash der KNOWN-Bytes als versiegelter Referenzwert.
    const snapshot: InvoiceRenderSnapshot = {
      companySettings: {} as InvoiceRenderSnapshot["companySettings"],
      customer: {
        geburtsdatum: "1940-05-05",
        beihilfeBerechtigt: false,
        rechnungAnKunde: false,
        name: "Clobber Restore",
        vorname: "Clobber",
        nachname: "Restore",
        strasse: "Clobberweg",
        nr: "1",
        plz: "01067",
        stadt: "Dresden",
      },
    };
    await db
      .update(invoicesTable)
      .set({ pdfPath, pdfHash: KNOWN_HASH, renderSnapshot: snapshot })
      .where(eq(invoicesTable.id, invoiceId));
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

  it("intaktes Objekt → alreadyCorrect, kein Re-Render, kein Schreiben", async () => {
    await writeObject(pdfPath, KNOWN_PDF_BYTES);

    let rendered = false;
    const render: RenderInvoiceFn = async () => {
      rendered = true;
      return { pdf: KNOWN_PDF_BYTES, leistungsnachweisPdf: null };
    };

    const summary = await regenerateClobberedInvoicePdfs({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Clobber-Restore Test intakt",
      renderInvoice: render,
    });

    expect(summary.checked).toBe(1);
    expect(summary.alreadyCorrect).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(summary.flagged).toBe(0);
    // Intaktes Objekt darf KEIN teures Re-Render auslösen.
    expect(rendered).toBe(false);
    // Bytes unverändert.
    expect(await readObject(pdfPath)).toEqual(KNOWN_PDF_BYTES);
  }, 120_000);

  it("verklobbertes Objekt, Trockenlauf → reparierbar, aber nichts geschrieben", async () => {
    await writeObject(pdfPath, GARBAGE_BYTES);

    const summary = await regenerateClobberedInvoicePdfs({
      apply: false,
      customerIds: [customerId],
      invoiceIds: [],
      renderInvoice: renderMatching,
    });

    expect(summary.checked).toBe(1);
    expect(summary.alreadyCorrect).toBe(0);
    expect(summary.repaired).toBe(1);
    expect(summary.flagged).toBe(0);
    expect(summary.outcomes[0].storedState).toBe("mismatch");
    expect(summary.outcomes[0].decision).toBe("repair");
    expect(summary.outcomes[0].restored).toBe(false);
    // Trockenlauf: Objekt bleibt verklobbert.
    expect(await readObject(pdfPath)).toEqual(GARBAGE_BYTES);
  }, 120_000);

  it("verklobbertes Objekt, Scharflauf → byte-genau wiederhergestellt + Audit", async () => {
    await writeObject(pdfPath, GARBAGE_BYTES);

    const summary = await regenerateClobberedInvoicePdfs({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Clobber-Restore Test scharf (Task #1043 Verifikation)",
      renderInvoice: renderMatching,
    });

    expect(summary.repaired).toBe(1);
    expect(summary.flagged).toBe(0);
    expect(summary.outcomes[0].restored).toBe(true);
    // Objekt trägt wieder die versiegelten Bytes.
    const restored = await readObject(pdfPath);
    expect(restored).toEqual(KNOWN_PDF_BYTES);
    expect(computeDataHash(restored as unknown as string)).toBe(KNOWN_HASH);

    // Audit-Eintrag dokumentiert die Regenerierung (append-only, GoBD).
    const audits = await db
      .select({ metadata: auditLog.metadata, userId: auditLog.userId, entityType: auditLog.entityType })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invoice_pdf_manually_regenerated"),
          eq(auditLog.entityId, invoiceId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe("invoice");
    expect(audits[0].userId).toBe(superadminId);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.task).toBe("#1043");
    expect(meta.invoiceNumber).toBe(invoiceNumber);
  }, 120_000);

  it("Re-Render reproduziert pdf_hash NICHT → geflaggt, Objekt unberührt, kein Audit", async () => {
    await writeObject(pdfPath, GARBAGE_BYTES);
    const auditsBefore = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invoice_pdf_manually_regenerated"),
          eq(auditLog.entityId, invoiceId),
        ),
      );

    const summary = await regenerateClobberedInvoicePdfs({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Clobber-Restore Test flag",
      renderInvoice: renderDifferent,
    });

    expect(summary.repaired).toBe(0);
    expect(summary.flagged).toBe(1);
    expect(summary.outcomes[0].decision).toBe("flag");
    expect(summary.outcomes[0].flagReason).toBeTruthy();
    // Niemals blind überschreiben: Objekt bleibt verklobbert.
    expect(await readObject(pdfPath)).toEqual(GARBAGE_BYTES);

    // Kein neuer Audit-Eintrag für ein geflaggtes (nicht repariertes) Objekt.
    const auditsAfter = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invoice_pdf_manually_regenerated"),
          eq(auditLog.entityId, invoiceId),
        ),
      );
    expect(auditsAfter.length).toBe(auditsBefore.length);
  }, 120_000);

  it("fehlendes Objekt, Scharflauf → aus Snapshot wiederhergestellt", async () => {
    await deleteObject(pdfPath);
    expect(await readObject(pdfPath)).toBeNull();

    const summary = await regenerateClobberedInvoicePdfs({
      apply: true,
      customerIds: [customerId],
      invoiceIds: [],
      userId: superadminId,
      reason: "Clobber-Restore Test missing",
      renderInvoice: renderMatching,
    });

    expect(summary.repaired).toBe(1);
    expect(summary.outcomes[0].storedState).toBe("missing");
    expect(summary.outcomes[0].restored).toBe(true);
    expect(await readObject(pdfPath)).toEqual(KNOWN_PDF_BYTES);
  }, 120_000);
});
