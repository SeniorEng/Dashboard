// ---------------------------------------------------------------------------
// Retention-Sweep für verwaiste NICHT-PRODUKTIONS-PDF-Artefakte im
// Object-Storage (Task #1806)
//
// Rechnungs- und Leistungsnachweis-PDFs landen in EINEM geteilten Bucket. Prod
// schreibt in den nackten Key-Space `invoices/…` (GoBD-aufbewahrt, UNANTASTBAR);
// alle Nicht-Prod-/Test-Läufe isolieren ihre Keys unter
// `_nonprod/<NODE_ENV>[/run-<RUN_ID>][/w-<WORKER_ID>]/…` (Task #1042/#1051/#1263).
// Bislang gab es KEINE Retention: es wurde nie ein `.delete()` abgesetzt, und die
// DB-Cleanup-Skripte hart-löschen zwar Zeilen, lassen die zugehörigen PDF-Objekte
// aber verwaist zurück. Jeder Dev-/Test-/CI-Lauf füllt den Bucket also dauerhaft
// weiter — die Object-Storage-Kosten wachsen monoton.
//
// Dieses Modul ist die EINE Quelle der Retention-Logik. Es enumeriert Objekte
// unter dem `_nonprod/`-Prefix, wählt die ausreichend ALTEN aus und löscht NUR
// diese. Ein harter Guard (`assertNonprodPdfDeleteKeyAllowed`) verhindert
// beweisbar, dass jemals ein Produktions-Key (nackter `invoices/…`) gelöscht
// wird — symmetrisch zum Schreib-Guard `assertInvoicePdfWriteKeyAllowed`.
//
// SICHERHEIT:
//   - läuft NIEMALS in Production (harter NODE_ENV-Guard im Wrapper).
//   - Dry-Run per Default; echtes Löschen nur mit explizitem `dryRun:false`.
//   - jeder zu löschende Key MUSS unter `_nonprod/` liegen (Guard wirft sonst).
//   - Altersgrenze (Default 24h) schützt frisch geschriebene Artefakte eines
//     parallel laufenden Schwester-Laufs (analog zum DB-Orphan-Sweep).
// ---------------------------------------------------------------------------
import {
  assertNonprodPdfDeleteKeyAllowed,
  getNonprodPdfSweepPrefix,
  getPrivateDir,
  isObjectStorageConfigured,
  parseObjectPath,
} from "../../server/lib/object-storage-helpers.ts";

// Default-Aufbewahrung: Nicht-Prod-PDFs, die älter als 24h sind, gelten als
// verwaist und dürfen gelöscht werden. Ausreichend lang, damit ein parallel
// laufender Schwester-Lauf seine frisch geschriebenen PDFs nie verliert.
export const DEFAULT_PDF_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface SweepableObject {
  /** Bucket-relativer Object-Name (z.B. `.private/_nonprod/test/invoices/RE-…pdf`). */
  name: string;
  /** Erstell-Zeitpunkt in ms (aus `metadata.timeCreated`), oder null wenn unbekannt. */
  createdAtMs: number | null;
}

export interface NonprodPdfBucketPort {
  list(prefix: string): Promise<SweepableObject[]>;
  delete(name: string): Promise<void>;
}

export interface NonprodPdfSweepOptions {
  /** Aufbewahrung in ms; Objekte jünger als das bleiben unberührt. Default 24h. */
  retentionMs?: number;
  /** true (Default) = nur anzeigen; false = wirklich löschen. */
  dryRun?: boolean;
  /** Referenz-Zeitpunkt (für Tests). Default Date.now(). */
  now?: number;
  /** Logger (Default: leise / no-op). */
  log?: (msg: string) => void;
}

export interface NonprodPdfSweepResult {
  /** Anzahl gelisteter Objekte unter dem `_nonprod/`-Prefix. */
  scanned: number;
  /** Object-Namen, die gelöscht wurden (bzw. im Dry-Run: gelöscht würden). */
  deleted: string[];
  /** Anzahl übersprungener (zu junger / alters-unbekannter) Objekte. */
  skipped: number;
  /** Object-Namen, deren Löschung fehlschlug. */
  failed: string[];
}

/**
 * Berechnet Bucket-Name und Bucket-relativen `_nonprod/`-Prefix aus dem
 * konfigurierten Private-Dir (`PRIVATE_OBJECT_DIR`).
 *
 * Beispiel: Private-Dir `/mein-bucket/.private` →
 *   bucketName        = "mein-bucket"
 *   objectPrefix      = ".private/_nonprod/"
 *   privateObjectDir  = ".private/"
 */
export function computeNonprodPdfObjectLocation(): {
  bucketName: string;
  objectPrefix: string;
  privateObjectDir: string;
} {
  const privateDir = getPrivateDir();
  const full = `${privateDir}/${getNonprodPdfSweepPrefix()}`;
  const { bucketName, objectName } = parseObjectPath(full);
  const { objectName: privateObjectDir } = parseObjectPath(`${privateDir}/`);
  return { bucketName, objectPrefix: objectName, privateObjectDir };
}

/**
 * Reiner, testbarer Kern: enumeriert Nicht-Prod-PDF-Objekte über den injizierten
 * Bucket-Port und löscht die zu ALTEN. Für jedes zu löschende Objekt wird der
 * Produktions-Guard geprüft — sollte je ein Nicht-`_nonprod/`-Key auftauchen,
 * bricht der Sweep hart ab (Defense-in-Depth), statt weiterzulöschen.
 */
export async function sweepNonprodPdfArtifacts(
  bucket: NonprodPdfBucketPort,
  location: { objectPrefix: string; privateObjectDir: string },
  opts: NonprodPdfSweepOptions = {},
): Promise<NonprodPdfSweepResult> {
  const retentionMs = opts.retentionMs ?? DEFAULT_PDF_RETENTION_MS;
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? true;
  const log = opts.log ?? (() => {});
  const result: NonprodPdfSweepResult = { scanned: 0, deleted: [], skipped: 0, failed: [] };

  const { objectPrefix, privateObjectDir } = location;
  // Harter Selbstschutz: der Prefix, unter dem wir überhaupt listen, MUSS ein
  // Nicht-Prod-Prefix sein. Sonst niemals loslegen.
  if (!objectPrefix.includes(getNonprodPdfSweepPrefix())) {
    throw new Error(
      `Object-Storage-Retention verweigert: Listen-Prefix "${objectPrefix}" ` +
        `enthält nicht "${getNonprodPdfSweepPrefix()}" — Abbruch, um Produktions-` +
        `Objekte nicht zu enumerieren (Task #1806).`,
    );
  }

  const files = await bucket.list(objectPrefix);
  for (const f of files) {
    result.scanned++;

    // Guard 1: das gelistete Objekt MUSS unter dem Nicht-Prod-Prefix liegen.
    if (!f.name.startsWith(objectPrefix)) {
      log(`[pdf-sweep] übersprungen (außerhalb Prefix): ${f.name}`);
      result.skipped++;
      continue;
    }

    // Guard 2 (Defense-in-Depth): der Private-Dir-relative Key MUSS unter
    // `_nonprod/` liegen. Wirft und bricht den Sweep ab, falls je ein
    // Produktions-Key durchrutscht.
    const relKey = f.name.startsWith(privateObjectDir)
      ? f.name.slice(privateObjectDir.length)
      : f.name;
    assertNonprodPdfDeleteKeyAllowed(relKey);

    // Alters-Guard: zu junge (oder alters-unbekannte) Objekte bleiben unberührt.
    if (f.createdAtMs == null || now - f.createdAtMs < retentionMs) {
      result.skipped++;
      continue;
    }

    if (dryRun) {
      log(`[pdf-sweep] (dry-run) würde löschen: ${f.name}`);
      result.deleted.push(f.name);
      continue;
    }

    try {
      await bucket.delete(f.name);
      log(`[pdf-sweep] gelöscht: ${f.name}`);
      result.deleted.push(f.name);
    } catch (e) {
      log(`[pdf-sweep] Löschen fehlgeschlagen: ${f.name} (${(e as Error).message})`);
      result.failed.push(f.name);
    }
  }

  return result;
}

/**
 * Fertig verdrahteter Wrapper: baut den echten Bucket-Port über den
 * Object-Storage-Client und führt den Sweep aus. Fail-safe verwendbar aus den
 * bestehenden Sweep-Hosts (Orchestrator + `npm run test:unblock`).
 *
 * Guards: läuft NIEMALS in Production; kurzer No-op, wenn kein Object-Storage
 * konfiguriert ist (z.B. GitHub-Actions-CI ohne Sidecar).
 */
export async function runNonprodPdfSweep(
  opts: NonprodPdfSweepOptions = {},
): Promise<NonprodPdfSweepResult | null> {
  const log = opts.log ?? (() => {});

  if (process.env.NODE_ENV === "production") {
    throw new Error("Retention-Sweep verweigert: läuft niemals in Production (Task #1806).");
  }
  if (!isObjectStorageConfigured()) {
    log("[pdf-sweep] Object-Storage nicht konfiguriert — Retention-Sweep übersprungen.");
    return null;
  }

  const { objectStorageClient } = await import(
    "../../server/replit_integrations/object_storage/objectStorage.ts"
  );
  const { bucketName, objectPrefix, privateObjectDir } = computeNonprodPdfObjectLocation();
  const bucket = objectStorageClient.bucket(bucketName);

  const port: NonprodPdfBucketPort = {
    async list(prefix) {
      const [files] = await bucket.getFiles({ prefix });
      return files.map((file) => {
        const created = file.metadata?.timeCreated;
        const createdAtMs = created ? Date.parse(String(created)) : NaN;
        return {
          name: file.name,
          createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null,
        };
      });
    },
    async delete(name) {
      await bucket.file(name).delete();
    },
  };

  return sweepNonprodPdfArtifacts(port, { objectPrefix, privateObjectDir }, opts);
}
