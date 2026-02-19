import puppeteer from "puppeteer-core";
import crypto from "crypto";

const CHROMIUM_PATH = "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";

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
  anerkennungsnummer45a: string | null;
  anerkennungsBundesland: string | null;
  geschaeftsfuehrer: string | null;
  
  // Invoice data
  invoiceNumber: string;
  invoiceDate: string;
  invoiceType: string; // rechnung, stornorechnung, nachberechnung
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
  
  // Line items
  lineItems: {
    appointmentDate: string;
    startTime: string | null;
    endTime: string | null;
    serviceDescription: string;
    serviceCode: string | null;
    durationMinutes: number;
    unitPriceCents: number;
    totalCents: number;
    employeeName: string | null;
    employeeLbnr: string | null;
    appointmentNotes: string | null;
  }[];
  
  // Totals
  netAmountCents: number;
  vatAmountCents: number;
  grossAmountCents: number;
  vatRate: number;
  
  // Notes
  notes: string | null;
  
  // Signatures (for Leistungsnachweis)
  signatures?: {
    employeeSignatureData: string | null;
    employeeSignedAt: string | null;
    employeeName: string | null;
    customerSignatureData: string | null;
    customerSignedAt: string | null;
    customerName: string | null;
  }[];
}

function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  return `${sign}${(abs / 100).toFixed(2).replace(".", ",")} €`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isValidDataUrl(str: string): boolean {
  return /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(str);
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
  switch (type) {
    case "stornorechnung": return "STORNORECHNUNG";
    case "nachberechnung": return "NACHBERECHNUNG";
    default: return "RECHNUNG";
  }
}

function getBillingTypeNote(billingType: string, insuranceProviderName: string | null): string {
  switch (billingType) {
    case "pflegekasse_gesetzlich":
      return `Abrechnung gemäß Abtretungserklärung über den Entlastungsbetrag nach § 45b SGB XI.`;
    case "pflegekasse_privat":
      return `Zur Erstattung bei Ihrer privaten Pflegekasse${insuranceProviderName ? ` (${insuranceProviderName})` : ""} einzureichen. Abrechnung des Entlastungsbetrags nach § 45b SGB XI.`;
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
  const billingNote = getBillingTypeNote(data.billingType, data.insuranceProviderName);
  const isStorno = data.invoiceType === "stornorechnung";
  
  const lineItemsHtml = data.lineItems.map(item => `
    <tr>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${formatDate(item.appointmentDate)}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${item.startTime ? item.startTime.slice(0, 5) : ""}-${item.endTime ? item.endTime.slice(0, 5) : ""}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${item.serviceDescription}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatMinutes(item.durationMinutes)}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(item.unitPriceCents)}/Std.</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: ${isStorno ? 'bold; color: #dc2626' : '500'};">${formatCents(item.totalCents)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <style>
    @page { margin: 20mm 15mm; size: A4; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #1f2937; line-height: 1.5; margin: 0; padding: 0; }
    .header { display: flex; justify-content: space-between; margin-bottom: 30px; }
    .company-info { font-size: 9pt; color: #6b7280; }
    .company-name { font-size: 14pt; font-weight: bold; color: #0d9488; margin-bottom: 4px; }
    .recipient { margin-bottom: 20px; min-height: 80px; }
    .recipient-label { font-size: 8pt; color: #9ca3af; margin-bottom: 2px; }
    .invoice-meta { display: flex; justify-content: space-between; margin-bottom: 20px; }
    .invoice-title { font-size: 16pt; font-weight: bold; color: ${isStorno ? '#dc2626' : '#0d9488'}; }
    .meta-table td { padding: 2px 8px; font-size: 9pt; }
    .meta-table td:first-child { color: #6b7280; }
    table.items { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    table.items th { background: #f3f4f6; padding: 8px; text-align: left; font-size: 9pt; font-weight: 600; border-bottom: 2px solid #d1d5db; }
    table.items th:nth-child(4), table.items th:nth-child(5), table.items th:nth-child(6) { text-align: right; }
    .totals { margin-left: auto; width: 250px; }
    .totals td { padding: 4px 8px; }
    .totals td:last-child { text-align: right; }
    .total-row { font-weight: bold; font-size: 12pt; border-top: 2px solid #0d9488; }
    .footer { margin-top: 40px; font-size: 8pt; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 10px; }
    .footer-grid { display: flex; justify-content: space-between; }
    .footer-col { flex: 1; }
    .note { margin-top: 15px; padding: 10px; background: #f0fdfa; border-left: 3px solid #0d9488; font-size: 9pt; }
    .insurance-ref { margin-top: 10px; padding: 8px; background: #eff6ff; border: 1px solid #bfdbfe; font-size: 9pt; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="company-name">${data.companyName || "Firma"}</div>
      <div class="company-info">
        ${data.companyAddress || ""}<br>
        ${data.companyPhone ? `Tel.: ${data.companyPhone}` : ""}${data.companyEmail ? ` | ${data.companyEmail}` : ""}
        ${data.companyWebsite ? `<br>${data.companyWebsite}` : ""}
      </div>
    </div>
    <div style="text-align: right;">
      ${data.ikNummer ? `<div class="company-info">IK-Nr.: ${data.ikNummer}</div>` : ""}
      ${data.anerkennungsnummer45a ? `<div class="company-info">Anerkennung §45a: ${data.anerkennungsnummer45a}</div>` : ""}
      ${data.steuernummer ? `<div class="company-info">St.-Nr.: ${data.steuernummer}</div>` : ""}
      ${data.ustId ? `<div class="company-info">USt-ID: ${data.ustId}</div>` : ""}
    </div>
  </div>

  <div class="recipient">
    <div class="recipient-label">Empfänger:</div>
    <strong>${data.recipientName}</strong>
    ${data.recipientAddress ? `<br>${data.recipientAddress.replace(/\n/g, "<br>")}` : ""}
  </div>

  ${data.billingType !== "selbstzahler" && data.versichertennummer ? `
  <div class="insurance-ref">
    <strong>Versicherte/r:</strong> ${data.customerName}<br>
    <strong>Versichertennummer:</strong> ${data.versichertennummer}
    ${data.pflegegrad ? ` | <strong>Pflegegrad:</strong> ${data.pflegegrad}` : ""}
    ${data.insuranceProviderName && data.billingType === "pflegekasse_privat" ? `<br><strong>Pflegekasse:</strong> ${data.insuranceProviderName}${data.insuranceIkNummer ? ` (IK: ${data.insuranceIkNummer})` : ""}` : ""}
  </div>
  ` : ""}

  <div class="invoice-meta">
    <div class="invoice-title">${typeLabel}</div>
    <table class="meta-table">
      <tr><td>Rechnungsnr.:</td><td><strong>${data.invoiceNumber}</strong></td></tr>
      <tr><td>Rechnungsdatum:</td><td>${invoiceDate}</td></tr>
      <tr><td>Leistungszeitraum:</td><td>${periodLabel}</td></tr>
    </table>
  </div>

  <p>Für die im Zeitraum <strong>${periodLabel}</strong> erbrachten Leistungen${data.billingType !== "selbstzahler" ? " gemäß § 45b Abs. 1 Satz 3 Nr. 4 SGB XI (Angebote zur Unterstützung im Alltag gem. § 45a SGB XI)" : ""} berechnen wir:</p>

  <table class="items">
    <thead>
      <tr>
        <th>Datum</th>
        <th>Uhrzeit</th>
        <th>Leistung</th>
        <th>Dauer</th>
        <th>Satz</th>
        <th>Betrag</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemsHtml}
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Nettobetrag:</td><td>${formatCents(data.netAmountCents)}</td></tr>
    ${data.vatAmountCents !== 0 ? `<tr><td>USt. ${(data.vatRate / 100).toFixed(0)}%:</td><td>${formatCents(data.vatAmountCents)}</td></tr>` : `<tr><td colspan="2" style="font-size: 8pt; color: #6b7280;">Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG</td></tr>`}
    <tr class="total-row"><td>Gesamtbetrag:</td><td style="color: ${isStorno ? '#dc2626' : 'inherit'};">${formatCents(data.grossAmountCents)}</td></tr>
  </table>

  ${billingNote ? `<div class="note">${billingNote}</div>` : ""}

  ${data.billingType === "selbstzahler" ? `
  <div style="margin-top: 20px; font-size: 9pt;">
    <p>Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf folgendes Konto:</p>
    <table style="margin-top: 5px;">
      <tr><td style="color: #6b7280; padding-right: 10px;">IBAN:</td><td><strong>${data.iban}</strong></td></tr>
      <tr><td style="color: #6b7280; padding-right: 10px;">BIC:</td><td>${data.bic}</td></tr>
      <tr><td style="color: #6b7280; padding-right: 10px;">Bank:</td><td>${data.bankName}</td></tr>
    </table>
  </div>
  ` : `
  <div style="margin-top: 20px; font-size: 9pt;">
    <p>Bankverbindung: ${data.bankName} | IBAN: ${data.iban} | BIC: ${data.bic}</p>
  </div>
  `}

  ${data.notes ? `<div style="margin-top: 15px; font-size: 9pt; color: #6b7280;"><strong>Hinweis:</strong> ${data.notes}</div>` : ""}

  <div class="footer">
    <div class="footer-grid">
      <div class="footer-col">
        ${data.companyName || ""}<br>
        ${data.geschaeftsfuehrer ? `Geschäftsführer: ${data.geschaeftsfuehrer}` : ""}
      </div>
      <div class="footer-col" style="text-align: center;">
        ${data.companyPhone ? `Tel.: ${data.companyPhone}` : ""}<br>
        ${data.companyEmail || ""}
      </div>
      <div class="footer-col" style="text-align: right;">
        ${data.iban ? `IBAN: ${data.iban}` : ""}<br>
        ${data.bic ? `BIC: ${data.bic}` : ""}
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function generateLeistungsnachweisHtml(data: InvoicePdfData): string {
  const periodLabel = `${MONTH_NAMES[data.billingMonth - 1]} ${data.billingYear}`;

  const sortedItems = [...data.lineItems].sort((a, b) => {
    const dateCmp = a.appointmentDate.localeCompare(b.appointmentDate);
    if (dateCmp !== 0) return dateCmp;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });

  const employeeNames = [...new Set(sortedItems.map(i => i.employeeName).filter(Boolean))] as string[];
  const employeeLbnrs = [...new Set(sortedItems.map(i => i.employeeLbnr).filter(Boolean))] as string[];
  const employeeLabel = employeeNames.length > 0 ? employeeNames.map(escapeHtml).join(", ") : "Leistungserbringer/in";
  const lbnrLabel = employeeLbnrs.map(escapeHtml).join(", ");

  const KM_CODES = ["travel_km", "customer_km"];
  const isKmItem = (item: typeof sortedItems[0]) => KM_CODES.includes(item.serviceCode || "");

  type AppointmentGroup = { dateTimeKey: string; date: string; time: string; services: typeof sortedItems; kmItems: typeof sortedItems; notes: string | null };
  const appointmentGroups: AppointmentGroup[] = [];
  let currentGroup: AppointmentGroup | null = null;

  for (const item of sortedItems) {
    const dateTimeKey = `${item.appointmentDate}|${item.startTime || ""}|${item.endTime || ""}`;
    if (!currentGroup || currentGroup.dateTimeKey !== dateTimeKey) {
      currentGroup = {
        dateTimeKey,
        date: formatDate(item.appointmentDate),
        time: `${item.startTime ? item.startTime.slice(0, 5) : ""} - ${item.endTime ? item.endTime.slice(0, 5) : ""}`,
        services: [],
        kmItems: [],
        notes: item.appointmentNotes || null,
      };
      appointmentGroups.push(currentGroup);
    }
    if (!currentGroup.notes && item.appointmentNotes) {
      currentGroup.notes = item.appointmentNotes;
    }
    if (isKmItem(item)) {
      currentGroup.kmItems.push(item);
    } else {
      currentGroup.services.push(item);
    }
  }

  const lineItemsHtml = appointmentGroups.map((group) => {
    const rows: string[] = [];

    for (let i = 0; i < group.services.length; i++) {
      const svc = group.services[i];
      const showDateCol = i === 0;
      rows.push(`
      <tr>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${showDateCol ? group.date : ""}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${showDateCol ? group.time : ""}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(svc.serviceDescription)}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatMinutes(svc.durationMinutes)}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(svc.unitPriceCents)}/Std.</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(svc.totalCents)}</td>
      </tr>`);
    }

    if (group.kmItems.length > 0) {
      const totalKm = group.kmItems.reduce((sum, k) => sum + k.durationMinutes, 0);
      const totalKmCents = group.kmItems.reduce((sum, k) => sum + k.totalCents, 0);
      const kmPrice = group.kmItems[0].unitPriceCents;
      const showDateCol = group.services.length === 0;
      rows.push(`
      <tr>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${showDateCol ? group.date : ""}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${showDateCol ? group.time : ""}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">Kilometer</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${totalKm} km</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(kmPrice)}/km</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(totalKmCents)}</td>
      </tr>`);
    }

    if (group.notes) {
      rows.push(`
      <tr>
        <td colspan="6" style="padding: 4px 8px 8px 8px; border-bottom: 2px solid #e5e7eb; font-size: 9pt; color: #6b7280; font-style: italic;">
          ${escapeHtml(group.notes)}
        </td>
      </tr>`);
    }

    return rows.join("");
  }).join("");

  const totalServiceMinutes = sortedItems.filter(i => !isKmItem(i)).reduce((sum, item) => sum + item.durationMinutes, 0);
  const totalKmAll = sortedItems.filter(i => isKmItem(i)).reduce((sum, item) => sum + item.durationMinutes, 0);
  const totalCentsAll = sortedItems.reduce((sum, item) => sum + item.totalCents, 0);

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <style>
    @page { margin: 20mm 15mm; size: A4; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #1f2937; line-height: 1.5; margin: 0; padding: 0; }
    .header { margin-bottom: 20px; }
    .title { font-size: 16pt; font-weight: bold; color: #0d9488; margin-bottom: 10px; }
    .info-grid { display: flex; justify-content: space-between; margin-bottom: 20px; }
    .info-box { padding: 10px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; flex: 1; margin-right: 10px; }
    .info-box:last-child { margin-right: 0; }
    .info-label { font-size: 8pt; color: #6b7280; margin-bottom: 2px; }
    .info-value { font-weight: 600; }
    table.items { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    table.items th { background: #f3f4f6; padding: 8px; text-align: left; font-size: 9pt; font-weight: 600; border-bottom: 2px solid #d1d5db; }
    table.items th:nth-child(4), table.items th:nth-child(5), table.items th:nth-child(6) { text-align: right; }
    .total-row td { font-weight: bold; border-top: 2px solid #0d9488; padding: 8px; }
    .signature-area { margin-top: 40px; display: flex; justify-content: space-between; }
    .signature-box { width: 45%; }
    .signature-line { border-top: 1px solid #1f2937; margin-top: 40px; padding-top: 5px; font-size: 9pt; color: #6b7280; }
    .footer { margin-top: 30px; font-size: 8pt; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 10px; }
    .confirm-text { margin-top: 20px; font-size: 9pt; font-style: italic; color: #4b5563; padding: 10px; background: #f0fdfa; border-left: 3px solid #0d9488; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">LEISTUNGSNACHWEIS</div>
    <div style="font-size: 9pt; color: #6b7280;">
      ${data.companyName || ""} | ${data.ikNummer ? `IK-Nr.: ${data.ikNummer}` : ""}
      ${data.anerkennungsnummer45a ? ` | Anerkennung §45a: ${data.anerkennungsnummer45a}` : ""}
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <div class="info-label">Leistungsempfänger/in</div>
      <div class="info-value">${escapeHtml(data.customerName)}</div>
      ${data.customerAddress ? `<div style="font-size: 9pt;">${escapeHtml(data.customerAddress).replace(/\n/g, "<br>")}</div>` : ""}
    </div>
    <div class="info-box">
      <div class="info-label">Leistungserbringer/in</div>
      <div class="info-value">${employeeLabel}</div>
      ${lbnrLabel ? `<div style="font-size: 9pt;">LBNR: ${lbnrLabel}</div>` : ""}
    </div>
  </div>
  <div class="info-grid">
    <div class="info-box">
      <div class="info-label">Versicherung</div>
      ${data.versichertennummer ? `<div class="info-value">${escapeHtml(data.versichertennummer)}</div>` : ""}
      ${data.pflegegrad ? `<div style="font-size: 9pt;">Pflegegrad: ${data.pflegegrad}</div>` : ""}
      ${data.insuranceProviderName ? `<div style="font-size: 9pt;">${escapeHtml(data.insuranceProviderName)}</div>` : `<div style="font-size: 9pt; color: #9ca3af;">Selbstzahler</div>`}
    </div>
    <div class="info-box">
      <div class="info-label">Zeitraum</div>
      <div class="info-value">${escapeHtml(periodLabel)}</div>
      <div style="font-size: 9pt;">Rechnungsnr.: ${escapeHtml(data.invoiceNumber)}</div>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th>Datum</th>
        <th>Uhrzeit</th>
        <th>Leistung</th>
        <th>Dauer/Km</th>
        <th>Einzelpreis</th>
        <th>Betrag</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemsHtml}
      <tr class="total-row">
        <td colspan="3">Gesamt</td>
        <td style="text-align: right;">${formatMinutes(totalServiceMinutes)}${totalKmAll > 0 ? ` + ${totalKmAll} km` : ""}</td>
        <td></td>
        <td style="text-align: right;">${formatCents(totalCentsAll)}</td>
      </tr>
    </tbody>
  </table>

  <div style="margin-top: 10px;">
    <table style="width: 250px; margin-left: auto;">
      <tr><td style="padding: 3px 8px;">Gesamtbetrag:</td><td style="text-align: right; font-weight: bold;">${formatCents(data.grossAmountCents)}</td></tr>
    </table>
  </div>

  <div class="confirm-text">
    Ich bestätige hiermit, dass die aufgeführten Leistungen wie oben beschrieben erbracht wurden
    ${data.billingType !== "selbstzahler" ? "und zur Abrechnung des Entlastungsbetrags nach § 45b SGB XI bei meiner Pflegekasse eingereicht werden dürfen" : ""}.
  </div>

  ${data.signatures && data.signatures.length > 0 ? data.signatures.map(sig => {
    const custSigValid = sig.customerSignatureData && isValidDataUrl(sig.customerSignatureData);
    const empSigValid = sig.employeeSignatureData && isValidDataUrl(sig.employeeSignatureData);
    return `
  <div class="signature-area">
    <div class="signature-box">
      ${custSigValid ? `
        <div style="margin-bottom: 4px;">
          <img src="${sig.customerSignatureData}" style="max-width: 200px; max-height: 60px;" />
        </div>
        <div class="signature-line">
          ${escapeHtml(sig.customerSignedAt || "")}, ${escapeHtml(sig.customerName || data.customerName)}<br>
          <span style="color: #9ca3af;">(Leistungsempfänger/in)</span>
        </div>
      ` : `
        <div class="signature-line">${escapeHtml(data.customerName)}<br><span style="color: #9ca3af;">(Leistungsempfänger/in oder gesetzl. Vertreter/in)</span></div>
      `}
    </div>
    <div class="signature-box">
      ${empSigValid ? `
        <div style="margin-bottom: 4px;">
          <img src="${sig.employeeSignatureData}" style="max-width: 200px; max-height: 60px;" />
        </div>
        <div class="signature-line">
          ${escapeHtml(sig.employeeSignedAt || "")}, ${escapeHtml(sig.employeeName || "")}<br>
          <span style="color: #9ca3af;">(Leistungserbringer/in)</span>
        </div>
      ` : `
        <div class="signature-line">${employeeLabel}<br><span style="color: #9ca3af;">(Leistungserbringer/in)</span></div>
      `}
    </div>
  </div>
  `; }).join("") : `
  <div class="signature-area">
    <div class="signature-box">
      <div class="signature-line">${escapeHtml(data.customerName)}<br><span style="color: #9ca3af;">(Leistungsempfänger/in oder gesetzl. Vertreter/in)</span></div>
    </div>
    <div class="signature-box">
      <div class="signature-line">${employeeLabel}<br><span style="color: #9ca3af;">(Leistungserbringer/in)</span></div>
    </div>
  </div>
  `}

  <div class="footer">
    ${data.companyName || ""} | ${data.companyAddress || ""} | ${data.companyPhone ? `Tel.: ${data.companyPhone}` : ""} | ${data.companyEmail || ""}
  </div>
</body>
</html>`;
}

export async function generatePdf(html: string): Promise<{ buffer: Buffer; hash: string }> {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    const buffer = Buffer.from(pdfBuffer);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    return { buffer, hash };
  } finally {
    await browser.close();
  }
}
