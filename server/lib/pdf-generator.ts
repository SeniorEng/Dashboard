import crypto from "crypto";
import { getBrowser } from "../services/pdf-generator";
import { formatPhoneForDisplay } from "@shared/utils/phone";

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
  customerGeburtsdatum: string | null;
  
  // Line items
  lineItems: {
    appointmentId: number | null;
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
    serviceDetails: string | null;
  }[];
  
  // Totals
  netAmountCents: number;
  vatAmountCents: number;
  grossAmountCents: number;
  vatRate: number;
  
  // Notes
  notes: string | null;

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
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  return `${sign}${(abs / 100).toFixed(2).replace(".", ",")} €`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isValidDataUrl(str: string): boolean {
  return /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/.test(str.trim());
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

function getConfirmTextForBillingType(billingType: string): string {
  switch (billingType) {
    case "pflegekasse_gesetzlich":
      return "und zur Abrechnung des Entlastungsbetrags nach § 45b SGB XI bei der zuständigen Pflegekasse eingereicht werden dürfen";
    case "pflegekasse_privat":
      return "und zur Erstattung des Entlastungsbetrags nach § 45b SGB XI bei der zuständigen privaten Pflegekasse eingereicht werden dürfen";
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
  
  const lineItemsHtml = data.lineItems.map(item => {
    const isKm = item.serviceCode === "travel_km" || item.serviceCode === "customer_km";
    const quantityDisplay = isKm ? `${item.durationMinutes} km` : formatMinutes(item.durationMinutes);
    const unitLabel = isKm ? "/km" : "/Std.";
    return `
    <tr>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${formatDate(item.appointmentDate)}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${item.startTime ? item.startTime.slice(0, 5) : ""}-${item.endTime ? item.endTime.slice(0, 5) : ""}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(item.serviceDescription)}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${quantityDisplay}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(item.unitPriceCents)}${unitLabel}</td>
      <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: ${isStorno ? 'bold; color: #dc2626' : '500'};">${formatCents(item.totalCents)}</td>
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
    .footer { margin-top: 40px; font-size: 9pt; color: #1f2937; border-top: 1px solid #e5e7eb; padding-top: 10px; }
    .footer-grid { display: flex; justify-content: space-between; }
    .footer-col { flex: 1; }
    .note { margin-top: 15px; padding: 10px; background: #f0fdfa; border-left: 3px solid #0d9488; font-size: 9pt; }
    .insurance-ref { margin-top: 10px; padding: 8px; background: #eff6ff; border: 1px solid #bfdbfe; font-size: 9pt; }
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
      ${data.ikNummer ? `<div class="company-info">IK-Nr.: ${data.ikNummer}</div>` : ""}
      ${data.anerkennungsnummer45a ? `<div class="company-info">Anerkennung §45a: ${data.anerkennungsnummer45a}</div>` : ""}
      ${data.steuernummer ? `<div class="company-info">St.-Nr.: ${data.steuernummer}</div>` : ""}
      ${data.ustId ? `<div class="company-info">USt-ID: ${data.ustId}</div>` : ""}
    </div>
  </div>

  ${data.billingType !== "selbstzahler" ? `
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
      ${data.insuranceProviderName && data.billingType === "pflegekasse_privat" ? `<br>Pflegekasse: ${escapeHtml(data.insuranceProviderName)}${data.insuranceIkNummer ? ` (IK: ${escapeHtml(data.insuranceIkNummer)})` : ""}` : ""}
    </div>
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
    ${data.vatAmountCents !== 0 ? `<tr><td>USt. ${(data.vatRate / 100).toFixed(0)}%:</td><td>${formatCents(data.vatAmountCents)}</td></tr>` : `<tr><td colspan="2" style="font-size: 9pt; color: #1f2937;">Umsatzsteuerbefreit gem. § 4 Nr. 16 UStG</td></tr>`}
    <tr class="total-row"><td>Gesamtbetrag:</td><td style="color: ${isStorno ? '#dc2626' : 'inherit'};">${formatCents(data.grossAmountCents)}</td></tr>
  </table>

  ${billingNote ? `<div class="note">${billingNote}</div>` : ""}

  ${data.billingType === "selbstzahler" ? `
  <div style="margin-top: 20px; font-size: 9pt;">
    <p>Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf folgendes Konto:</p>
    <table style="margin-top: 5px;">
      <tr><td style="color: #1f2937; padding-right: 10px;">IBAN:</td><td style="color: #111827;"><strong>${escapeHtml(data.iban)}</strong></td></tr>
      <tr><td style="color: #1f2937; padding-right: 10px;">BIC:</td><td style="color: #111827;">${escapeHtml(data.bic)}</td></tr>
      <tr><td style="color: #1f2937; padding-right: 10px;">Bank:</td><td style="color: #111827;">${escapeHtml(data.bankName)}</td></tr>
    </table>
  </div>
  ` : `
  <div style="margin-top: 20px; font-size: 9pt;">
    <p>Bankverbindung: ${escapeHtml(data.bankName)} | IBAN: ${escapeHtml(data.iban)} | BIC: ${escapeHtml(data.bic)}</p>
  </div>
  `}

  ${data.notes ? `<div style="margin-top: 15px; font-size: 9pt; color: #1f2937;"><strong>Hinweis:</strong> ${escapeHtml(data.notes)}</div>` : ""}

  <div class="footer">
    <div class="footer-grid">
      <div class="footer-col">
        ${escapeHtml(data.companyName || "")}<br>
        ${data.geschaeftsfuehrer ? `Geschäftsführer: ${escapeHtml(data.geschaeftsfuehrer)}` : ""}
      </div>
      <div class="footer-col" style="text-align: center;">
        ${data.companyPhone ? `Tel.: ${formatPhoneForDisplay(data.companyPhone)}` : ""}<br>
        ${escapeHtml(data.companyEmail || "")}
      </div>
      <div class="footer-col" style="text-align: right;">
        ${data.iban ? `IBAN: ${escapeHtml(data.iban)}` : ""}<br>
        ${data.bic ? `BIC: ${escapeHtml(data.bic)}` : ""}
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function generateLeistungsnachweisHtml(data: InvoicePdfData): string {
  const periodLabel = `${MONTH_NAMES[data.billingMonth - 1]} ${data.billingYear}`;

  const KM_CODES = ["travel_km", "customer_km"];
  const isKmItem = (item: typeof data.lineItems[0]) => KM_CODES.includes(item.serviceCode || "");

  type LineItem = typeof data.lineItems[0];
  type AppointmentGroup = { dateTimeKey: string; date: string; time: string; services: LineItem[]; kmItems: LineItem[]; notes: string | null };

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
          notes: item.appointmentNotes || null,
        };
        groups.push(currentGroup);
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
    return groups;
  }

  function renderTableRows(groups: AppointmentGroup[]): string {
    return groups.map((group) => {
      const rows: string[] = [];
      for (let i = 0; i < group.services.length; i++) {
        const svc = group.services[i];
        const showDateCol = i === 0;
        rows.push(`
        <tr>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${showDateCol ? group.date : ""}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${showDateCol ? group.time : ""}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(svc.serviceDescription)}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; font-size: 9pt;">${svc.serviceDetails ? escapeHtml(svc.serviceDetails) : ""}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatMinutes(svc.durationMinutes)}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(svc.unitPriceCents)}/Std.</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(svc.totalCents)}</td>
        </tr>`);
      }
      for (const km of group.kmItems) {
        const kmLabel = km.serviceCode === "customer_km" ? "Fahrten für/mit Kunde" : "Anfahrt";
        rows.push(`
        <tr>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;"></td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;"></td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(kmLabel)}</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb;"></td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${km.durationMinutes} km</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(km.unitPriceCents)}/km</td>
          <td style="padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCents(km.totalCents)}</td>
        </tr>`);
      }
      if (group.notes) {
        rows.push(`
        <tr>
          <td colspan="7" style="padding: 4px 8px 8px 8px; border-bottom: 2px solid #e5e7eb; font-size: 9pt; color: #1f2937; font-style: italic;">
            ${escapeHtml(group.notes)}
          </td>
        </tr>`);
      }
      return rows.join("");
    }).join("");
  }

  function renderAbtretungserklaerung(): string {
    if (data.billingType === "selbstzahler") return "";
    return `
    <div style="margin-top: 20px; padding: 10px; background: #fefce8; border: 1px solid #fde68a; border-radius: 4px; font-size: 9pt; color: #92400e;">
      <div style="font-weight: 600; margin-bottom: 4px;">Abtretungserklärung (§ 398 BGB)</div>
      Der/Die Leistungsempfänger/in tritt hiermit seinen/ihren Anspruch auf Kostenerstattung gegenüber der Pflegekasse in Höhe des abgerechneten Betrages an ${escapeHtml(data.companyName || "")} ab.${data.ikNummer ? ` IK-Nr.: ${escapeHtml(data.ikNummer)}.` : ""} Die Unterschrift unter dem Leistungsnachweis gilt gleichzeitig als Abtretungserklärung.
    </div>`;
  }

  function cleanDataUrl(dataUrl: string): string {
    return dataUrl.replace(/\s/g, "");
  }

  function renderSignature(sig: NonNullable<InvoicePdfData["signatures"]>[0], fallbackEmployeeLabel: string): string {
    const custSigValid = sig.customerSignatureData && isValidDataUrl(sig.customerSignatureData);
    const empSigValid = sig.employeeSignatureData && isValidDataUrl(sig.employeeSignatureData);
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
  const employeeLbnrs = Array.from(new Set(allSorted.map(i => i.employeeLbnr).filter(Boolean))) as string[];
  const employeeLabel = employeeNames.length > 0 ? employeeNames.map(escapeHtml).join(", ") : "Leistungserbringer/in";
  const lbnrLabel = employeeLbnrs.map(escapeHtml).join(", ");

  const hasMultipleLNs = data.signatures && data.signatures.length > 1 && data.signatures.some(s => s.appointmentIds.length > 0);

  let sectionsHtml: string;

  if (hasMultipleLNs && data.signatures) {
    const sections: string[] = [];
    const confirmSuffix = getConfirmTextForBillingType(data.billingType);
    const confirmText = `Ich bestätige hiermit, dass die aufgeführten Leistungen wie oben beschrieben erbracht wurden${confirmSuffix ? " " + confirmSuffix : ""}.`;

    for (let idx = 0; idx < data.signatures.length; idx++) {
      const sig = data.signatures[idx];
      const apptIdSet = new Set(sig.appointmentIds);
      const sectionItems = sortItems(allSorted.filter(item => item.appointmentId !== null && apptIdSet.has(item.appointmentId)));

      if (sectionItems.length === 0) continue;

      const groups = groupByAppointment(sectionItems);
      const tableRowsHtml = renderTableRows(groups);
      const sectionCents = sectionItems.reduce((sum, item) => sum + item.totalCents, 0);

      const sectionLabel = sig.recordType === "single" ? "Einzeltermin-Leistungsnachweis" : "Monatlicher Leistungsnachweis";
      const sectionEmployeeName = sig.employeeName ? escapeHtml(sig.employeeName) : employeeLabel;
      const sectionEmployeeLbnr = sectionItems[0]?.employeeLbnr ? escapeHtml(sectionItems[0].employeeLbnr) : "";
      const sectionEmployeeQual = sig.employeeName && data.employeeQualifications ? data.employeeQualifications.get(sig.employeeName) || "" : "";

      sections.push(`
      ${sections.length > 0 ? '<div style="page-break-before: always;"></div>' : ''}

      <div class="header">
        <div class="title">LEISTUNGSNACHWEIS</div>
        <div style="font-size: 9pt; color: #1f2937;">
          ${data.companyName || ""} | ${data.ikNummer ? `IK-Nr.: ${data.ikNummer}` : ""}
          ${data.anerkennungsnummer45a ? ` | Anerkennung §45a: ${data.anerkennungsnummer45a}` : ""}
        </div>
        <div style="font-size: 10pt; font-weight: bold; color: #0d9488; margin-top: 6px;">
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
          ${sectionEmployeeLbnr ? `<div style="font-size: 9pt;">LBNR: ${sectionEmployeeLbnr}</div>` : ""}
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

      <table class="items">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Uhrzeit</th>
            <th>Leistung</th>
            <th>Beschreibung</th>
            <th>Dauer/Km</th>
            <th>Einzelpreis</th>
            <th>Betrag</th>
          </tr>
        </thead>
        <tbody>
          ${tableRowsHtml}
          <tr class="total-row">
            <td colspan="6">Summe</td>
            <td style="text-align: right; white-space: nowrap;">${formatCents(sectionCents)}</td>
          </tr>
        </tbody>
      </table>

      <div class="confirm-text">${confirmText}</div>

      ${renderAbtretungserklaerung()}

      ${renderSignature(sig, sectionEmployeeName)}
      `);
    }

    sectionsHtml = sections.join("");
  } else {
    const groups = groupByAppointment(allSorted);
    const tableRowsHtml = renderTableRows(groups);
    const totalCentsAll = allSorted.reduce((sum, item) => sum + item.totalCents, 0);

    const sig = data.signatures && data.signatures.length > 0 ? data.signatures[0] : null;
    const confirmSuffix = getConfirmTextForBillingType(data.billingType);

    sectionsHtml = `
    <table class="items">
      <thead>
        <tr>
          <th>Datum</th>
          <th>Uhrzeit</th>
          <th>Leistung</th>
          <th>Beschreibung</th>
          <th>Dauer/Km</th>
          <th>Einzelpreis</th>
          <th>Betrag</th>
        </tr>
      </thead>
      <tbody>
        ${tableRowsHtml}
        <tr class="total-row">
          <td colspan="6">Gesamt</td>
          <td style="text-align: right; white-space: nowrap;">${formatCents(totalCentsAll)}</td>
        </tr>
      </tbody>
    </table>

    <div style="margin-top: 10px;">
      <table style="width: 300px; margin-left: auto;">
        <tr><td style="padding: 3px 8px;">Gesamtbetrag:</td><td style="text-align: right; font-weight: bold; white-space: nowrap;">${formatCents(data.grossAmountCents)}</td></tr>
      </table>
    </div>

    <div class="confirm-text">
      Ich bestätige hiermit, dass die aufgeführten Leistungen wie oben beschrieben erbracht wurden${confirmSuffix ? " " + confirmSuffix : ""}.
    </div>

    ${renderAbtretungserklaerung()}

    ${data.signatures && data.signatures.length > 0 ? data.signatures.map(s => renderSignature(s, employeeLabel)).join("") : `
    <div class="signature-area">
      <div class="signature-box">
        <div class="signature-line">${escapeHtml(data.customerName)}<br><span style="color: #4b5563;">(Leistungsempfänger/in oder gesetzl. Vertreter/in)</span></div>
      </div>
      <div class="signature-box">
        <div class="signature-line">${employeeLabel}<br><span style="color: #4b5563;">(Leistungserbringer/in)</span></div>
      </div>
    </div>
    `}`;
  }

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
    .info-label { font-size: 9pt; color: #1f2937; margin-bottom: 2px; }
    .info-value { font-weight: 600; }
    table.items { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    table.items th { background: #f3f4f6; padding: 8px; text-align: left; font-size: 9pt; font-weight: 600; border-bottom: 2px solid #d1d5db; }
    table.items th:nth-child(5), table.items th:nth-child(6), table.items th:nth-child(7) { text-align: right; }
    .total-row td { font-weight: bold; border-top: 2px solid #0d9488; padding: 8px; }
    .signature-area { margin-top: 40px; display: flex; justify-content: space-between; align-items: flex-end; }
    .signature-box { width: 45%; position: relative; }
    .signature-img-wrapper { position: relative; margin-bottom: -18px; z-index: 1; }
    .signature-img { max-width: 260px; max-height: 150px; filter: brightness(0) saturate(100%) invert(18%) sepia(60%) saturate(600%) hue-rotate(190deg); }
    .signature-line { border-top: 1px solid #1f2937; margin-top: 40px; padding-top: 5px; font-size: 9pt; color: #1f2937; }
    .signature-line-signed { margin-top: 0; }
    .footer { margin-top: 30px; font-size: 9pt; color: #1f2937; border-top: 1px solid #e5e7eb; padding-top: 10px; }
    .confirm-text { margin-top: 20px; font-size: 9pt; font-style: italic; color: #4b5563; padding: 10px; background: #f0fdfa; border-left: 3px solid #0d9488; }
  </style>
</head>
<body>
  ${hasMultipleLNs ? sectionsHtml : `
  <div class="header">
    <div class="title">LEISTUNGSNACHWEIS</div>
    <div style="font-size: 9pt; color: #1f2937;">
      ${data.companyName || ""} | ${data.ikNummer ? `IK-Nr.: ${data.ikNummer}` : ""}
      ${data.anerkennungsnummer45a ? ` | Anerkennung §45a: ${data.anerkennungsnummer45a}` : ""}
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
      ${lbnrLabel ? `<div style="font-size: 9pt;">LBNR: ${lbnrLabel}</div>` : ""}
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
  `}

  ${hasMultipleLNs ? `
  <div style="margin-top: 30px; border-top: 2px solid #0d9488; padding-top: 10px;">
    <table style="width: 300px; margin-left: auto;">
      <tr><td style="padding: 3px 8px; font-weight: bold;">Gesamtbetrag:</td><td style="text-align: right; font-weight: bold; white-space: nowrap;">${formatCents(data.grossAmountCents)}</td></tr>
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
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
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
    await page.close();
  }
}
