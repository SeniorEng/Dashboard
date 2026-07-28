/**
 * Task #1043 — Verklobberte Rechnungs-/Leistungsnachweis-PDF-Objekte im
 * GETEILTEN Object-Storage-Bucket aus dem versiegelten `render_snapshot`
 * regenerieren.
 *
 * Problem
 * -------
 * Vor Task #1042 (Object-Storage-Isolation pro Umgebung) teilten sich Dev,
 * Test und Produktion denselben nackten Object-Key-Space `invoices/<nummer>.pdf`.
 * Da Rechnungsnummern (`RE-2026-00xx`) über die Dev- und Prod-Datenbanken
 * hinweg kollidieren, hat jeder Dev-/Test-Lauf, der z.B. `RE-2026-0034`
 * erzeugte, die PRODUKTIONS-PDF-Bytes unter demselben Key überschrieben
 * („geclobbert"). Die Produktions-DB ist davon UNBERÜHRT: `render_snapshot`,
 * `pdf_hash` und `zugferd_xml` sind weiterhin korrekt — nur die im Bucket
 * liegenden Datei-Bytes wurden überschrieben.
 *
 * Lösung (dieses Skript)
 * ----------------------
 * Für jede betroffene Rechnung wird das PDF (und der Leistungsnachweis, falls
 * vorhanden) aus dem versiegelten `render_snapshot` NEU GERENDERT — über genau
 * denselben Pfad wie der Integritäts-Verifier (`buildInvoicePdfBytes(invoice,
 * snapshot.companySettings, { snapshot })`). Anschließend:
 *
 *   1. Die aktuell im Bucket liegenden Bytes werden geladen und gehasht.
 *      - Hash == `pdf_hash`        → Objekt ist intakt → `alreadyCorrect`.
 *      - Objekt fehlt / Hash ≠ Hash → Objekt ist verklobbert → Reparatur-Kandidat.
 *   2. Der NEU-GERENDERTE PDF-Hash wird gegen das versiegelte `pdf_hash`
 *      geprüft. NUR wenn er byte-genau reproduziert, werden die regenerierten
 *      Bytes zurück in den Object-Key geschrieben (`repaired`).
 *   3. Reproduziert das Re-Render den `pdf_hash` NICHT, wird das Objekt NICHT
 *      blind überschrieben, sondern für manuelle Prüfung GEFLAGGT (`flagged`).
 *
 * GoBD / Sicherheit
 * -----------------
 *   - `pdf_hash`, `zugferd_xml`, `render_snapshot` und alle anderen versiegelten
 *     Rechnungs-Felder werden NIE mutiert. Das Skript schreibt ausschließlich
 *     Object-Storage-Bytes (verbatim auf den gespeicherten `pdf_path`) und einen
 *     Append-only-Audit-Eintrag (`invoice_pdf_manually_regenerated`).
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in
 *     und erfordert `--user=<superadmin-id>` + `--reason="…"` (≥10 Zeichen).
 *   - Der Restore schreibt verbatim auf den gespeicherten `pdf_path`. In der
 *     Produktion ist das der nackte `invoices/…`-Key; `assertInvoicePdfWrite
 *     KeyAllowed` ist dort ein No-op. In Nicht-Produktion trägt ein gespeicherter
 *     `pdf_path` den `_nonprod/<env>/…`-Prefix (Task #1042) und der Guard lässt
 *     den Restore ebenfalls verbatim zu — ein versehentlicher Schreibzugriff auf
 *     den PRODUKTIONS-Key-Space aus einer Nicht-Produktions-Umgebung wird hart
 *     abgebrochen. Das macht den scharfen Lauf de facto produktions-zielgerichtet.
 *
 * WICHTIGER REALITÄTS-HINWEIS zur Byte-Stabilität
 * ------------------------------------------------
 * Eingebettete PDFs sind NICHT byte-stabil (Puppeteer schreibt eine
 * Wall-Clock-`CreationDate`/`ModDate` ins PDF; der ZUGFeRD/PDF-A-3-Embed setzt
 * eine XMP-Erstellungszeit). Der Integritäts-Verifier
 * (`invoice-integrity-verifier.ts`) vergleicht deshalb absichtlich NUR das
 * deterministische ZUGFeRD-XML neu gegen `zugferd_xml` und den im Bucket
 * persistierten Hash gegen `pdf_hash` — NICHT einen frischen Re-Render-Hash
 * gegen `pdf_hash`.
 *
 * Konsequenz: Re-Renders reproduzieren den ursprünglichen `pdf_hash` i.d.R.
 * NICHT byte-genau (die Original-Bytes trugen die nun verlorene Erzeugungs-
 * Zeit). Der strikte Hash-Gate ist die GEFORDERTE GoBD-Sicherheitseigenschaft
 * — ein echtes Dokument darf NIE still durch ein abweichendes Re-Render ersetzt
 * werden. In der Praxis bedeutet das: betroffene Objekte werden eher GEFLAGGT
 * als automatisch repariert. Der Operator sieht dann eine hohe Flag-Zahl
 * (sicher und dokumentiert) und entscheidet die Remediation manuell
 * (Superadmin/GoBD-Review). Dieses Skript SCHWÄCHT den Hash-Gate NICHT ab und
 * mutiert `pdf_hash` NICHT.
 *
 * Aufruf
 * ------
 *   - Trockenlauf (alle):  tsx server/scripts/regenerate-clobbered-invoice-pdfs.ts
 *   - Einzelne Kunden:     tsx server/scripts/regenerate-clobbered-invoice-pdfs.ts --customer=39,95
 *   - Einzelne Rechnungen: tsx server/scripts/regenerate-clobbered-invoice-pdfs.ts --invoice=35
 *   - Scharf:              tsx server/scripts/regenerate-clobbered-invoice-pdfs.ts --apply \
 *                            --user=<superadmin-id> --reason="Clobbered-PDF-Restore #1043"
 *
 * Exit-Code: 0 = nichts zu reparieren/flaggen, 1 = mindestens ein verklobbertes
 * Objekt gefunden (Skript-/CI-freundliches Signal). `--apply` ändert den
 * Exit-Code nicht.
 */

import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customers,
  invoices as invoicesTable,
  users,
  type CompanySettings,
  type Invoice,
  type InvoiceRenderSnapshot,
} from "@shared/schema";
import { storage } from "../storage";
import { computeDataHash } from "../services/signature-integrity";
import { auditService } from "../services/audit";
import { getStorageDriver } from "../lib/storage";
import {
  assertInvoicePdfWriteKeyAllowed,
  getPrivateDir,
  parseObjectPath,
} from "../lib/object-storage-helpers";

// ---------------------------------------------------------------------------
// Reine Entscheidungslogik (ohne DB/Storage/Chromium — unit-testbar).
// ---------------------------------------------------------------------------

/** Zustand eines im Bucket liegenden Objekts relativ zum versiegelten Hash. */
export type StoredObjectState = "correct" | "missing" | "mismatch";

/**
 * Klassifiziert ein gespeichertes Objekt:
 *   - `missing`  → Objekt existiert nicht (oder konnte nicht geladen werden).
 *   - `correct`  → vorhandene Bytes hashen byte-genau auf den versiegelten Hash.
 *   - `mismatch` → vorhanden, aber Hash weicht ab (verklobbert).
 */
export function classifyStoredObject(args: {
  exists: boolean;
  storedHash: string | null;
  expectedHash: string;
}): StoredObjectState {
  if (!args.exists || args.storedHash === null) return "missing";
  return args.storedHash === args.expectedHash ? "correct" : "mismatch";
}

/**
 * Entscheidet, ob ein verklobbertes/fehlendes Objekt aus einem Re-Render
 * wiederhergestellt werden darf: NUR wenn der Re-Render-Hash den versiegelten
 * `pdf_hash` byte-genau reproduziert. Andernfalls → manuelle Prüfung.
 */
export function decideRestore(args: {
  rerenderHash: string;
  expectedHash: string;
}): "repair" | "flag" {
  return args.rerenderHash === args.expectedHash ? "repair" : "flag";
}

// ---------------------------------------------------------------------------
// Object-Storage-Helfer (verbatim auf gespeichertem Pfad).
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
  const file = getStorageDriver().bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return Buffer.from(contents);
}

/** Schreibt regenerierte Bytes VERBATIM zurück auf den gespeicherten Pfad. */
async function restoreStoredBytes(
  storedPath: string,
  bytes: Buffer,
  metadata: Record<string, string>,
): Promise<void> {
  const { objectKey, bucketName, objectName } = resolveStoredObject(storedPath);
  // Defense-in-Depth (Task #1042): verhindert, dass eine Nicht-Produktions-
  // Umgebung versehentlich den nackten Produktions-Key-Space überschreibt.
  assertInvoicePdfWriteKeyAllowed(objectKey);
  await getStorageDriver().bucket(bucketName).file(objectName).save(bytes, {
    contentType: "application/pdf",
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Re-Render aus versiegeltem Snapshot (SSoT = Integritäts-Verifier-Pfad).
// ---------------------------------------------------------------------------

export interface RenderedInvoiceArtifacts {
  pdf: Buffer;
  leistungsnachweisPdf: Buffer | null;
}

/**
 * Re-Render-Funktion (injizierbar für Tests). Default: derselbe Pfad wie der
 * Integritäts-Verifier — `buildInvoicePdfBytes(invoice, snapshot.companySettings,
 * { snapshot })`. Liest die Firmen-Stammdaten aus dem versiegelten Snapshot, so
 * dass parallele Live-Mutationen den Re-Render nicht verstimmen.
 */
export type RenderInvoiceFn = (
  invoice: Invoice,
  snapshot: InvoiceRenderSnapshot,
) => Promise<RenderedInvoiceArtifacts>;

const defaultRenderInvoice: RenderInvoiceFn = async (invoice, snapshot) => {
  const { buildInvoicePdfBytes } = await import("../services/invoice-pdf-orchestrator");
  const companySettings = snapshot.companySettings as unknown as CompanySettings;
  const { pdf, leistungsnachweisPdf } = await buildInvoicePdfBytes(invoice, companySettings, {
    snapshot,
  });
  return { pdf, leistungsnachweisPdf };
};

// ---------------------------------------------------------------------------
// Findings & Summary.
// ---------------------------------------------------------------------------

/** Ein einzelnes Objekt (Rechnungs-PDF ODER Leistungsnachweis-PDF). */
export type InvoiceObjectKind = "invoice" | "leistungsnachweis";

export interface ObjectOutcome {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  kind: InvoiceObjectKind;
  storedPath: string;
  /** Zustand des im Bucket gefundenen Objekts vor der Reparatur. */
  storedState: StoredObjectState;
  /** Entscheidung nach dem Re-Render (nur für nicht-`correct`-Objekte gesetzt). */
  decision: "repair" | "flag" | "skip";
  /** Bei `--apply` und `repair`: ob die Bytes tatsächlich geschrieben wurden. */
  restored: boolean;
  /**
   * Task #1050 — ob die Rechnung einen versiegelten `pdfCreationDate` trägt
   * (post-#1047). `false` = Legacy-Bestand (Wall-Clock-Ära): der Re-Render kann
   * den `pdf_hash` NIE byte-genau reproduzieren. Solche `flag`-Objekte sind über
   * `restore-legacy-invoice-pdfs-from-backup.ts` (Backup-Original) zu reparieren,
   * nicht per Re-Render.
   */
  pdfCreationDateSealed: boolean;
  /** Manuelle-Prüfung-Grund (nur für `flag`). */
  flagReason?: string;
}

export interface RegenerateSummary {
  apply: boolean;
  /** Anzahl geprüfter Objekte (Rechnungs-PDF + LN-PDF). */
  checked: number;
  /** Objekte, deren Bytes bereits byte-genau auf `pdf_hash` hashen. */
  alreadyCorrect: number;
  /** Objekte, die aus dem Snapshot byte-genau wiederhergestellt wurden. */
  repaired: number;
  /** Objekte, deren Re-Render `pdf_hash` NICHT reproduziert → manuelle Prüfung. */
  flagged: number;
  /**
   * Task #1050 — Teilmenge von `flagged`: Legacy-Bestände (pre-#1047, kein
   * versiegelter `pdfCreationDate`), die per Re-Render NIE reparierbar sind und
   * stattdessen über `restore-legacy-invoice-pdfs-from-backup.ts` (Backup-
   * Original) zu adressieren sind. Macht „wie viele Altbestände warum geflaggt"
   * direkt bezifferbar.
   */
  flaggedLegacy: number;
  /** Detail pro Objekt (verklobberte + reparierte + geflaggte). */
  outcomes: ObjectOutcome[];
}

interface Args {
  apply: boolean;
  customerIds: number[];
  invoiceIds: number[];
  userId?: number;
  reason?: string;
}

interface RunOptions extends Args {
  /** Injizierbarer Re-Render (Tests). Default = Integritäts-Verifier-Pfad. */
  renderInvoice?: RenderInvoiceFn;
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

/**
 * Lädt Kandidaten-Rechnungen: ein versiegelter `render_snapshot` MUSS vorliegen
 * (sonst ist kein deterministischer Re-Render möglich) UND mindestens ein
 * Objekt (Rechnungs-PDF oder LN-PDF) mit Pfad+Hash muss existieren.
 */
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
        `Der Clobbered-PDF-Restore (Task #1043) schreibt Produktions-Objekte und ` +
        `ist auf Superadmins beschränkt.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Kern-Routine.
// ---------------------------------------------------------------------------

/**
 * Prüft ein einzelnes Objekt (Rechnungs-PDF oder LN-PDF): lädt die gespeicherten
 * Bytes, klassifiziert sie gegen `expectedHash` und reicht — falls verklobbert —
 * den passenden re-gerenderten Buffer zur Hash-gegateten Wiederherstellung
 * durch. Das eigentliche Re-Render passiert NUR EINMAL pro Rechnung im Aufrufer
 * (lazy), damit intakte Objekte kein teures Chromium-Rendern auslösen.
 */
async function processObject(args: {
  invoice: CandidateRow;
  kind: InvoiceObjectKind;
  storedPath: string;
  expectedHash: string;
  apply: boolean;
  userId?: number;
  /**
   * Task #1050 — `false` = Legacy-Bestand (pre-#1047, kein versiegelter
   * `pdfCreationDate`); ein Re-Render reproduziert den `pdf_hash` NIE byte-genau,
   * weshalb die Flag-Begründung auf den Backup-Restore-Pfad verweist.
   */
  pdfCreationDateSealed: boolean;
  /** Lazy-Re-Render: liefert (gecached) die Artefakte der ganzen Rechnung. */
  getArtifacts: () => Promise<RenderedInvoiceArtifacts>;
}): Promise<ObjectOutcome> {
  const { invoice, kind, storedPath, expectedHash, apply, pdfCreationDateSealed } = args;

  const storedBytes = await downloadStoredBytes(storedPath);
  const storedHash = storedBytes ? computeDataHash(storedBytes as unknown as string) : null;
  const storedState = classifyStoredObject({
    exists: storedBytes !== null,
    storedHash,
    expectedHash,
  });

  const base: ObjectOutcome = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    kind,
    storedPath,
    storedState,
    decision: "skip",
    restored: false,
    pdfCreationDateSealed,
  };

  if (storedState === "correct") {
    return base;
  }

  // Verklobbert oder fehlend → Re-Render anstoßen (einmal pro Rechnung gecached).
  const artifacts = await args.getArtifacts();
  const rendered = kind === "invoice" ? artifacts.pdf : artifacts.leistungsnachweisPdf;

  if (!rendered) {
    // Snapshot-Re-Render liefert für diese Rechnung kein LN-PDF (z.B. keine
    // Pflegekassen-Rechnung mehr). Nicht automatisch reparierbar.
    return {
      ...base,
      decision: "flag",
      flagReason:
        "Re-Render liefert kein Leistungsnachweis-PDF (Rechnungstyp ohne LN?) — manuelle Prüfung.",
    };
  }

  const rerenderHash = computeDataHash(rendered as unknown as string);
  const decision = decideRestore({ rerenderHash, expectedHash });

  if (decision === "flag") {
    // Task #1050 — Legacy-Bestände (kein versiegelter pdfCreationDate) können
    // per Re-Render prinzipiell NIE repariert werden. Den Operator gezielt auf
    // den Backup-Original-Pfad verweisen, statt eine generische Byte-Stabilitäts-
    // Warnung zu geben.
    const legacyHint = pdfCreationDateSealed
      ? `PDFs sind nicht byte-stabil (Creation-Timestamps) — manuelle GoBD-Prüfung nötig.`
      : `LEGACY-BESTAND (pre-#1047, kein versiegelter pdfCreationDate): Re-Render kann ` +
        `den pdf_hash NIE reproduzieren. Reparatur nur über Backup-Original via ` +
        `restore-legacy-invoice-pdfs-from-backup.ts.`;
    return {
      ...base,
      decision: "flag",
      flagReason:
        `Re-Render reproduziert pdf_hash NICHT byte-genau ` +
        `(erwartet ${expectedHash.slice(0, 12)}…, re-rendered ${rerenderHash.slice(0, 12)}…). ` +
        legacyHint,
    };
  }

  // decision === "repair": Re-Render reproduziert den versiegelten Hash byte-genau.
  if (apply) {
    await restoreStoredBytes(storedPath, rendered, {
      invoiceNumber: invoice.invoiceNumber,
      ...(kind === "invoice" ? { pdfHash: expectedHash } : { leistungsnachweisHash: expectedHash }),
    });
    return { ...base, decision: "repair", restored: true };
  }
  return { ...base, decision: "repair", restored: false };
}

export async function regenerateClobberedInvoicePdfs(
  options: RunOptions,
): Promise<RegenerateSummary> {
  const renderInvoice = options.renderInvoice ?? defaultRenderInvoice;
  const candidates = await loadCandidateInvoices(options.customerIds, options.invoiceIds);

  const outcomes: ObjectOutcome[] = [];

  for (const cand of candidates) {
    // Vollständige Rechnung über storage.getInvoice laden — KRITISCH: getInvoice
    // überschreibt `invoice.customerName` mit `customers.name` (JOIN-Alias). Der
    // Re-Render-Pfad (persistInvoicePdfInner) nutzt denselben Lookup; ein roher
    // Tabellen-Select würde einen anderen Namen ins ZUGFeRD-XML rendern und den
    // byte-genauen Hash-Vergleich falsch-negativ machen.
    const invoice = await storage.getInvoice(cand.id);
    if (!invoice) continue;
    const snapshot = (invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
    if (!snapshot) continue; // Defensive: Kandidaten-Filter garantiert das bereits.

    // Task #1050 — Legacy-Bestände (pre-#1047) tragen keinen versiegelten
    // pdfCreationDate; ihr Re-Render reproduziert den pdf_hash NIE byte-genau.
    const pdfCreationDateSealed = Boolean(snapshot.pdfCreationDate);

    // Lazy + gecacht: Re-Render erst, wenn mindestens ein Objekt verklobbert ist.
    let artifactsPromise: Promise<RenderedInvoiceArtifacts> | null = null;
    const getArtifacts = () => {
      if (!artifactsPromise) artifactsPromise = renderInvoice(invoice, snapshot);
      return artifactsPromise;
    };

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
        userId: options.userId,
        pdfCreationDateSealed,
        getArtifacts,
      });
      outcomes.push(outcome);
    }

    // Audit-Eintrag pro Rechnung mit mindestens einer tatsächlichen Reparatur.
    if (options.apply && options.userId !== undefined) {
      const repairedForInvoice = outcomes.filter(
        (o) => o.invoiceId === cand.id && o.decision === "repair" && o.restored,
      );
      if (repairedForInvoice.length > 0) {
        await auditService.log(
          options.userId,
          "invoice_pdf_manually_regenerated",
          "invoice",
          cand.id,
          {
            task: "#1043",
            reason: options.reason,
            invoiceNumber: cand.invoiceNumber,
            customerId: cand.customerId,
            restoredObjects: repairedForInvoice.map((o) => ({
              kind: o.kind,
              storedPath: o.storedPath,
              storedState: o.storedState,
            })),
          },
        );
      }
    }
  }

  const checked = outcomes.length;
  const alreadyCorrect = outcomes.filter((o) => o.storedState === "correct").length;
  // `repaired` zählt Objekte mit Reparatur-ENTSCHEIDUNG (Re-Render reproduziert
  // den versiegelten Hash). Im Scharflauf wurden sie tatsächlich geschrieben
  // (`restored === true`), im Trockenlauf sind sie „reparierbar" (`restored ===
  // false`) — die per-Objekt-`restored`-Flagge unterscheidet beides.
  const repaired = outcomes.filter((o) => o.decision === "repair").length;
  const flagged = outcomes.filter((o) => o.decision === "flag").length;
  // Task #1050 — Teilmenge der geflaggten Objekte, die Legacy-Bestände sind
  // (kein versiegelter pdfCreationDate). Diese sind per Re-Render nicht
  // reparierbar und gehören in den Backup-Restore-Pfad.
  const flaggedLegacy = outcomes.filter(
    (o) => o.decision === "flag" && !o.pdfCreationDateSealed,
  ).length;

  return {
    apply: options.apply,
    checked,
    alreadyCorrect,
    repaired,
    flagged,
    flaggedLegacy,
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
  };
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
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

  console.log(`\n=== Clobbered-PDF-Restore · Task #1043 ===`);
  console.log(`Modus:    ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only)"}`);
  console.log(`Kunden:   ${args.customerIds.length > 0 ? args.customerIds.join(", ") : "ALLE"}`);
  if (args.invoiceIds.length > 0) console.log(`Rechnungen: ${args.invoiceIds.join(", ")}`);
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  const summary = await regenerateClobberedInvoicePdfs(args);

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

  console.log(`\nGeprüfte Objekte:        ${summary.checked}`);
  console.log(`Bereits korrekt:         ${summary.alreadyCorrect}`);
  console.log(`${args.apply ? "Repariert" : "Reparierbar (Trockenlauf)"}: ${summary.repaired}`);
  console.log(`Geflaggt (manuelle Prüfung): ${summary.flagged}`);
  console.log(`  davon Legacy (pre-#1047, Backup nötig): ${summary.flaggedLegacy}\n`);

  const actionable = summary.outcomes.filter((o) => o.storedState !== "correct");
  for (const o of actionable) {
    const tag =
      o.decision === "repair"
        ? args.apply
          ? "REPARIERT"
          : "REPARIERBAR"
        : "GEFLAGGT";
    console.log(
      `  [${tag}] Rechnung ${o.invoiceNumber} · ${o.kind} · Kunde #${o.customerId} ${names.get(o.customerId) ?? ""}` +
        `\n    Objekt: ${o.storedPath} (Zustand: ${o.storedState})` +
        (o.flagReason ? `\n    Grund: ${o.flagReason}` : ""),
    );
  }

  if (!args.apply && summary.repaired > 0) {
    console.log(
      '\nHinweis: Trockenlauf — keine Bytes geschrieben.' +
        '\n  Scharf wiederherstellen mit: --apply --user=<superadmin-id> --reason="…"',
    );
  }
  if (summary.flagged > 0) {
    console.log(
      '\nHinweis: Geflaggte Objekte reproduzieren ihren versiegelten pdf_hash NICHT' +
        '\n  byte-genau (PDFs sind nicht byte-stabil). Sie werden NICHT automatisch' +
        '\n  überschrieben — bitte manuell (Superadmin/GoBD-Review) entscheiden.',
    );
  }
  if (actionable.length === 0) {
    console.log("\n✓ Keine verklobberten PDF-Objekte gefunden.");
  }

  process.exit(actionable.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
