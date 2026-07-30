import { eq, and, inArray } from "drizzle-orm";
import {
  insuranceProviders,
  budgetTransactions,
  type Customer,
} from "@shared/schema";
import { db } from "../lib/db";
import { storage } from "../storage";
import { resolveCustomerInsuranceAt } from "../storage/customer-mgmt/insurance";
import type { InvoicePdfData } from "../lib/pdf-generator";
import { applyLeistungsnachweisCustomerAddress } from "../lib/customer-address-format";

export const MONTH_NAMES_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/**
 * Lädt die im ABRECHNUNGSZEITRAUM gültige Pflegekassenzuordnung
 * (`customer_insurance_history`) und — falls vorhanden — den zugehörigen
 * `insurance_providers`-Datensatz für den Rechnungsversand. Gibt die rohen
 * Query-Arrays zurück (wie zuvor inline in `/send` und `/send-batch`), damit die
 * Aufrufer ihre jeweilige Fehlerbehandlung (throw vs. results-collect) und
 * Audit-Metadaten unverändert behalten.
 *
 * Task #1893 — Stichtag statt `valid_to IS NULL`: eine Mai-Rechnung, die im Juli
 * versendet wird, muss an die im MAI gültige Kasse gehen. Der Stichtag kommt aus
 * dem Abrechnungsmonat der Rechnung (`billingPeriodAsOfISO`).
 */
export async function loadInsuranceForSend(customerId: number, asOfISO: string): Promise<{
  insHist: { providerId: number; versichertennummer: string | null }[];
  provider: (typeof insuranceProviders.$inferSelect)[];
}> {
  const ins = await resolveCustomerInsuranceAt(customerId, asOfISO);
  if (!ins) return { insHist: [], provider: [] };

  const insHist = [{
    providerId: ins.insuranceProviderId,
    versichertennummer: ins.versichertennummer,
  }];

  const provider = await db.select()
    .from(insuranceProviders)
    .where(eq(insuranceProviders.id, ins.insuranceProviderId))
    .limit(1);

  return { insHist, provider };
}

/**
 * Prüft, ob für eine Rechnung mindestens ein konsumierter §39/§42a-Anteil
 * gebucht ist (steuert die Empfänger-E-Mail-Adresse bei Verhinderungspflege).
 * Kapselt die zuvor in beiden Send-Routen identische Lese-Logik
 * (Line-Items → Appointment-IDs → `budget_transactions`-Consumption).
 */
export async function detectHasParagraph39(invoiceId: number): Promise<boolean> {
  const lineItemsForCheck = await storage.getInvoiceLineItems(invoiceId);
  const appointmentIds = lineItemsForCheck.map(li => li.appointmentId).filter(Boolean) as number[];
  if (appointmentIds.length === 0) return false;
  const txns = await db.select({ budgetType: budgetTransactions.budgetType })
    .from(budgetTransactions)
    .where(and(
      inArray(budgetTransactions.appointmentId, appointmentIds),
      eq(budgetTransactions.transactionType, "consumption"),
    ));
  return txns.some(t => t.budgetType === "ersatzpflege_39_42a");
}

/**
 * Setzt die kundenspezifischen Empfänger-/Adressfelder auf den `pdfData`,
 * exakt wie zuvor inline in `/send` und `/send-batch`:
 * - Geburtsdatum (für Leistungsnachweis-Kopf),
 * - Beihilfe-Flag,
 * - bei Kostenerstattung (`rechnungAnKunde`): Empfängername + -adresse
 *   auf die Kundenanschrift umstellen (Fallback auf bestehende Adresse).
 */
export function applyCustomerPdfRecipient(
  pdfData: InvoicePdfData,
  cust: Customer,
  opts: { isBeihilfe: boolean; isKostenerstattung: boolean },
): void {
  if (cust.geburtsdatum) pdfData.customerGeburtsdatum = cust.geburtsdatum;
  if (opts.isBeihilfe) pdfData.beihilfeBerechtigt = true;
  if (opts.isKostenerstattung) {
    pdfData.rechnungAnKunde = true;
    const customerFullName = [cust.vorname, cust.nachname].filter(Boolean).join(" ") || cust.name;
    const customerAddr = [cust.strasse, cust.nr].filter(Boolean).join(" ") +
      (cust.plz || cust.stadt ? `\n${cust.plz || ""} ${cust.stadt || ""}` : "");
    pdfData.recipientName = customerFullName;
    pdfData.recipientAddress = customerAddr || pdfData.recipientAddress;
  }

  // Task #1041 — LN-Adress-Korrektur über die EINZIGE Quelle (siehe
  // `applyLeistungsnachweisCustomerAddress`). Im Versand-Pfad (Cache-Miss →
  // on-demand-Render des LN) wird sonst die Kassen-Anschrift auf den LN
  // gedruckt. Die geteilte Funktion garantiert, dass emailter und gecachter LN
  // denselben Patient-Wohnort tragen — byte-identisch zum Cache-/Persist-Pfad
  // in `invoice-pdf-orchestrator.buildInvoicePdfData`.
  applyLeistungsnachweisCustomerAddress(pdfData, cust);
}

/**
 * Erzeugt aus Rechnung + Leistungsnachweis je eine doppelte Ausfertigung
 * (Seiten 2×) für Beihilfe-berechtigte Kunden — byte-identisch zur zuvor in
 * beiden Send-Routen duplizierten pdf-lib-Logik.
 */
export async function doubleBeihilfePdfs(
  invoicePdf: Buffer,
  lnPdf: Buffer,
): Promise<{ invoicePdf: Buffer; lnPdf: Buffer }> {
  const { PDFDocument } = await import("pdf-lib");

  const mergedInv = await PDFDocument.create();
  const invDoc = await PDFDocument.load(invoicePdf);
  const invPages1 = await mergedInv.copyPages(invDoc, invDoc.getPageIndices());
  invPages1.forEach(p => mergedInv.addPage(p));
  const invPages2 = await mergedInv.copyPages(invDoc, invDoc.getPageIndices());
  invPages2.forEach(p => mergedInv.addPage(p));
  const finalInvoicePdf = Buffer.from(await mergedInv.save());

  const mergedLn = await PDFDocument.create();
  const lnDoc = await PDFDocument.load(lnPdf);
  const lnPages1 = await mergedLn.copyPages(lnDoc, lnDoc.getPageIndices());
  lnPages1.forEach(p => mergedLn.addPage(p));
  const lnPages2 = await mergedLn.copyPages(lnDoc, lnDoc.getPageIndices());
  lnPages2.forEach(p => mergedLn.addPage(p));
  const finalLnPdf = Buffer.from(await mergedLn.save());

  return { invoicePdf: finalInvoicePdf, lnPdf: finalLnPdf };
}

/**
 * Baut die einzeilige Postanschrift des Kunden für die Versandhistorie
 * (`deliveries.recipientAddress`) — identisch zu beiden Send-Routen.
 */
export function buildCustomerPostAddress(cust: Customer): string {
  return [cust.strasse, cust.nr, cust.plz, cust.stadt].filter(Boolean).join(", ");
}
