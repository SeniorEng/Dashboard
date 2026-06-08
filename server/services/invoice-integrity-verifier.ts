import { and, eq, gte, isNotNull } from "drizzle-orm";
import { db } from "../lib/db";
import { invoices as invoicesTable } from "@shared/schema";
import type { CompanySettings, InvoiceRenderSnapshot } from "@shared/schema";
import { log } from "../lib/log";
import { computeDataHash } from "./signature-integrity";
import { getCachedCompanySettings } from "./cache";
import { auditService } from "./audit";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { parseObjectPath, getPrivateDir } from "../lib/object-storage-helpers";
import { storage } from "../storage";

interface VerifyResult {
  invoiceId: number;
  invoiceNumber: string;
  xmlMatch: boolean;
  pdfHashMatch: boolean;
}

/**
 * Tier-A3: Verifiziert die Integrität einer Rechnung durch Neu-Rendern und
 * byte-genauen Vergleich gegen das in der DB persistierte ZUGFeRD-XML und
 * den SHA-256-Hash der PDF-Bytes.
 *
 * Diskrepanzen werden als Audit-Eintrag dokumentiert (Action
 * `invoice_integrity_drift`), nicht als harter Fehler — der Job soll Drift
 * sichtbar machen, nicht den Bestand brechen.
 */
export async function verifyInvoiceIntegrity(invoiceId: number): Promise<VerifyResult | null> {
  // Task #1074: MUSS `storage.getInvoice` benutzen (nicht direkt `invoicesTable`-Select).
  // getInvoice liefert seit #1074 den EINGEFRORENEN Snapshot-Kundennamen statt des
  // per JOIN aktuellen `customers.name`. `persistInvoicePdfInner` rendert über genau
  // denselben Pfad — beide bauen das ZUGFeRD-XML aus dem Snapshot. Eine spätere
  // Namensänderung am Kunden kann den byte-genauen Vergleich daher nicht mehr in
  // falsch-positive Drift treiben. Snapshot-Lookup zusätzlich direkt aus der Tabelle,
  // da getInvoice nicht alle Snapshot-Felder (companySettings/invoice) exponiert.
  const invoice = await storage.getInvoice(invoiceId);
  if (!invoice) return null;
  if (!invoice.zugferdXml && !invoice.pdfHash) return null;

  // Task #593: Wenn ein `renderSnapshot` vorliegt (alle nach #593 erzeugten
  // Rechnungen), wird das XML deterministisch aus dem damals gespeicherten
  // Snapshot rekonstruiert — parallele Mutationen an `company_settings` oder
  // am Kunden-Datensatz können die Re-Render-XML nicht mehr verstimmen und
  // produzieren keine falsch-positiven Drift-Treffer. Für Bestand vor #593
  // (snapshot=NULL) fällt der Verifier auf den Live-Snapshot zurück; das
  // entspricht dem Verhalten vor dieser Härtung.
  const snapshot = (invoice.renderSnapshot ?? null) as InvoiceRenderSnapshot | null;
  const companySettings = snapshot
    ? (snapshot.companySettings as unknown as CompanySettings)
    : await getCachedCompanySettings();
  if (!companySettings) return null;

  // Re-Render: prüft, ob ZUGFeRD-XML (rechtsverbindlicher E-Rechnungs-Inhalt)
  // deterministisch reproduzierbar ist. Eingebettete PDFs sind nicht byte-stabil
  // (PDF-Creation-Timestamps), daher wird der PDF-Hash gegen die in Object Storage
  // persistierten Bytes geprüft — das deckt Storage-Tampering ab.
  const { buildInvoicePdfBytes } = await import("./invoice-pdf-orchestrator");
  const { xml } = await buildInvoicePdfBytes(invoice, companySettings, { snapshot });

  let storedPdfHash: string | null = null;
  if (invoice.pdfHash && invoice.pdfPath) {
    try {
      let entityId = invoice.pdfPath;
      if (entityId.startsWith("/objects/")) entityId = entityId.slice("/objects/".length);
      const fullPath = `${getPrivateDir()}/${entityId}`;
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const file = objectStorageClient.bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        const [contents] = await file.download();
        storedPdfHash = computeDataHash(Buffer.from(contents) as unknown as string);
      }
    } catch (err) {
      log(`Storage-Download für Integrity-Check fehlgeschlagen (Rechnung ${invoice.id}): ${err}`, "integrity");
    }
  }

  const xmlMatch = !invoice.zugferdXml || (xml !== null && xml === invoice.zugferdXml);
  const pdfHashMatch = !invoice.pdfHash || (storedPdfHash !== null && storedPdfHash === invoice.pdfHash);

  if (!xmlMatch || !pdfHashMatch) {
    try {
      await auditService.log(
        invoice.createdByUserId ?? 0,
        "invoice_integrity_drift",
        "invoice",
        invoice.id,
        {
          invoiceNumber: invoice.invoiceNumber,
          xmlMatch,
          pdfHashMatch,
          storedHash: invoice.pdfHash,
          recomputedHash: storedPdfHash,
        },
      );
    } catch (err) {
      log(`Audit-Log für Integrity-Drift fehlgeschlagen (Rechnung ${invoice.id}): ${err}`, "integrity");
    }
    log(`Integrity-Drift Rechnung ${invoice.invoiceNumber}: xmlMatch=${xmlMatch} pdfHashMatch=${pdfHashMatch}`, "integrity");
  }

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    xmlMatch,
    pdfHashMatch,
  };
}

/**
 * Nächtlicher Job: prüft alle Rechnungen der letzten 30 Tage, die ein
 * persistiertes ZUGFeRD-XML haben, gegen einen Re-Render.
 */
export async function verifyRecentInvoiceIntegrity(daysBack = 30): Promise<{ checked: number; drift: number }> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const rows = await db
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(and(
      gte(invoicesTable.createdAt, cutoff),
      isNotNull(invoicesTable.zugferdXml),
    ));

  let checked = 0;
  let drift = 0;
  for (const row of rows) {
    try {
      const result = await verifyInvoiceIntegrity(row.id);
      if (!result) continue;
      checked++;
      if (!result.xmlMatch || !result.pdfHashMatch) drift++;
    } catch (err) {
      log(`Integrity-Check fehlgeschlagen (Rechnung ${row.id}): ${err}`, "integrity");
    }
  }

  if (checked > 0) {
    log(`Integrity-Check: ${checked} Rechnungen geprüft, ${drift} mit Drift`, "integrity");
  }
  return { checked, drift };
}
