import { db } from "../lib/db";
import { invoices as invoicesTable } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { log } from "../lib/log";
import { auditService } from "../services/audit";
import { ChromiumUnavailableError, isChromiumAvailable, runChromiumPreflight } from "../services/pdf-generator";

const DELAY_BETWEEN_PDFS_MS = 250;
const RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Task #577: Storno-Rechnungen ohne PDF nachgenerieren.
 *
 * In Prod sind vier Storno-Rechnungen (IDs 5, 6, 7, 9) mit `pdf_path IS NULL`,
 * weil der frühere Storno-Pfad (`PATCH /:id/status` → "storniert") nach
 * `createInvoiceTx` keinen Hintergrund-Persist gefeuert hat. `GET /:id/pdf`
 * rendert zwar on-demand (Task #544), aber Versand per E-Mail/E-POST braucht
 * einen persistierten Pfad in der DB.
 *
 * Diese Migration ist idempotent: sie findet alle Storno-Rechnungen mit
 * `pdfPath IS NULL`, ruft `persistInvoicePdf` auf (No-op falls bereits
 * persistiert) und schreibt pro nachgezogener Rechnung einen Audit-Eintrag
 * `invoice_pdf_manually_regenerated`. Beim nächsten Boot ist die Tabelle
 * leer und die Migration kostet nur eine Index-Lookup-Query.
 *
 * Läuft NACH `backfillInvoicePdfs` (das deckt zwar `pdfPath IS NULL` generisch
 * ab, schreibt aber keinen Audit-Eintrag und ist auf 20 Rechnungen/Boot
 * gedeckelt). Für die GoBD-Nachvollziehbarkeit der Storno-Heilung wollen wir
 * den dedizierten Audit-Eintrag pro ID.
 */
export async function backfillStornoInvoicePdfs(): Promise<{ processed: number; failed: number }> {
  if (!isChromiumAvailable()) {
    log(
      "Backfill Storno-PDF übersprungen: Chromium auf diesem Host nicht gefunden.",
      "startup",
    );
    return { processed: 0, failed: 0 };
  }
  const preflight = runChromiumPreflight();
  if (!preflight.ok) {
    log(
      `Backfill Storno-PDF übersprungen: Chromium nicht ausführbar (${preflight.error}).`,
      "startup",
    );
    return { processed: 0, failed: 0 };
  }

  const rows = await db.select({
    id: invoicesTable.id,
    invoiceNumber: invoicesTable.invoiceNumber,
    createdByUserId: invoicesTable.createdByUserId,
    pdfPath: invoicesTable.pdfPath,
    leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
  })
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.invoiceType, "stornorechnung"),
      isNull(invoicesTable.pdfPath),
    ));

  if (rows.length === 0) {
    return { processed: 0, failed: 0 };
  }

  log(`Backfill Storno-PDF: ${rows.length} Stornorechnung(en) ohne pdf_path gefunden — starte Nachgenerierung`, "startup");

  const { persistInvoicePdf } = await import("../services/invoice-pdf-orchestrator");

  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    const before = {
      pdfPath: row.pdfPath,
      leistungsnachweisPath: row.leistungsnachweisPath,
    };
    let lastErr: unknown = null;
    let success = false;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await persistInvoicePdf(row.id);
        success = true;
        break;
      } catch (err) {
        lastErr = err;
        if (err instanceof ChromiumUnavailableError) {
          log(`Backfill Storno-PDF abgebrochen: ${err.message}`, "startup");
          return { processed, failed };
        }
        const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
        if (isLastAttempt) break;
        const wait = RETRY_DELAYS_MS[attempt];
        log(`Backfill Storno-PDF Rechnung #${row.id} Versuch ${attempt + 1} fehlgeschlagen: ${err} — Retry in ${wait}ms`, "startup");
        try {
          const { discardBrowser } = await import("../services/pdf-generator");
          await discardBrowser();
        } catch {}
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    if (success) {
      processed++;
      // Audit-Eintrag nur, wenn tatsächlich etwas geändert wurde (idempotent).
      const refreshed = await db.select({
        pdfPath: invoicesTable.pdfPath,
        leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
      }).from(invoicesTable).where(eq(invoicesTable.id, row.id)).limit(1);
      const after = {
        pdfPath: refreshed[0]?.pdfPath ?? null,
        leistungsnachweisPath: refreshed[0]?.leistungsnachweisPath ?? null,
      };
      const changed = before.pdfPath !== after.pdfPath
        || before.leistungsnachweisPath !== after.leistungsnachweisPath;
      if (changed) {
        try {
          await auditService.log(
            row.createdByUserId ?? 0,
            "invoice_pdf_manually_regenerated",
            "invoice",
            row.id,
            {
              invoiceNumber: row.invoiceNumber,
              source: "startup_backfill_storno_pdfs",
              taskRef: "Task #577",
              before,
              after,
            },
          );
        } catch (auditErr) {
          log(`Backfill Storno-PDF: Audit-Eintrag für Rechnung #${row.id} fehlgeschlagen: ${auditErr}`, "startup");
        }
      }
    } else {
      failed++;
      log(`Backfill Storno-PDF Rechnung #${row.id} (${row.invoiceNumber}) endgültig fehlgeschlagen: ${lastErr}`, "startup");
    }
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PDFS_MS));
  }

  log(`Backfill Storno-PDF: ${processed}/${rows.length} Stornorechnungen persistiert (${failed} Fehler)`, "startup");
  return { processed, failed };
}
