import crypto from "crypto";
// Task #521: getBrowser/withFreshPage werden lazy via dynamic import in
// `generatePdf` geladen, damit der ESM-Init nicht den Chromium-Launch antriggert.
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { formatEuroDE } from "@shared/utils/money";
import { renderLineItemQuantity, isKmLineItem, type LineItemQuantityUnit } from "@shared/domain/invoice-line-items";
import { isSignatureImageMeaningful } from "./signature-validation";

export interface InvoicePdfData {
  // Company data
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyWebsite: string | null;
  steuernummer: string | null;
  ustId: string | null;
  iban: string;
  bic: string;
  bankName: string;
  ikNummer: string | null;
  geschaeftsfuehrer: string | null;
  
  // Invoice data
  invoiceNumber: string;
  invoiceDate: string;
  // Task #562 — Fälligkeitsdatum (BT-9). Im DE-Format (DD.MM.YYYY) zur PDF-
  // Anzeige; an `embedZugferdXml`/`buildZugferdData` als String — der XML-
  // Builder parst es zurück über `parseDateString`.
  invoiceDueDate: string | null;
  // Task #562 — Käuferreferenz (BT-10). Fällt beim Render auf Versicherten-Nr.
  // zurück, sodass Pflegekassen-PDFs auch ohne explizites Aktenzeichen
  // ein dunkelverarbeitbares Feld tragen.
  buyerReference: string | null;
  invoiceType: string; // rechnung, stornorechnung (historische Zeilen ggf. "nachberechnung" — werden als "RECHNUNG" gerendert, siehe Task #585)
  billingType: string; // pflegekasse_gesetzlich, pflegekasse_privat, selbstzahler
  billingMonth: number;
  billingYear: number;
  
  // Recipient
  recipientName: string;
  recipientAddress: string | null;
  
  // Insurance (for pflegekasse types)
  insuranceProviderName: string | null;
  insuranceIkNummer: string | null;
  versichertennummer: string | null;
  pflegegrad: number | null;
  
  // Customer info (always needed for reference)
  customerName: string;
  customerAddress: string | null;
  customerGeburtsdatum: string | null;

  // Task #562 — Abtretungs-Bezug, strukturiert für ZUGFeRD-Dunkel-
  // verarbeitung (Abtretungserklärung-Footer).
  assignmentDeclarationDate: string | null;
  assignmentDeclarationRef: string | null;
  
  // Line items
  lineItems: {
    appointmentId: number | null;
    appointmentDate: string;
    startTime: string | null;
    endTime: string | null;
    serviceDescription: string;
    serviceCode: string | null;
    durationMinutes: number;
    // Task #561: explizite Menge + Einheit. NULL für historische Zeilen
    // (vor Migration); Template fällt dann auf `durationMinutes` zurück.
    quantityRaw?: number | null;
    quantityUnit?: LineItemQuantityUnit | string | null;
    unitPriceCents: number;
    totalCents: number;
    employeeName: string | null;
    appointmentNotes: string | null;
    serviceDetails: string | null;
  }[];
  
  // Totals
  netAmountCents: number;
  vatAmountCents: number;
  grossAmountCents: number;
  vatRate: number;
  
  // Notes
  notes: string | null;

  // Beihilfe
  beihilfeBerechtigt?: boolean;

  // Kostenerstattungsverfahren — gesetzlich versicherter Kunde zahlt selbst
  // und reicht die Rechnung bei der Pflegekasse zur Erstattung ein.
  // Wirkung: Layout/Empfänger/Zahlung wie pflegekasse_privat, aber mit
  // angepasster Kostenerstattungs-Formulierung.
  rechnungAnKunde?: boolean;

  // Employee qualifications (for Leistungsnachweis header)
  employeeQualifications?: Map<string, string>;
  
  // Signatures (for Leistungsnachweis)
  signatures?: {
    employeeSignatureData: string | null;
    employeeSignedAt: string | null;
    employeeName: string | null;
    customerSignatureData: string | null;
    customerSignedAt: string | null;
    customerName: string | null;
    appointmentIds: number[];
    recordType: string;
  }[];
}

function formatCents(cents: number): string {
  return formatEuroDE(cents);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isValidDataUrl(str: string): boolean {
  return /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/.test(str.trim());
}

// Task #749 — defensiver "Sieht das Bild auch wirklich nach Unterschrift
// aus?"-Check für den Leistungsnachweis-Renderer. Wird ein leeres oder
// trivial-kleines Signatur-Bild übergeben, fällt der Renderer auf den
// "noch nicht unterschrieben"-Branch zurück statt einen signierten Label
// neben einem leeren <img> auszugeben (Drift-Pfad aus RE-2026-0010).
function isMeaningfulSignatureForRender(value: string | null | undefined): boolean {
  if (!value) return false;
  if (!isValidDataUrl(value)) return false;
  if (!/^data:image\/(png|jpeg);base64,/.test(value.trim())) {
    // SVG signatures bypass the meaningful-pixel check (no PNG/JPEG path).
    return true;
  }
  if (isSignatureImageMeaningful(value)) return true;
  // Audit-grade Strukturlog: Falls hier ein Signatur-Bild durchrutscht, ist
  // die Server-Validierung in signServiceRecord umgangen worden (Drift, Bug
  // oder ältere Bestandsdaten vor Task #749). Aggregations-Pipelines können
  // auf das `[AUDIT][signature]`-Präfix matchen.
  console.warn(
    "[AUDIT][signature] RE-2026-0010-guard: stored signature data URL rejected as empty/trivial — falling back to unsigned-text branch in LN-renderer",
    JSON.stringify({
      event: "signature.render.fallback_empty",
      severity: "warn",
      dataUrlPrefix: value.slice(0, 32),
      byteLength: value.length,
    }),
  );
  return false;
}

function formatDate(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return dateStr;
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} Min.`;
  if (m === 0) return `${h} Std.`;
  return `${h} Std. ${m} Min.`;
}

const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function getInvoiceTypeLabel(type: string): string {
  // Task #585: "nachberechnung" wurde abgeschafft. Historische Zeilen mit
  // diesem Typ werden einheitlich als "RECHNUNG" gerendert.
  switch (type) {
    case "stornorechnung": return "STORNORECHNUNG";
    default: return "RECHNUNG";
  }
}

function getBillingTypeNote(billingType: string, insuranceProviderName: string | null, beihilfeBerechtigt?: boolean, rechnungAnKunde?: boolean): string {
  // Im Kostenerstattungsverfahren (gesetzlich + rechnungAnKunde) wird
  // dieselbe Hinweisformulierung wie bei pflegekasse_privat verwendet.
  if (isCustomerAddressedInvoice(billingType, rechnungAnKunde)) {
    return `Zur Erstattung bei Ihrer Pflegekasse${insuranceProviderName ? ` (${insuranceProviderName})` : ""} einzureichen. Abrechnung des Entlastungsbetrags nach § 45b SGB XI.${beihilfeBerechtigt ? " Diese Rechnung wurde in doppelter Ausfertigung erstellt — für Ihre Pflegekasse und Ihre Beihilfestelle." : ""}`;
  }
  switch (billingType) {
    case "pflegekasse_gesetzlich":
      return `Abrechnung gemäß Abtretungserklärung über den Entlastungsbetrag nach § 45b SGB XI.`;
    case "selbstzahler":
      return "";
    default:
      return "";
  }
}

/**
 * Liefert true, wenn die Rechnung effektiv an den Kunden adressiert ist
 * (Layout/Empfänger/Zahlung wie pflegekasse_privat).
 */
function isCustomerAddressedInvoice(billingType: string, rechnungAnKunde?: boolean): boolean {
  if (billingType === "pflegekasse_privat") return true;
  if (billingType === "pflegekasse_gesetzlich" && rechnungAnKunde) return true;
  return false;
}

function getBudgettopfLabel(billingType: string): string {
  switch (billingType) {
    case "pflegekasse_gesetzlich":
      return "§ 45b SGB XI – Entlastungsbetrag";
    case "pflegekasse_privat":
      return "§ 45b SGB XI – Entlastungsbetrag (privat)";
    case "selbstzahler":
      return "Selbstzahler";
    default:
      return billingType;
  }
}

function getConfirmTextForBillingType(billingType: string, rechnungAnKunde?: boolean): string {
  // Kostenerstattungsverfahren erhält dieselbe Bestätigungsformulierung
  // wie pflegekasse_privat.
  if (isCustomerAddressedInvoice(billingType, rechnungAnKunde)) {
    return "und zur Erstattung des Entlastungsbetrags nach § 45b SGB XI bei der zuständigen Pflegekasse eingereicht werden dürfen";
  }
  switch (billingType) {
    case "pflegekasse_gesetzlich":
      return "und zur Abrechnung des Entlastungsbetrags nach § 45b SGB XI bei der zuständigen Pflegekasse eingereicht werden dürfen";
    case "selbstzahler":
      return "";
    default:
      return "";
  }
}

export function generateInvoiceHtml(data: InvoicePdfData): string {
  const today = new Date();
  const invoiceDate = data.invoiceDate || `${today.getDate().toString().padStart(2, "0")}.${(today.getMonth() + 1).toString().padStart(2, "0")}.${today.getFullYear()}`;
  const periodLabel = `${MONTH_NAMES[data.billingMonth - 1]} ${data.billingYear}`;
  const typeLabel = getInvoiceTypeLabel(data.invoiceType);
  const billingNote = getBillingTypeNote(data.billingType, data.insuranceProviderName, data.beihilfeBerechtigt, data.rechnungAnKunde);
  const isStorno = data.invoiceType === "stornorechnung";
  const isSelbstzahler = data.billingType === "selbstzahler";
  const isCustomerInvoice = isCustomerAddressedInvoice(data.billingType, data.rechnungAnKunde);
  const vatMultiplier = isSelbstzahler && data.vatRate > 0 ? (1 + data.vatRate / 10000) : 1;
  
  const lineItemsHtml = data.lineItems.map(item => {
    const isKm = isKmLineItem(item.serviceCode);
    // Task #561: zentrale Quantity-Anzeige — nutzt `quantityRaw`/`quantityUnit`
    // wenn vorhanden, sonst Fallback auf `durationMinutes` (historische Zeilen).
    const quantityDisplay = renderLineItemQuantity(item);
    const unitLabel = isKm ? "/km" : "/Std.";
    const displayUnitPrice = Math.round(item.unitPriceCents * vatMultiplier);
    const displayTotal = Math.round(item.totalCents * vatMultiplier);
    // Task #565: 0,00-€-Zeilen als „kostenlos" kennzeichnen, damit unterscheidbar
    // von versehentlich fehlenden Preisen. Nur für reguläre Rechnungen (nicht Storno,
    // dort sind negative/0-Beträge erwartetes Verhalten).
    const isFreeLine = !isStorno && item.unitPriceCents === 0 && item.totalCents === 0;
    const freeHint = isFreeLine
      ? `<div style="font-size: 8pt; color: #047857; font-style: italic; margin-top: 2px;">kostenlos</div>`
      : "";
    return `
    <tr>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${formatDate(item.appointmentDate)}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${item.startTime ? item.startTime.slice(0, 5) : ""}-${item.endTime ? item.endTime.slice(0, 5) : ""}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(item.serviceDescription)}${freeHint}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${quantityDisplay}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(displayUnitPrice)}${unitLabel}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: ${isStorno ? 'bold; color: #dc2626' : '500'};">${formatCents(displayTotal)}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <style>
    @page { margin: 20mm 15mm; size: A4; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #1f2937; line-height: 1.5; margin: 0; padding: 0; }
    .header { display: flex; justify-content: space-between; margin-bottom: 30px; }
    .company-info { font-size: 9pt; color: #1f2937; }
    .company-name { font-size: 14pt; font-weight: bold; color: #0d9488; margin-bottom: 4px; }
    .recipient { margin-bottom: 20px; min-height: 80px; }
    .recipient-label { font-size: 9pt; color: #4b5563; margin-bottom: 2px; }
    .invoice-meta { display: flex; justify-content: space-between; margin-bottom: 20px; }
    .invoice-title { font-size: 16pt; font-weight: bold; color: ${isStorno ? '#dc2626' : '#0d9488'}; }
    .meta-table td { padding: 2px 8px; font-size: 9pt; }
    .meta-table td:first-child { color: #1f2937; }
    .meta-table td:last-child { color: #111827; }
    table.items { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    table.items th { background: #f3f4f6; padding: 8px; text-align: left; font-size: 9pt; font-weight: 600; border-bottom: 2px solid #d1d5db; }
    table.items th:nth-child(4), table.items th:nth-child(5), table.items th:nth-child(6) { text-align: right; }
    .totals { margin-left: auto; width: 300px; }
    .totals td { padding: 4px 8px; white-space: nowrap; }
    .totals td:last-child { text-align: right; }
    .total-row { font-weight: bold; font-size: 12pt; border-top: 2px solid #0d9488; }
    .footer { margin-top: 18px; font-size: 8pt; color: #4b5563; border-top: 1px solid #e5e7eb; padding-top: 6px; text-align: center; page-break-inside: avoid; }
    .note { margin-top: 15px; padding: 10px; background: #f0fdfa; border-left: 3px solid #0d9488; font-size: 9pt; }
    .insurance-ref { margin-top: 10px; padding: 8px; background: #eff6ff; border: 1px solid #bfdbfe; font-size: 9pt; }
    .payment-block { margin-top: 18px; padding: 12px 14px; border: 1.5px solid #0d9488; background: #f0fdfa; font-size: 9.5pt; page-break-inside: avoid; }
    .payment-block-title { font-size: 11pt; font-weight: bold; color: #0d9488; margin-bottom: 6px; }
    .payment-block table { border-collapse: collapse; }
    .payment-block td { padding: 2px 8px 2px 0; vertical-align: top; }
    .payment-block td.label { color: #4b5563; white-space: nowrap; }
    .payment-block td.value { color: #111827; }
    .payment-block .iban-value { font-weight: bold; font-size: 11pt; letter-spacing: 0.3px; }
    .payment-block .due-line { margin-top: 6px; color: #1f2937; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="company-name">${escapeHtml(data.companyName || "Firma")}</div>
      <div class="company-info">
        ${escapeHtml(data.companyAddress || "")}<br>
        ${data.companyPhone ? `Tel.: ${formatPhoneForDisplay(data.companyPhone)}` : ""}${data.companyEmail ? ` | ${escapeHtml(data.companyEmail)}` : ""}
        ${data.companyWebsite ? `<br>${escapeHtml(data.companyWebsite)}` : ""}
      </div>
    </div>
    <div style="text-align: right;">
      ${data.geschaeftsfuehrer ? `<div class="company-info">Geschäftsführer: ${escapeHtml(data.geschaeftsfuehrer)}</div>` : ""}
      ${data.ikNummer ? `<div class="company-info">IK-Nr.: ${data.ikNummer}</div>` : ""}
      ${data.steuernummer ? `<div class="company-info">St.-Nr.: ${data.steuernummer}</div>` : ""}
      ${data.ustId ? `<div class="company-info">USt-ID: ${data.ustId}</div>` : ""}
    </div>
  </div>

  ${data.billingType === "pflegekasse_gesetzlich" && !data.rechnungAnKunde ? `
  <div style="display: flex; gap: 30px; margin-bottom: 20px;">
    <div class="recipient" style="flex: 1; margin-bottom: 0;">
      <div class="recipient-label">Rechnungsempfänger:</div>
      <strong>${escapeHtml(data.recipientName)}</strong>
      ${data.insuranceIkNummer ? `<br>IK: ${escapeHtml(data.insuranceIkNummer)}` : ""}
      ${data.recipientAddress ? `<br>${escapeHtml(data.recipientAddress).replace(/\n/g, "<br>")}` : ""}
    </div>
    <div class="insurance-ref" style="flex: 1; margin-top: 0;">
      <div class="recipient-label">Versicherte/r:</div>
      <strong>${escapeHtml(data.customerName)}</strong>
      ${data.customerGeburtsdatum ? `<br>Geb.: ${formatDate(data.customerGeburtsdatum)}` : ""}
      ${data.versichertennummer ? `<br>Vers.-Nr.: ${escapeHtml(data.versichertennummer)}` : ""}
      ${data.pflegegrad ? `<br>Pflegegrad: ${data.pflegegrad}` : ""}
    </div>
  </div>
  ` : isCustomerInvoice ? `
  <div class="recipient">
    <div class="recipient-label">Rechnungsempfänger:</div>
    <strong>${escapeHtml(data.recipientName)}</strong>
    ${data.recipientAddress ? `<br>${escapeHtml(data.recipientAddress).replace(/\n/g, "<br>")}` : ""}
    ${data.customerGeburtsdatum ? `<br>Geb.: ${formatDate(data.customerGeburtsdatum)}` : ""}
  </div>
  <div class="insurance-ref" style="margin-bottom: 20px;">
    <div style="font-weight: 600; margin-bottom: 4px;">Versicherungsdaten (zur Vorlage bei Ihrer Pflegekasse):</div>
    ${data.insuranceProviderName ? `Pflegekasse: <strong>${escapeHtml(data.insuranceProviderName)}</strong>` : ""}
    ${data.insuranceIkNummer ? `<br>IK-Nr.: ${escapeHtml(data.insuranceIkNummer)}` : ""}
    ${data.versichertennummer ? `<br>Vers.-Nr.: ${escapeHtml(data.versichertennummer)}` : ""}
    ${data.pflegegrad ? `<br>Pflegegrad: ${data.pflegegrad}` : ""}
  </div>
  ` : `
  <div class="recipient">
    <div class="recipient-label">Empfänger:</div>
    <strong>${escapeHtml(data.recipientName)}</strong>
    ${data.recipientAddress ? `<br>${escapeHtml(data.recipientAddress).replace(/\n/g, "<br>")}` : ""}
  </div>
  `}

  <div class="invoice-meta">
    <div class="invoice-title">${typeLabel}</div>
    <table class="meta-table">
      <tr><td>Rechnungsnr.:</td><td><strong>${data.invoiceNumber}</strong></td></tr>
      <tr><td>Rechnungsdatum:</td><td>${invoiceDate}</td></tr>
      ${data.invoiceDueDate ? `<tr><td>Fällig am:</td><td>${escapeHtml(data.invoiceDueDate)}</td></tr>` : ""}
      ${data.buyerReference ? `<tr><td>Käuferreferenz:</td><td>${escapeHtml(data.buyerReference)}</td></tr>` : ""}
      <tr><td>Leistungszeitraum:</td><td>${periodLabel}</td></tr>
    </table>
  </div>

  <p>Für die im Zeitraum <strong>${periodLabel}</strong> erbrachten Leistungen${data.billingType === "pflegekasse_gesetzlich" || data.billingType === "pflegekasse_privat" ? " gemäß § 45b Abs. 1 Satz 3 Nr. 4 SGB XI (Angebote zur Unterstützung im Alltag gem. § 45a SGB XI)" : ""} berechnen wir:</p>

  <table class="items">
    <thead>
      <tr>
        <th>Datum</th>
        <th>Uhrzeit</th>
        <th>Leistung</th>
        <th>Dauer</th>
        <th>Satz${isSelbstzahler ? " (brutto)" : ""}</th>
        <th>Betrag${isSelbstzahler ? " (brutto)" : ""}</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemsHtml}
    </tbody>
  </table>

  ${isSelbstzahler ? `<div style="font-size: 9pt; color: #4b5563; margin-bottom: 10px;">Alle Einzelbeträge verstehen sich inkl. ${(data.vatRate / 100).toFixed(0)}% MwSt.</div>` : ""}

  <table class="totals">
    <tr><td>Nettobetrag:</td><td>${formatCents(data.netAmountCents)}</td></tr>
    ${data.vatAmountCents !== 0 ? `<tr><td>USt. ${(data.vatRate / 100).toFixed(0)}%:</td><td>${formatCents(data.vatAmountCents)}</td></tr>` : `<tr><td colspan="2" style="font-size: 9pt; color: #1f2937;">Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG</td></tr>`}
    <tr class="total-row"><td>Gesamtbetrag${isSelbstzahler ? " (inkl. MwSt.)" : ""}:</td><td style="color: ${isStorno ? '#dc2626' : 'inherit'};">${formatCents(data.grossAmountCents)}</td></tr>
  </table>

  ${billingNote ? `<div class="note">${billingNote}</div>` : ""}

  ${(() => {
    // Task #755 — vereinheitlichter Zahlungsblock für ALLE Rechnungstypen.
    // Verwendungszweck wird deterministisch aus Rechnungsnummer (+ optional
    // Käuferreferenz/Versichertennummer) gebildet. Bei Storno wird kein
    // Zahlungsaufruf gerendert, sondern ein Hinweis auf den Stornocharakter
    // — aber die Kontodaten bleiben sichtbar (Pflichtangaben).
    const purposeParts = [`Rechnungsnr. ${data.invoiceNumber}`];
    if (data.buyerReference) {
      purposeParts.push(`Käuferreferenz ${data.buyerReference}`);
    }
    const purpose = purposeParts.join(", ");
    const stornoPurpose = `Storno zu Rechnungsnr. ${data.invoiceNumber}`;

    let dueLine = "";
    if (isStorno) {
      dueLine = `<div class="due-line">Diese Stornorechnung hebt die zugrunde liegende Rechnung auf. Es ist keine Zahlung zu leisten.</div>`;
    } else if (isSelbstzahler || isCustomerInvoice) {
      dueLine = data.invoiceDueDate
        ? `<div class="due-line">Bitte überweisen Sie den Betrag bis zum <strong>${escapeHtml(data.invoiceDueDate)}</strong> auf folgendes Konto.</div>`
        : `<div class="due-line">Bitte überweisen Sie den Betrag zeitnah auf folgendes Konto.</div>`;
    } else {
      dueLine = `<div class="due-line">Bitte überweisen Sie den Betrag auf folgendes Konto.</div>`;
    }

    const accountHolder = data.companyName || "";
    const purposeForBlock = isStorno ? stornoPurpose : purpose;

    return `
  <div class="payment-block">
    <div class="payment-block-title">Zahlungsinformationen</div>
    ${dueLine}
    <table>
      ${accountHolder ? `<tr><td class="label">Kontoinhaber:</td><td class="value">${escapeHtml(accountHolder)}</td></tr>` : ""}
      <tr><td class="label">IBAN:</td><td class="value iban-value">${escapeHtml(data.iban)}</td></tr>
      <tr><td class="label">BIC:</td><td class="value">${escapeHtml(data.bic)}</td></tr>
      ${data.bankName ? `<tr><td class="label">Bank:</td><td class="value">${escapeHtml(data.bankName)}</td></tr>` : ""}
      <tr><td class="label">Verwendungszweck:</td><td class="value">${escapeHtml(purposeForBlock)}</td></tr>
    </table>
    ${isCustomerInvoice && !isStorno ? `<div style="margin-top: 8px; color: #4b5563; font-size: 9pt;">Diese Rechnung können Sie zusammen mit dem beigefügten Leistungsnachweis bei Ihrer Pflegekasse zur Erstattung einreichen.</div>` : ""}
  </div>`;
  })()}

  ${data.notes ? `<div style="margin-top: 12px; font-size: 9pt; color: #1f2937;"><strong>Hinweis:</strong> ${escapeHtml(data.notes)}</div>` : ""}

  <div class="footer">
    ${escapeHtml(data.companyName || "")}${data.geschaeftsfuehrer ? ` &middot; Geschäftsführer: ${escapeHtml(data.geschaeftsfuehrer)}` : ""}${data.steuernummer ? ` &middot; St.-Nr. ${escapeHtml(data.steuernummer)}` : ""}${data.ustId ? ` &middot; USt-ID ${escapeHtml(data.ustId)}` : ""}
  </div>
</body>
</html>`;
}

export function generateLeistungsnachweisHtml(data: InvoicePdfData): string {
  const periodLabel = `${MONTH_NAMES[data.billingMonth - 1]} ${data.billingYear}`;
  const isSelbstzahler = data.billingType === "selbstzahler";
  const vatMultiplier = isSelbstzahler && data.vatRate > 0 ? (1 + data.vatRate / 10000) : 1;

  const KM_CODES = ["travel_km", "customer_km"];
  const isKmItem = (item: typeof data.lineItems[0]) => KM_CODES.includes(item.serviceCode || "");

  type LineItem = typeof data.lineItems[0];
  // Task #571: Notizen werden bewusst nicht mehr ins Kundendokument
  // übernommen — sie bleiben interna im DB-Modell.
  type AppointmentGroup = { dateTimeKey: string; date: string; time: string; services: LineItem[]; kmItems: LineItem[] };

  function sortItems(items: LineItem[]): LineItem[] {
    return [...items].sort((a, b) => {
      const dateCmp = a.appointmentDate.localeCompare(b.appointmentDate);
      if (dateCmp !== 0) return dateCmp;
      const timeCmp = (a.startTime || "").localeCompare(b.startTime || "");
      if (timeCmp !== 0) return timeCmp;
      return (a.appointmentId ?? 0) - (b.appointmentId ?? 0);
    });
  }

  function groupByAppointment(items: LineItem[]): AppointmentGroup[] {
    const groups: AppointmentGroup[] = [];
    let currentGroup: AppointmentGroup | null = null;
    for (const item of items) {
      const groupKey = item.appointmentId != null
        ? `id:${item.appointmentId}`
        : `${item.appointmentDate}|${item.startTime || ""}|${item.endTime || ""}`;
      if (!currentGroup || currentGroup.dateTimeKey !== groupKey) {
        currentGroup = {
          dateTimeKey: groupKey,
          date: formatDate(item.appointmentDate),
          time: `${item.startTime ? item.startTime.slice(0, 5) : ""} - ${item.endTime ? item.endTime.slice(0, 5) : ""}`,
          services: [],
          kmItems: [],
        };
        groups.push(currentGroup);
      }
      if (isKmItem(item)) {
        currentGroup.kmItems.push(item);
      } else {
        currentGroup.services.push(item);
      }
    }
    return groups;
  }

  function renderTableRows(groups: AppointmentGroup[]): string {
    return groups.map((group) => {
      const rows: string[] = [];
      for (let i = 0; i < group.services.length; i++) {
        const svc = group.services[i];
        const showDateCol = i === 0;
        const displayUnitPrice = Math.round(svc.unitPriceCents * vatMultiplier);
        const displayTotal = Math.round(svc.totalCents * vatMultiplier);
        rows.push(`
        <tr>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${showDateCol ? group.date : ""}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${showDateCol ? group.time : ""}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(svc.serviceDescription)}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; font-size: 9pt;">${svc.serviceDetails ? escapeHtml(svc.serviceDetails) : ""}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatMinutes(svc.durationMinutes)}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(displayUnitPrice)}/Std.</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(displayTotal)}</td>
        </tr>`);
      }
      for (const km of group.kmItems) {
        const kmLabel = km.serviceCode === "customer_km" ? "Fahrten für/mit Kunde" : "Anfahrt";
        const displayKmUnitPrice = Math.round(km.unitPriceCents * vatMultiplier);
        const displayKmTotal = Math.round(km.totalCents * vatMultiplier);
        // Task #561: km-Anzeige via Helper — Menge × Satz = Summe konsistent.
        const kmQuantityDisplay = renderLineItemQuantity(km);
        // Task #584: Anfahrt-Zeilen tragen Datum + Termin-Bezug, damit
        // Sachbearbeiter die Fahrt eindeutig einem Termin zuordnen können.
        const kmDate = km.appointmentDate ? formatDate(km.appointmentDate) : "";
        const kmStartHHMM = km.startTime ? km.startTime.slice(0, 5) : "";
        const kmDescription = kmStartHHMM
          ? `${escapeHtml(kmLabel)} – im Zusammenhang mit Termin ${escapeHtml(kmStartHHMM)}`
          : escapeHtml(kmLabel);
        rows.push(`
        <tr>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${kmDate}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;"></td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${kmDescription}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;"></td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${kmQuantityDisplay}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(displayKmUnitPrice)}/km</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(displayKmTotal)}</td>
        </tr>`);
      }
      return rows.join("");
    }).join("");
  }

  /**
   * Task #571: Ein einziger, neutral gestalteter Bestätigungs-/Abtretungs-
   * Absatz direkt über den Unterschriftsfeldern. Ersetzt die früheren zwei
   * Kästen (grüner Bestätigungssatz + gelber Abtretungsblock). Re-verwendet
   * `getConfirmTextForBillingType` + die bestehende Abtretungs-Fallunter-
   * scheidung, damit die Logik genau einmal lebt.
   */
  function renderConfirmationBlock(): string {
    const confirmSuffix = getConfirmTextForBillingType(data.billingType, data.rechnungAnKunde);
    const confirmSentence = `Ich bestätige hiermit, dass die aufgeführten Leistungen wie oben beschrieben erbracht wurden${confirmSuffix ? " " + confirmSuffix : ""}.`;

    // Abtretungserklärung-Bedingung identisch zur Vorgänger-Logik:
    // entfällt bei Selbstzahler und im Kostenerstattungsverfahren (gesetzlich
    // + rechnungAnKunde), bleibt bei pflegekasse_gesetzlich (klassisch) und
    // pflegekasse_privat.
    const includesAbtretung = data.billingType !== "selbstzahler"
      && !(isCustomerAddressedInvoice(data.billingType, data.rechnungAnKunde) && data.billingType !== "pflegekasse_privat");

    let abtretungSentence = "";
    if (includesAbtretung) {
      abtretungSentence = ` Der/Die Leistungsempfänger/in tritt hiermit seinen/ihren Anspruch auf Kostenerstattung gegenüber der Pflegekasse in Höhe des abgerechneten Betrages an ${escapeHtml(data.companyName || "")} ab (§ 398 BGB).${data.ikNummer ? ` IK-Nr.: ${escapeHtml(data.ikNummer)}.` : ""}${data.assignmentDeclarationDate ? ` Abtretungserklärung vom ${formatDate(data.assignmentDeclarationDate)}${data.assignmentDeclarationRef ? ` (Az. ${escapeHtml(data.assignmentDeclarationRef)})` : ""}.` : ""} Die Unterschrift unter dem Leistungsnachweis gilt gleichzeitig als Abtretungserklärung.`;
    }

    return `<div class="confirm-block">${confirmSentence}${abtretungSentence}</div>`;
  }

  // Task #571: ab dieser Zeilenanzahl pro Abschnitt wird die Tabellen-
  // Darstellung verdichtet (kleinere Schrift + Padding), damit Kopf, Tabelle,
  // Bestätigung und Unterschriften zusammen auf eine A4-Seite passen.
  const COMPACT_ROW_THRESHOLD = 12;
  function sectionRowCount(groups: AppointmentGroup[]): number {
    return groups.reduce((sum, g) => sum + g.services.length + g.kmItems.length, 0);
  }
  function tableClassForGroups(groups: AppointmentGroup[]): string {
    return sectionRowCount(groups) > COMPACT_ROW_THRESHOLD ? "items compact" : "items";
  }

  function cleanDataUrl(dataUrl: string): string {
    return dataUrl.replace(/\s/g, "");
  }

  function renderSignature(sig: NonNullable<InvoicePdfData["signatures"]>[0], fallbackEmployeeLabel: string): string {
    const custSigValid = isMeaningfulSignatureForRender(sig.customerSignatureData);
    const empSigValid = isMeaningfulSignatureForRender(sig.employeeSignatureData);
    const custSigClean = custSigValid ? cleanDataUrl(sig.customerSignatureData!) : "";
    const empSigClean = empSigValid ? cleanDataUrl(sig.employeeSignatureData!) : "";
    return `
    <div class="signature-area">
      <div class="signature-box">
        ${custSigValid ? `
          <div class="signature-img-wrapper">
            <img src="${custSigClean}" class="signature-img" />
          </div>
          <div class="signature-line signature-line-signed">
            ${escapeHtml(sig.customerSignedAt || "")}, ${escapeHtml(sig.customerName || data.customerName)}<br>
            <span style="color: #4b5563;">(Leistungsempfänger/in)</span>
          </div>
        ` : `
          <div class="signature-line">${escapeHtml(data.customerName)}<br><span style="color: #4b5563;">(Leistungsempfänger/in oder gesetzl. Vertreter/in)</span></div>
        `}
      </div>
      <div class="signature-box">
        ${empSigValid ? `
          <div class="signature-img-wrapper">
            <img src="${empSigClean}" class="signature-img" />
          </div>
          <div class="signature-line signature-line-signed">
            ${escapeHtml(sig.employeeSignedAt || "")}, ${escapeHtml(sig.employeeName || "")}<br>
            <span style="color: #4b5563;">(Leistungserbringer/in)</span>
          </div>
        ` : `
          <div class="signature-line">${fallbackEmployeeLabel}<br><span style="color: #4b5563;">(Leistungserbringer/in)</span></div>
        `}
      </div>
    </div>`;
  }

  const allSorted = sortItems(data.lineItems);
  const employeeNames = Array.from(new Set(allSorted.map(i => i.employeeName).filter(Boolean))) as string[];
  const employeeLabel = employeeNames.length > 0 ? employeeNames.map(escapeHtml).join(", ") : "Leistungserbringer/in";

  const hasMultipleLNs = data.signatures && data.signatures.length > 1 && data.signatures.some(s => s.appointmentIds.length > 0);

  let sectionsHtml: string;

  if (hasMultipleLNs && data.signatures) {
    const sections: string[] = [];

    for (let idx = 0; idx < data.signatures.length; idx++) {
      const sig = data.signatures[idx];
      const apptIdSet = new Set(sig.appointmentIds);
      const sectionItems = sortItems(allSorted.filter(item => item.appointmentId !== null && apptIdSet.has(item.appointmentId)));

      if (sectionItems.length === 0) continue;

      const groups = groupByAppointment(sectionItems);
      const tableRowsHtml = renderTableRows(groups);
      const tableClass = tableClassForGroups(groups);
      const sectionCents = isSelbstzahler
        ? sectionItems.reduce((sum, item) => sum + Math.round(item.totalCents * vatMultiplier), 0)
        : sectionItems.reduce((sum, item) => sum + item.totalCents, 0);

      const sectionLabel = sig.recordType === "single" ? "Einzeltermin-Leistungsnachweis" : "Monatlicher Leistungsnachweis";
      const sectionEmployeeName = sig.employeeName ? escapeHtml(sig.employeeName) : employeeLabel;
      const sectionEmployeeQual = sig.employeeName && data.employeeQualifications ? data.employeeQualifications.get(sig.employeeName) || "" : "";

      sections.push(`
      ${sections.length > 0 ? '<div style="page-break-before: always;"></div>' : ''}

      <section class="ln-section">
        <div class="header">
          <div class="title">LEISTUNGSNACHWEIS</div>
          <div style="font-size: 9pt; color: #1f2937;">
            ${data.companyName || ""} | ${data.ikNummer ? `IK-Nr.: ${data.ikNummer}` : ""}
          </div>
          <div style="font-size: 10pt; font-weight: bold; color: #0d9488; margin-top: 4px;">
            ${sectionLabel}
          </div>
        </div>

        <div class="info-grid">
          <div class="info-box">
            <div class="info-label">Leistungsempfänger/in</div>
            <div class="info-value">${escapeHtml(data.customerName)}</div>
            ${data.customerAddress ? `<div style="font-size: 9pt;">${escapeHtml(data.customerAddress).replace(/\n/g, "<br>")}</div>` : ""}
            ${data.customerGeburtsdatum ? `<div style="font-size: 9pt;">Geb.: ${formatDate(data.customerGeburtsdatum)}</div>` : ""}
          </div>
          <div class="info-box">
            <div class="info-label">Leistungserbringer/in</div>
            <div class="info-value">${sectionEmployeeName}</div>
            ${sectionEmployeeQual ? `<div style="font-size: 9pt; color: #0d9488;">${escapeHtml(sectionEmployeeQual)}</div>` : ""}
          </div>
        </div>
        <div class="info-grid">
          <div class="info-box">
            <div class="info-label">Versicherung</div>
            ${data.versichertennummer ? `<div class="info-value">${escapeHtml(data.versichertennummer)}</div>` : ""}
            ${data.pflegegrad ? `<div style="font-size: 9pt;">Pflegegrad: ${data.pflegegrad}</div>` : ""}
            ${data.insuranceProviderName ? `<div style="font-size: 9pt;">${escapeHtml(data.insuranceProviderName)}${data.insuranceIkNummer ? ` (IK: ${data.insuranceIkNummer})` : ""}</div>` : `<div style="font-size: 9pt; color: #4b5563;">Selbstzahler</div>`}
          </div>
          <div class="info-box">
            <div class="info-label">Zeitraum</div>
            <div class="info-value">${escapeHtml(periodLabel)}</div>
            <div style="font-size: 9pt;">Rechnungsnr.: ${escapeHtml(data.invoiceNumber)}</div>
          </div>
        </div>
        <div class="info-grid">
          <div class="info-box" style="flex: 1;">
            <div class="info-label">Abrechnungsgrundlage</div>
            <div class="info-value" style="font-size: 9pt;">${escapeHtml(getBudgettopfLabel(data.billingType))}</div>
          </div>
        </div>

        <table class="${tableClass}">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Uhrzeit</th>
              <th>Leistung</th>
              <th>Beschreibung</th>
              <th>Dauer/Km</th>
              <th>Einzelpreis${isSelbstzahler ? " (brutto)" : ""}</th>
              <th>Betrag${isSelbstzahler ? " (brutto)" : ""}</th>
            </tr>
          </thead>
          <tbody>
            ${tableRowsHtml}
            <tr class="total-row">
              <td colspan="6">Summe${isSelbstzahler ? " (inkl. MwSt.)" : ""}</td>
              <td style="text-align: right; white-space: nowrap;">${formatCents(sectionCents)}</td>
            </tr>
          </tbody>
        </table>

        <div class="confirm-signature-block">
          ${renderConfirmationBlock()}
          ${renderSignature(sig, sectionEmployeeName)}
        </div>
      </section>
      `);
    }

    sectionsHtml = sections.join("");
  } else {
    const groups = groupByAppointment(allSorted);
    const tableRowsHtml = renderTableRows(groups);
    const tableClass = tableClassForGroups(groups);
    const totalCentsAll = isSelbstzahler
      ? data.grossAmountCents
      : allSorted.reduce((sum, item) => sum + item.totalCents, 0);

    sectionsHtml = `
    <table class="${tableClass}">
      <thead>
        <tr>
          <th>Datum</th>
          <th>Uhrzeit</th>
          <th>Leistung</th>
          <th>Beschreibung</th>
          <th>Dauer/Km</th>
          <th>Einzelpreis${isSelbstzahler ? " (brutto)" : ""}</th>
          <th>Betrag${isSelbstzahler ? " (brutto)" : ""}</th>
        </tr>
      </thead>
      <tbody>
        ${tableRowsHtml}
        <tr class="total-row">
          <td colspan="6">Gesamt${isSelbstzahler ? " (inkl. MwSt.)" : ""}</td>
          <td style="text-align: right; white-space: nowrap;">${formatCents(totalCentsAll)}</td>
        </tr>
      </tbody>
    </table>

    <div style="margin-top: 8px;">
      <table style="width: 300px; margin-left: auto;">
        <tr><td style="padding: 3px 8px;">Gesamtbetrag${isSelbstzahler ? " (inkl. MwSt.)" : ""}:</td><td style="text-align: right; font-weight: bold; white-space: nowrap;">${formatCents(data.grossAmountCents)}</td></tr>
      </table>
    </div>

    <div class="confirm-signature-block">
      ${renderConfirmationBlock()}

      ${data.signatures && data.signatures.length > 0 ? data.signatures.map(s => renderSignature(s, employeeLabel)).join("") : `
      <div class="signature-area">
        <div class="signature-box">
          <div class="signature-line">${escapeHtml(data.customerName)}<br><span style="color: #4b5563;">(Leistungsempfänger/in oder gesetzl. Vertreter/in)</span></div>
        </div>
        <div class="signature-box">
          <div class="signature-line">${employeeLabel}<br><span style="color: #4b5563;">(Leistungserbringer/in)</span></div>
        </div>
      </div>
      `}
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <style>
    @page { margin: 15mm 15mm; size: A4; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #1f2937; line-height: 1.4; margin: 0; padding: 0; }
    .header { margin-bottom: 12px; }
    .title { font-size: 15pt; font-weight: bold; color: #0d9488; margin-bottom: 6px; }
    .info-grid { display: flex; justify-content: space-between; margin-bottom: 10px; }
    .info-box { padding: 6px 8px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; flex: 1; margin-right: 10px; }
    .info-box:last-child { margin-right: 0; }
    .info-label { font-size: 8.5pt; color: #1f2937; margin-bottom: 1px; }
    .info-value { font-weight: 600; }
    table.items { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    table.items th { background: #f3f4f6; padding: 6px 8px; text-align: left; font-size: 9pt; font-weight: 600; border-bottom: 2px solid #d1d5db; }
    table.items th:nth-child(5), table.items th:nth-child(6), table.items th:nth-child(7) { text-align: right; }
    /* Task #571: kompakte Tabellen-Variante für Abschnitte mit vielen Zeilen,
       damit Kopf + Tabelle + Bestätigung + Unterschriften auf eine Seite passen. */
    table.items.compact th { padding: 4px 6px; font-size: 8.5pt; }
    table.items.compact td { padding: 3px 6px !important; font-size: 8.5pt; }
    .total-row td { font-weight: bold; border-top: 2px solid #0d9488; padding: 6px 8px; }
    .signature-area { margin-top: 24px; display: flex; justify-content: space-between; align-items: flex-end; page-break-inside: avoid; break-inside: avoid; }
    .signature-box { width: 45%; position: relative; page-break-inside: avoid; break-inside: avoid; }
    .signature-img-wrapper { position: relative; margin-bottom: -18px; z-index: 1; }
    .signature-img { max-width: 260px; max-height: 130px; filter: brightness(0) saturate(100%) invert(18%) sepia(60%) saturate(600%) hue-rotate(190deg); }
    .signature-line { border-top: 1px solid #1f2937; margin-top: 36px; padding-top: 4px; font-size: 9pt; color: #1f2937; }
    .signature-line-signed { margin-top: 0; }
    .footer { margin-top: 20px; font-size: 9pt; color: #1f2937; border-top: 1px solid #e5e7eb; padding-top: 8px; }
    /* Task #571: Ein neutraler, zusammenhängender Bestätigungs-/Abtretungs-
       Absatz direkt über den Unterschriften — keine farbigen Doppel-Kästen mehr. */
    .confirm-block { margin-top: 12px; padding: 8px 0 4px 0; border-top: 1px solid #e5e7eb; font-size: 9pt; line-height: 1.45; color: #1f2937; text-align: justify; }
    /* Task #571: Bestätigungstext + Unterschriften dürfen nicht über Seiten
       umbrechen — sie bleiben immer zusammen. */
    .confirm-signature-block { page-break-inside: avoid; break-inside: avoid; }
    /* Task #571: Ein Leistungsnachweis-Abschnitt (Kopf, Tabelle, Bestätigung,
       Unterschriften) bleibt auf einer A4-Seite zusammen. Bei Mehrfach-LN
       erzeugt ein eigener page-break-before zwischen Abschnitten den Umbruch. */
    .ln-section { page-break-inside: avoid; break-inside: avoid; }
  </style>
</head>
<body>
  ${hasMultipleLNs ? sectionsHtml : `
  <section class="ln-section">
  <div class="header">
    <div class="title">LEISTUNGSNACHWEIS</div>
    <div style="font-size: 9pt; color: #1f2937;">
      ${data.companyName || ""} | ${data.ikNummer ? `IK-Nr.: ${data.ikNummer}` : ""}
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <div class="info-label">Leistungsempfänger/in</div>
      <div class="info-value">${escapeHtml(data.customerName)}</div>
      ${data.customerAddress ? `<div style="font-size: 9pt;">${escapeHtml(data.customerAddress).replace(/\n/g, "<br>")}</div>` : ""}
      ${data.customerGeburtsdatum ? `<div style="font-size: 9pt;">Geb.: ${formatDate(data.customerGeburtsdatum)}</div>` : ""}
    </div>
    <div class="info-box">
      <div class="info-label">Leistungserbringer/in</div>
      <div class="info-value">${employeeLabel}</div>
      ${(() => {
        if (!data.employeeQualifications || data.employeeQualifications.size === 0) return "";
        const quals = employeeNames.map(n => data.employeeQualifications!.get(n)).filter(Boolean) as string[];
        if (quals.length === 0) return "";
        const uniqueQuals = Array.from(new Set(quals));
        if (employeeNames.length <= 1 || uniqueQuals.length === 1) {
          return `<div style="font-size: 9pt; color: #0d9488;">${uniqueQuals.map(escapeHtml).join(", ")}</div>`;
        }
        return `<div style="font-size: 9pt; color: #0d9488;">${employeeNames.map(n => { const q = data.employeeQualifications!.get(n); return q ? `${escapeHtml(n)}: ${escapeHtml(q)}` : ""; }).filter(Boolean).join("; ")}</div>`;
      })()}
    </div>
  </div>
  <div class="info-grid">
    <div class="info-box">
      <div class="info-label">Versicherung</div>
      ${data.versichertennummer ? `<div class="info-value">${escapeHtml(data.versichertennummer)}</div>` : ""}
      ${data.pflegegrad ? `<div style="font-size: 9pt;">Pflegegrad: ${data.pflegegrad}</div>` : ""}
      ${data.insuranceProviderName ? `<div style="font-size: 9pt;">${escapeHtml(data.insuranceProviderName)}</div>` : `<div style="font-size: 9pt; color: #4b5563;">Selbstzahler</div>`}
    </div>
    <div class="info-box">
      <div class="info-label">Zeitraum</div>
      <div class="info-value">${escapeHtml(periodLabel)}</div>
      <div style="font-size: 9pt;">Rechnungsnr.: ${escapeHtml(data.invoiceNumber)}</div>
    </div>
  </div>
  <div class="info-grid">
    <div class="info-box" style="flex: 1;">
      <div class="info-label">Abrechnungsgrundlage</div>
      <div class="info-value" style="font-size: 9pt;">${escapeHtml(getBudgettopfLabel(data.billingType))}</div>
    </div>
  </div>

  ${sectionsHtml}
  </section>
  `}

  ${hasMultipleLNs ? `
  <div style="margin-top: 30px; border-top: 2px solid #0d9488; padding-top: 10px;">
    <table style="width: 300px; margin-left: auto;">
      <tr><td style="padding: 3px 8px; font-weight: bold;">Gesamtbetrag${isSelbstzahler ? " (inkl. MwSt.)" : ""}:</td><td style="text-align: right; font-weight: bold; white-space: nowrap;">${formatCents(data.grossAmountCents)}</td></tr>
    </table>
  </div>
  ` : ''}

  <div class="footer">
    ${data.companyName || ""} | ${data.companyAddress || ""} | ${data.companyPhone ? `Tel.: ${formatPhoneForDisplay(data.companyPhone)}` : ""} | ${data.companyEmail || ""}
  </div>
</body>
</html>`;
}

export async function generatePdf(html: string): Promise<{ buffer: Buffer; hash: string }> {
  // Task #521: nutzt `withFreshPage` für protocolTimeout/Recycling auf
  // Puppeteer-ProtocolError ("Network.enable timed out") + harten
  // Render-Timeout statt der bisherigen unbegrenzten Wartezeit.
  const { withFreshPage } = await import("../services/pdf-generator");
  const buffer = await withFreshPage(async (page) => {
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    return Buffer.from(pdfBuffer);
  });
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return { buffer, hash };
}
