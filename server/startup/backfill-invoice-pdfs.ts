import { db } from "../lib/db";
import { invoices as invoicesTable } from "@shared/schema";
import { and, isNull, or, sql } from "drizzle-orm";
import { log } from "../lib/log";
import { ChromiumUnavailableError, isChromiumAvailable } from "../services/pdf-generator";

// Pro Boot maximal so viele Rechnungen backfillen — die PDF-Generierung kostet
// pro Stück 1-3s Puppeteer-Zeit, der Startup-Schritt darf nicht zum Boot-Bottleneck
// werden. Beim nächsten Boot werden die nächsten N abgearbeitet.
const MAX_PER_STARTUP = 20;
const DELAY_BETWEEN_PDFS_MS = 250;
// Task #544: Backoff reduziert auf 2 Versuche — bei einem dauerhaft kaputten
// Chromium nicht 4×30s pro Rechnung verbrennen.
const RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Task #521: Backfill für Rechnungs- und Leistungsnachweis-PDFs in Object Storage.
 *
 * Persistiert PDFs für Bestandsrechnungen, deren `pdf_path` NULL ist oder die
 * (bei Pflegekassen-Rechnungen) noch keinen `leistungsnachweis_path` haben.
 * Läuft idempotent bei jedem Boot — abgeschlossene Rechnungen werden nicht
 * erneut angefasst (persistInvoicePdf prüft das per `pdf_path`/`leistungsnachweis_path`).
 *
 * Robust gegen transiente Puppeteer-Fehler: pro Rechnung wird bis zu 3x mit
 * exponentiellem Backoff erneut versucht. Bei wiederholtem Fehlschlag wird
 * der Fehler geloggt — der Boot bricht NICHT ab.
 */
export async function backfillInvoicePdfs(): Promise<{ processed: number; failed: number }> {
  // Task #544: Chromium-Health-Check vor dem Backfill — wenn das Binary im
  // Deployment-Image fehlt, sparen wir uns N × Retry × 30s Timeout-Hänger.
  if (!isChromiumAvailable()) {
    log(
      "Backfill PDF übersprungen: Chromium auf diesem Host nicht gefunden. " +
        "CHROMIUM_PATH setzen oder Chromium installieren.",
      "startup",
    );
    return { processed: 0, failed: 0 };
  }

  const rows = await db.select({
    id: invoicesTable.id,
    invoiceNumber: invoicesTable.invoiceNumber,
    billingType: invoicesTable.billingType,
    pdfPath: invoicesTable.pdfPath,
    leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
  })
    .from(invoicesTable)
    .where(or(
      isNull(invoicesTable.pdfPath),
      and(
        isNull(invoicesTable.leistungsnachweisPath),
        sql`${invoicesTable.billingType} IN ('pflegekasse_privat', 'pflegekasse_gesetzlich')`,
      ),
    ))
    .limit(MAX_PER_STARTUP);

  if (rows.length === 0) {
    return { processed: 0, failed: 0 };
  }

  const { persistInvoicePdf } = await import("../routes/billing");

  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    let lastErr: unknown = null;
    let success = false;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await persistInvoicePdf(row.id);
        success = true;
        break;
      } catch (err) {
        lastErr = err;
        // Task #544: Wenn Chromium gar nicht da ist, sofort den ganzen
        // Backfill abbrechen — kein Sinn, das für weitere Rechnungen
        // erneut zu versuchen.
        if (err instanceof ChromiumUnavailableError) {
          log(`Backfill PDF abgebrochen: ${err.message}`, "startup");
          return { processed, failed };
        }
        const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
        if (isLastAttempt) break;
        // Recoverable Puppeteer-Fehler: kurz warten und Browser neu hochfahren lassen.
        const wait = RETRY_DELAYS_MS[attempt];
        log(`Backfill PDF Rechnung #${row.id} Versuch ${attempt + 1} fehlgeschlagen: ${err} — Retry in ${wait}ms`, "startup");
        try {
          const { discardBrowser } = await import("../services/pdf-generator");
          await discardBrowser();
        } catch {}
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (success) {
      processed++;
    } else {
      failed++;
      log(`Backfill PDF Rechnung #${row.id} (${row.invoiceNumber}) endgültig fehlgeschlagen nach ${RETRY_DELAYS_MS.length + 1} Versuchen: ${lastErr}`, "startup");
    }
    // Kleiner Throttle, damit Puppeteer/Chromium Zeit für GC hat.
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PDFS_MS));
  }

  log(`Backfill PDF: ${processed}/${rows.length} Rechnungen persistiert (${failed} Fehler)`, "startup");
  return { processed, failed };
}
