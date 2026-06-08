/**
 * Task #1050 — Reparatur ALTER (Wall-Clock-Ära, pre-#1047) Rechnungs-/
 * Leistungsnachweis-PDFs, die `regenerate-clobbered-invoice-pdfs.ts` nur
 * GEFLAGGT (statt repariert) hat.
 *
 * Problem
 * -------
 * Task #1047 macht Rechnungs-/LN-PDFs byte-reproduzierbar, indem der
 * Erzeugungszeitpunkt EINMALIG im `render_snapshot` (`pdfCreationDate`)
 * versiegelt und in die Render-Pipeline (`normalizePdfDeterminism`) gespeist
 * wird. Bestände, die VOR #1047 erstellt wurden, haben dieses Feld NICHT — ihre
 * Original-Bytes trugen eine inzwischen verlorene Wall-Clock-`/CreationDate`
 * (+ XMP-Zeitstempel + zufällige Datei-`/ID`). Ein Re-Render reproduziert ihren
 * versiegelten `pdf_hash` daher NIE byte-genau, weshalb
 * `regenerate-clobbered-invoice-pdfs.ts` sie korrekt (GoBD-sicher) als `flagged`
 * meldet statt sie blind zu überschreiben.
 *
 * Diese Altbestände brauchen einen eigenen, GoBD-konformen Reparatur-Pfad:
 * NICHT Re-Render, sondern WIEDERHERSTELLUNG DER ORIGINAL-BYTES aus einem
 * Backup (z.B. ein heruntergeladener Object-Storage-Snapshot oder ein Archiv
 * der ursprünglich versendeten PDFs — siehe `docs/pre-publish-backup-runbook.md`).
 *
 * Lösung (dieses Skript)
 * ----------------------
 * Für jede LEGACY-Rechnung (Snapshot vorhanden, aber KEIN `pdfCreationDate`)
 * mit verklobbertem/fehlendem Objekt:
 *   1. Die aktuell im Bucket liegenden Bytes werden geladen und gehasht.
 *      - Hash == `pdf_hash`        → Objekt ist intakt → `alreadyCorrect`.
 *      - Objekt fehlt / Hash ≠ Hash → Reparatur-Kandidat.
 *   2. Im `--backup-dir` wird die passende Original-Datei gesucht (per Object-Key
 *      bzw. Dateinamen). Fehlt sie → GEFLAGGT (`flaggedNoBackup`).
 *   3. Die Backup-Bytes werden gehasht und gegen den versiegelten `pdf_hash`
 *      geprüft. NUR bei byte-genauer Reproduktion werden sie verbatim
 *      zurückgeschrieben (`restoredFromBackup`). Weicht der Hash ab, wird das
 *      Backup-Original NICHT geschrieben → GEFLAGGT (`flaggedHashMismatch`).
 *
 * Census-Modus (ohne `--backup-dir`): Es wird KEIN Backup gelesen und nichts
 * geschrieben — das Skript zählt nur, wie viele Legacy-Altbestände noch
 * verklobbert/fehlend sind und warum (Inventur, GoBD-Review-Grundlage).
 *
 * GoBD / Sicherheit
 * -----------------
 *   - `pdf_hash`, `zugferd_xml`, `render_snapshot` und alle anderen versiegelten
 *     Rechnungs-Felder werden NIE mutiert. Das Skript schreibt ausschließlich
 *     Object-Storage-Bytes (verbatim auf den gespeicherten `pdf_path`) und einen
 *     Append-only-Audit-Eintrag (`invoice_pdf_restored_from_backup`).
 *   - Der Hash-Gate ist hart: ein Backup-Original wird NUR akzeptiert, wenn es
 *     den versiegelten `pdf_hash` byte-genau reproduziert. Ein abweichendes oder
 *     fehlendes Backup führt NIE zu einem stillen Überschreiben.
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in
 *     und erfordert `--user=<superadmin-id>` + `--reason="…"` (≥10 Zeichen).
 *   - Der Restore schreibt verbatim auf den gespeicherten `pdf_path`; in der
 *     Produktion ist das der nackte `invoices/…`-Key (`assertInvoicePdfWriteKey
 *     Allowed` = No-op). Aus einer Nicht-Produktions-Umgebung bricht der Guard
 *     einen Schreibzugriff auf den Produktions-Key-Space hart ab (Task #1042).
 *
 * Backup-Verzeichnis-Konvention
 * -----------------------------
 * `--backup-dir` zeigt auf ein lokales Verzeichnis mit den Original-PDF-Bytes.
 * Pro Objekt werden mehrere Dateipfade probiert (erster Treffer gewinnt):
 *   - <backup-dir>/<object-key>            (z.B. invoices/RE-2026-0034.pdf)
 *   - <backup-dir>/<basename>              (z.B. RE-2026-0034.pdf)
 * Der LN trägt den Suffix `-leistungsnachweis.pdf` (wie im Object-Key).
 *
 * Aufruf
 * ------
 *   - Inventur (Census):   tsx server/scripts/restore-legacy-invoice-pdfs-from-backup.ts
 *   - Trockenlauf m. Backup: tsx … --backup-dir=tmp/pdf-backup
 *   - Scharf:              tsx … --backup-dir=tmp/pdf-backup --apply \
 *                            --user=<superadmin-id> --reason="Legacy-PDF-Restore #1050"
 *
 * Exit-Code: 0 = keine Legacy-Altbestände mehr verklobbert/fehlend, 1 =
 * mindestens ein Legacy-Objekt offen (reparierbar oder geflaggt). `--apply`
 * ändert den Exit-Code nicht.
 */

import fs from "fs";
import path from "path";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  invoices as invoicesTable,
  users,
  type Invoice,
  type InvoiceRenderSnapshot,
} from "@shared/schema";
import { storage } from "../storage";
import { computeDataHash } from "../services/signature-integrity";
import { auditService } from "../services/audit";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import {
  assertInvoicePdfWriteKeyAllowed,
  getPrivateDir,
  parseObjectPath,
} from "../lib/object-storage-helpers";
import {
  classifyStoredObject,
  type InvoiceObjectKind,
  type StoredObjectState,
} from "./regenerate-clobbered-invoice-pdfs";

// ---------------------------------------------------------------------------
// Reine Entscheidungslogik (ohne DB/Storage — unit-testbar).
// ---------------------------------------------------------------------------

/**
 * True, wenn die Rechnung ein „Legacy"-Bestand (pre-#1047) ist: ein
 * Render-Snapshot existiert, trägt aber KEINEN versiegelten `pdfCreationDate`.
 * Solche PDFs reproduzieren ihren `pdf_hash` per Re-Render NIE byte-genau und
 * können nur aus einem Backup-Original wiederhergestellt werden. Rechnungen MIT
 * `pdfCreationDate` (post-#1047) gehören in den Re-Render-Pfad
 * (`regenerate-clobbered-invoice-pdfs.ts`), nicht hierher.
 */
export function isLegacyInvoice(snapshot: InvoiceRenderSnapshot | null): boolean {
  return snapshot !== null && !snapshot.pdfCreationDate;
}

/** Entscheidung nach dem Backup-Lookup. */
export type BackupRestoreDecision = "restore" | "flag-no-backup" | "flag-hash-mismatch";

/**
 * Entscheidet, ob ein verklobbertes/fehlendes Legacy-Objekt aus einem
 * Backup-Original wiederhergestellt werden darf:
 *   - `flag-no-backup`     → kein Backup-Original gefunden.
 *   - `restore`            → Backup-Bytes reproduzieren `pdf_hash` byte-genau.
 *   - `flag-hash-mismatch` → Backup gefunden, aber Hash weicht ab.
 */
export function decideBackupRestore(args: {
  backupHash: string | null;
  expectedHash: string;
}): BackupRestoreDecision {
  if (args.backupHash === null) return "flag-no-backup";
  return args.backupHash === args.expectedHash ? "restore" : "flag-hash-mismatch";
}

// ---------------------------------------------------------------------------
// Object-Storage- & Backup-Helfer.
// ---------------------------------------------------------------------------

/** Wandelt einen gespeicherten `pdf_path` (`/objects/<key>`) in {bucket, object}. */
function resolveStoredObject(storedPath: string): {
  objectKey: string;
  bucketName: string;
  objectName: string;
} {
  let objectKey = storedPath;
  if (objectKey.startsWith("/objects/")) objectKey = objectKey.slice("/objects/".length);
  let entityDir = getPrivateDir();
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const fullPath = `${entityDir}${objectKey}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  return { objectKey, bucketName, objectName };
}

/** Lädt die aktuell gespeicherten Bytes (oder null, falls das Objekt fehlt). */
async function downloadStoredBytes(storedPath: string): Promise<Buffer | null> {
  const { bucketName, objectName } = resolveStoredObject(storedPath);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return Buffer.from(contents);
}

/** Schreibt die Original-Bytes VERBATIM zurück auf den gespeicherten Pfad. */
async function restoreStoredBytes(
  storedPath: string,
  bytes: Buffer,
  metadata: Record<string, string>,
): Promise<void> {
  const { objectKey, bucketName, objectName } = resolveStoredObject(storedPath);
  assertInvoicePdfWriteKeyAllowed(objectKey);
  await objectStorageClient.bucket(bucketName).file(objectName).save(bytes, {
    contentType: "application/pdf",
    metadata,
  });
}

/**
 * Sucht im Backup-Verzeichnis die Original-Datei für ein Objekt. Probiert
 * mehrere Kandidaten-Pfade (erster Treffer gewinnt). Gibt die geladenen Bytes
 * und den Treffer-Pfad zurück, oder `null`, falls keine Datei gefunden wurde.
 * Liefert auch `null`, wenn kein Backup-Verzeichnis konfiguriert ist (Census).
 */
export function loadBackupBytes(
  backupDir: string | undefined,
  objectKey: string,
): { bytes: Buffer; path: string } | null {
  if (!backupDir) return null;
  const basename = objectKey.split("/").pop() ?? objectKey;
  const candidates = [path.join(backupDir, objectKey), path.join(backupDir, basename)];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { bytes: fs.readFileSync(candidate), path: candidate };
      }
    } catch {
      /* defensiv: unlesbarer Kandidat → nächster */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Findings & Summary.
// ---------------------------------------------------------------------------

export interface LegacyObjectOutcome {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  kind: InvoiceObjectKind;
  storedPath: string;
  /** Zustand des im Bucket gefundenen Objekts vor der Reparatur. */
  storedState: StoredObjectState;
  decision: "restore" | "flag-no-backup" | "flag-hash-mismatch" | "skip";
  /** Bei `--apply` und `restore`: ob die Bytes tatsächlich geschrieben wurden. */
  restored: boolean;
  /** Pfad der verwendeten Backup-Datei (nur falls eine gefunden wurde). */
  backupPath?: string;
  /** Klartext-Grund (für geflaggte Objekte). */
  flagReason?: string;
}

export interface RestoreLegacySummary {
  apply: boolean;
  backupDir?: string;
  /** Anzahl geprüfter Legacy-Objekte (Rechnungs-PDF + LN-PDF). */
  checked: number;
  /** Objekte, deren Bytes bereits byte-genau auf `pdf_hash` hashen. */
  alreadyCorrect: number;
  /** Objekte, die aus einem Backup byte-genau wiederhergestellt wurden/würden. */
  restoredFromBackup: number;
  /** Objekte ohne Backup-Original → manuelle GoBD-Prüfung. */
  flaggedNoBackup: number;
  /** Objekte, deren Backup den `pdf_hash` NICHT reproduziert → manuelle Prüfung. */
  flaggedHashMismatch: number;
  outcomes: LegacyObjectOutcome[];
}

interface Args {
  apply: boolean;
  customerIds: number[];
  invoiceIds: number[];
  userId?: number;
  reason?: string;
  backupDir?: string;
}

type LoadBackupFn = (
  backupDir: string | undefined,
  objectKey: string,
) => { bytes: Buffer; path: string } | null;

interface RunOptions extends Args {
  /** Injizierbarer Backup-Loader (Tests). Default = Dateisystem-Lookup. */
  loadBackup?: LoadBackupFn;
}

// ---------------------------------------------------------------------------
// Kandidaten-Laden.
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: number;
  invoiceNumber: string;
  customerId: number;
  pdfPath: string | null;
  pdfHash: string | null;
  leistungsnachweisPath: string | null;
  leistungsnachweisHash: string | null;
}

async function loadCandidateInvoices(
  customerIds: number[],
  invoiceIds: number[],
): Promise<CandidateRow[]> {
  const whereParts = [
    isNotNull(invoicesTable.renderSnapshot),
    or(
      and(isNotNull(invoicesTable.pdfPath), isNotNull(invoicesTable.pdfHash)),
      and(
        isNotNull(invoicesTable.leistungsnachweisPath),
        isNotNull(invoicesTable.leistungsnachweisHash),
      ),
    ),
  ];
  if (customerIds.length > 0) {
    whereParts.push(inArray(invoicesTable.customerId, customerIds));
  }
  if (invoiceIds.length > 0) {
    whereParts.push(inArray(invoicesTable.id, invoiceIds));
  }
  return db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      customerId: invoicesTable.customerId,
      pdfPath: invoicesTable.pdfPath,
      pdfHash: invoicesTable.pdfHash,
      leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
      leistungsnachweisHash: invoicesTable.leistungsnachweisHash,
    })
    .from(invoicesTable)
    .where(and(...whereParts));
}

async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db
    .select({
      id: users.id,
      isSuperAdmin: users.isSuperAdmin,
      isActive: users.isActive,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        `Der Legacy-PDF-Restore (Task #1050) schreibt Produktions-Objekte und ` +
        `ist auf Superadmins beschränkt.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Kern-Routine.
// ---------------------------------------------------------------------------

async function processObject(args: {
  invoice: CandidateRow;
  kind: InvoiceObjectKind;
  storedPath: string;
  expectedHash: string;
  apply: boolean;
  backupDir?: string;
  loadBackup: LoadBackupFn;
}): Promise<LegacyObjectOutcome> {
  const { invoice, kind, storedPath, expectedHash, apply, backupDir, loadBackup } = args;

  const storedBytes = await downloadStoredBytes(storedPath);
  const storedHash = storedBytes ? computeDataHash(storedBytes as unknown as string) : null;
  const storedState = classifyStoredObject({
    exists: storedBytes !== null,
    storedHash,
    expectedHash,
  });

  const base: LegacyObjectOutcome = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    kind,
    storedPath,
    storedState,
    decision: "skip",
    restored: false,
  };

  if (storedState === "correct") {
    return base;
  }

  // Verklobbert oder fehlend → Backup-Original suchen.
  const { objectKey } = resolveStoredObject(storedPath);
  const backup = loadBackup(backupDir, objectKey);
  const backupHash = backup ? computeDataHash(backup.bytes as unknown as string) : null;
  const decision = decideBackupRestore({ backupHash, expectedHash });

  if (decision === "flag-no-backup") {
    return {
      ...base,
      decision,
      flagReason: backupDir
        ? `Kein Backup-Original im Backup-Verzeichnis gefunden (Objekt-Key "${objectKey}").`
        : `Census-Modus (kein --backup-dir): Legacy-Altbestand benötigt Backup-Original.`,
    };
  }

  if (decision === "flag-hash-mismatch") {
    return {
      ...base,
      decision,
      backupPath: backup?.path,
      flagReason:
        `Backup-Original reproduziert pdf_hash NICHT byte-genau ` +
        `(erwartet ${expectedHash.slice(0, 12)}…, Backup ${backupHash?.slice(0, 12)}…). ` +
        `Falsche/abweichende Sicherung — manuelle GoBD-Prüfung nötig.`,
    };
  }

  // decision === "restore": Backup-Original reproduziert den versiegelten Hash.
  if (apply) {
    await restoreStoredBytes(storedPath, backup!.bytes, {
      invoiceNumber: invoice.invoiceNumber,
      ...(kind === "invoice"
        ? { pdfHash: expectedHash }
        : { leistungsnachweisHash: expectedHash }),
    });
    return { ...base, decision: "restore", restored: true, backupPath: backup!.path };
  }
  return { ...base, decision: "restore", restored: false, backupPath: backup!.path };
}

export async function restoreLegacyInvoicePdfsFromBackup(
  options: RunOptions,
): Promise<RestoreLegacySummary> {
  const loadBackup = options.loadBackup ?? loadBackupBytes;
  const candidates = await loadCandidateInvoices(options.customerIds, options.invoiceIds);

  const outcomes: LegacyObjectOutcome[] = [];

  for (const cand of candidates) {
    // Vollständige Rechnung laden, um den Render-Snapshot (pdfCreationDate) zu
    // prüfen. getInvoice nutzt denselben JOIN-Alias wie der Render-Pfad.
    const invoice: Invoice | undefined = await storage.getInvoice(cand.id);
    if (!invoice) continue;
    const snapshot = (invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
    // Nur Legacy-Bestände (pre-#1047). Post-#1047-Rechnungen sind über den
    // Re-Render-Pfad reparierbar und gehören NICHT hierher.
    if (!isLegacyInvoice(snapshot)) continue;

    const objectsToCheck: Array<{
      kind: InvoiceObjectKind;
      storedPath: string;
      expectedHash: string;
    }> = [];
    if (cand.pdfPath && cand.pdfHash) {
      objectsToCheck.push({ kind: "invoice", storedPath: cand.pdfPath, expectedHash: cand.pdfHash });
    }
    if (cand.leistungsnachweisPath && cand.leistungsnachweisHash) {
      objectsToCheck.push({
        kind: "leistungsnachweis",
        storedPath: cand.leistungsnachweisPath,
        expectedHash: cand.leistungsnachweisHash,
      });
    }

    for (const obj of objectsToCheck) {
      const outcome = await processObject({
        invoice: cand,
        kind: obj.kind,
        storedPath: obj.storedPath,
        expectedHash: obj.expectedHash,
        apply: options.apply,
        backupDir: options.backupDir,
        loadBackup,
      });
      outcomes.push(outcome);
    }

    // Audit-Eintrag pro Rechnung mit mindestens einer tatsächlichen Restore.
    if (options.apply && options.userId !== undefined) {
      const restoredForInvoice = outcomes.filter(
        (o) => o.invoiceId === cand.id && o.decision === "restore" && o.restored,
      );
      if (restoredForInvoice.length > 0) {
        await auditService.log(
          options.userId,
          "invoice_pdf_restored_from_backup",
          "invoice",
          cand.id,
          {
            task: "#1050",
            reason: options.reason,
            invoiceNumber: cand.invoiceNumber,
            customerId: cand.customerId,
            restoredObjects: restoredForInvoice.map((o) => ({
              kind: o.kind,
              storedPath: o.storedPath,
              storedState: o.storedState,
              backupPath: o.backupPath,
            })),
          },
        );
      }
    }
  }

  const checked = outcomes.length;
  const alreadyCorrect = outcomes.filter((o) => o.storedState === "correct").length;
  const restoredFromBackup = outcomes.filter((o) => o.decision === "restore").length;
  const flaggedNoBackup = outcomes.filter((o) => o.decision === "flag-no-backup").length;
  const flaggedHashMismatch = outcomes.filter((o) => o.decision === "flag-hash-mismatch").length;

  return {
    apply: options.apply,
    backupDir: options.backupDir,
    checked,
    alreadyCorrect,
    restoredFromBackup,
    flaggedNoBackup,
    flaggedHashMismatch,
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const apply = argv.includes("--apply");

  const parseIdList = (raw: string | undefined): number[] => {
    const ids: number[] = [];
    if (raw) {
      for (const idStr of raw.split(",")) {
        const n = parseInt(idStr.trim(), 10);
        if (!Number.isNaN(n)) ids.push(n);
      }
    }
    return ids;
  };

  const userArg = get("--user=");
  const userId = userArg ? parseInt(userArg, 10) : undefined;
  return {
    apply,
    customerIds: parseIdList(get("--customer=")),
    invoiceIds: parseIdList(get("--invoice=")),
    userId: userId !== undefined && Number.isFinite(userId) ? userId : undefined,
    reason: get("--reason="),
    backupDir: get("--backup-dir="),
  };
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
    if (!args.backupDir) {
      console.error("Fehler: --apply erfordert --backup-dir=<pfad> (Census-Modus schreibt nie).");
      process.exit(1);
    }
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="..." (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    await assertSuperadminOrThrow(args.userId);
  }

  console.log(`\n=== Legacy-PDF-Restore (pre-#1047) · Task #1050 ===`);
  console.log(`Modus:    ${args.apply ? "SCHARF (--apply)" : args.backupDir ? "Trockenlauf (read-only)" : "Census (Inventur)"}`);
  console.log(`Backup:   ${args.backupDir ?? "— (kein --backup-dir → nur Inventur)"}`);
  console.log(`Kunden:   ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
  if (args.invoiceIds.length > 0) console.log(`Rechnungen: ${args.invoiceIds.join(", ")}`);
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  const summary = await restoreLegacyInvoicePdfsFromBackup(args);

  // Kundennamen für die Ausgabe.
  const cids = Array.from(new Set(summary.outcomes.map((o) => o.customerId)));
  const names = new Map<number, string>();
  if (cids.length > 0) {
    const rows = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, cids));
    for (const r of rows) names.set(r.id, r.name ?? "");
  }

  console.log(`\nGeprüfte Legacy-Objekte:   ${summary.checked}`);
  console.log(`Bereits korrekt:           ${summary.alreadyCorrect}`);
  console.log(`${args.apply ? "Aus Backup wiederhergestellt" : "Aus Backup reparierbar"}: ${summary.restoredFromBackup}`);
  console.log(`Geflaggt (kein Backup):    ${summary.flaggedNoBackup}`);
  console.log(`Geflaggt (Hash-Mismatch):  ${summary.flaggedHashMismatch}\n`);

  const actionable = summary.outcomes.filter((o) => o.storedState !== "correct");
  for (const o of actionable) {
    const tag =
      o.decision === "restore"
        ? args.apply
          ? "WIEDERHERGESTELLT"
          : "REPARIERBAR"
        : "GEFLAGGT";
    console.log(
      `  [${tag}] Rechnung ${o.invoiceNumber} · ${o.kind} · Kunde #${o.customerId} ${names.get(o.customerId) ?? ""}` +
        `\n    Objekt: ${o.storedPath} (Zustand: ${o.storedState})` +
        (o.backupPath ? `\n    Backup: ${o.backupPath}` : "") +
        (o.flagReason ? `\n    Grund: ${o.flagReason}` : ""),
    );
  }

  if (!args.apply && summary.restoredFromBackup > 0) {
    console.log(
      '\nHinweis: Trockenlauf — keine Bytes geschrieben.' +
        '\n  Scharf wiederherstellen mit: --backup-dir=<pfad> --apply --user=<superadmin-id> --reason="…"',
    );
  }
  if (summary.flaggedNoBackup > 0 || summary.flaggedHashMismatch > 0) {
    console.log(
      '\nHinweis: Geflaggte Legacy-Objekte konnten NICHT byte-genau aus einem Backup' +
        '\n  wiederhergestellt werden (fehlend oder abweichend). Sie werden NICHT' +
        '\n  automatisch überschrieben — bitte manuell (Superadmin/GoBD-Review)' +
        '\n  entscheiden. Backup-Quelle siehe docs/pre-publish-backup-runbook.md.',
    );
  }
  if (actionable.length === 0) {
    console.log("\n✓ Keine verklobberten/fehlenden Legacy-PDF-Objekte gefunden.");
  }

  process.exit(actionable.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
