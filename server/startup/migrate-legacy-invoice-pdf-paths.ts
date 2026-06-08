import { db } from "../lib/db";
import { invoices as invoicesTable } from "@shared/schema";
import { eq, isNotNull, or } from "drizzle-orm";
import { log } from "../lib/log";
import {
  isProductionPdfEnv,
  buildInvoicePdfObjectKey,
} from "../lib/object-storage-helpers";

// Task #1066 — Bestands-PDF-Pfade aus dem nackten Produktions-Key-Space in den
// umgebungs-isolierten Key-Space (`_nonprod/<NODE_ENV>/…`) umschreiben.
//
// Vor Task #1042 schrieben ALLE Umgebungen Rechnungs-/LN-PDFs unter den nackten
// Schlüssel `invoices/<nummer>.pdf`. Da Rechnungsnummern (`RE-2026-00xx`) über
// Dev-, Test- und Prod-Datenbanken hinweg kollidieren, zeigen Dev-/Test-
// Bestandszeilen via `pdf_path = /objects/invoices/RE-…pdf` auf denselben
// geteilten Object-Key wie die Produktion (RE-2026-0001/0002/0004/0036). Ein
// Dev-Lauf, der dieses Objekt liest oder (über einen alten Schreibpfad)
// überschrieb, kollidierte mit dem Produktions-PDF.
//
// Diese Migration läuft NUR in Nicht-Produktions-Umgebungen (Produktion behält
// den nackten Key-Space byte-genau gültig) und schreibt jeden noch nackten
// `pdf_path`/`leistungsnachweis_path` auf den aktuellen umgebungs-gescopten
// Object-Key um. Das frische Objekt existiert dort zunächst nicht — der
// Self-Heal-Pfad in `persistInvoicePdfInner` rendert es beim nächsten Abruf aus
// dem eingefrorenen Render-Snapshot neu (byte-genau für Rechnungen ab #1047).
//
// Idempotent: Pfade, die bereits den Nicht-Prod-Prefix tragen, werden
// übersprungen; ein zweiter Boot ist ein No-Op.

/**
 * True, wenn der gespeicherte Pfad auf den nackten Produktions-Key-Space
 * (`invoices/…`) zeigt, also NICHT unter dem Nicht-Prod-Prefix (`_nonprod/…`)
 * liegt. Solche Pfade kollidieren über Umgebungen hinweg und müssen umgeschrieben
 * werden.
 */
function isBareProductionPdfPath(pdfPath: string): boolean {
  let key = pdfPath;
  if (key.startsWith("/objects/")) key = key.slice("/objects/".length);
  return key.startsWith("invoices/");
}

export async function migrateLegacyInvoicePdfPaths(): Promise<void> {
  // Produktion behält den nackten Key-Space — dort gibt es nichts umzuschreiben.
  if (isProductionPdfEnv()) return;

  const rows = await db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      pdfPath: invoicesTable.pdfPath,
      leistungsnachweisPath: invoicesTable.leistungsnachweisPath,
    })
    .from(invoicesTable)
    .where(
      or(
        isNotNull(invoicesTable.pdfPath),
        isNotNull(invoicesTable.leistungsnachweisPath),
      ),
    );

  let rewritten = 0;
  for (const row of rows) {
    const safeNumber = row.invoiceNumber.replace(/[^a-z0-9_-]/gi, "_");
    const update: { pdfPath?: string; leistungsnachweisPath?: string } = {};

    if (row.pdfPath && isBareProductionPdfPath(row.pdfPath)) {
      update.pdfPath = `/objects/${buildInvoicePdfObjectKey(safeNumber)}`;
    }
    if (
      row.leistungsnachweisPath &&
      isBareProductionPdfPath(row.leistungsnachweisPath)
    ) {
      update.leistungsnachweisPath = `/objects/${buildInvoicePdfObjectKey(safeNumber, { leistungsnachweis: true })}`;
    }

    if (Object.keys(update).length === 0) continue;
    await db.update(invoicesTable).set(update).where(eq(invoicesTable.id, row.id));
    rewritten++;
  }

  if (rewritten > 0) {
    log(
      `Legacy-Invoice-PDF-Pfade auf umgebungs-isolierten Key-Space umgeschrieben: ${rewritten} Rechnung(en)`,
      "startup",
    );
  }
}
