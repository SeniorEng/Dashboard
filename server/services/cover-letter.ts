import type { CompanySettings } from "@shared/schema";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { generatePdfFromHtml } from "./pdf-generator";

export const COVER_LETTER_PLACEHOLDERS = {
  "{{kundenname}}": "Vollständiger Kundenname",
  "{{vorname}}": "Vorname des Kunden",
  "{{nachname}}": "Nachname des Kunden",
  "{{firmenname}}": "Name Ihres Unternehmens",
  "{{datum}}": "Heutiges Datum",
  "{{dokumentenliste}}": "Liste der beigefügten Dokumente",
} as const;

const DEFAULT_EMAIL_SUBJECT = "Ihre Vertragsunterlagen — {{firmenname}}";

const DEFAULT_COVER_LETTER_TEXT = `Sehr geehrte/r {{kundenname}},

anbei erhalten Sie Ihre unterschriebenen Vertragsunterlagen:

{{dokumentenliste}}

Bitte bewahren Sie diese Unterlagen sorgfältig auf. Bei Fragen stehen wir Ihnen jederzeit gerne zur Verfügung.

Mit freundlichen Grüßen
{{firmenname}}`;

interface PlaceholderData {
  kundenname: string;
  vorname: string;
  nachname: string;
  firmenname: string;
  documentNames: string[];
}

function buildPlaceholderValues(data: PlaceholderData): Record<string, string> {
  const docListText = data.documentNames.map((n) => `• ${n}`).join("\n");
  const docListHtml = data.documentNames.map((n) => `<li style="padding:2px 0;">${n}</li>`).join("");

  return {
    "{{kundenname}}": data.kundenname,
    "{{vorname}}": data.vorname,
    "{{nachname}}": data.nachname,
    "{{firmenname}}": data.firmenname,
    "{{datum}}": formatDateForDisplay(todayISO()),
    "{{dokumentenliste}}": docListText,
    "{{dokumentenliste_html}}": `<ul style="margin:8px 0;padding-left:20px;">${docListHtml}</ul>`,
  };
}

function replacePlaceholders(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

export function renderEmailSubject(settings: CompanySettings, data: PlaceholderData): string {
  const template = settings.deliveryEmailSubject || DEFAULT_EMAIL_SUBJECT;
  const values = buildPlaceholderValues(data);
  return replacePlaceholders(template, values);
}

export function renderCoverLetterText(settings: CompanySettings, data: PlaceholderData): string {
  const template = settings.deliveryCoverLetterText || DEFAULT_COVER_LETTER_TEXT;
  const values = buildPlaceholderValues(data);
  return replacePlaceholders(template, values);
}

export function renderEmailHtml(settings: CompanySettings, data: PlaceholderData): string {
  const bodyText = renderCoverLetterText(settings, data);
  const values = buildPlaceholderValues(data);

  const docListHtml = values["{{dokumentenliste_html}}"];

  const paragraphs = bodyText.split("\n\n").map((p) => {
    if (p.includes("• ")) {
      return `<div style="background-color:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:16px;margin:12px 0;">${docListHtml}</div>`;
    }
    return `<p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 12px;">${p.replace(/\n/g, "<br/>")}</p>`;
  }).join("");

  const companyName = data.firmenname;
  const logoUrl = settings.logoUrl;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f5f0eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f0eb;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#0d9488;padding:24px 32px;text-align:center;">
              ${logoUrl ? `<img src="${logoUrl}" alt="${companyName}" style="max-height:48px;margin-bottom:8px;" />` : ""}
              <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:600;">${companyName}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${paragraphs}
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="color:#9ca3af;font-size:12px;margin:0;">
                Diese E-Mail wurde automatisch von ${companyName} versendet.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function renderCoverLetterPdf(settings: CompanySettings, data: PlaceholderData): Promise<Buffer> {
  const bodyText = renderCoverLetterText(settings, data);
  const values = buildPlaceholderValues(data);
  const docListHtml = values["{{dokumentenliste_html}}"];
  const companyName = data.firmenname;

  const paragraphs = bodyText.split("\n\n").map((p) => {
    if (p.includes("• ")) {
      return `<div style="margin:12px 0;">${docListHtml}</div>`;
    }
    return `<p style="font-size:12pt;line-height:1.6;margin:0 0 12px;">${p.replace(/\n/g, "<br/>")}</p>`;
  }).join("");

  const senderAddress = [settings.companyName, settings.strasse, settings.hausnummer ? ` ${settings.hausnummer}` : "", settings.plz ? `, ${settings.plz}` : "", settings.stadt ? ` ${settings.stadt}` : ""].filter(Boolean).join("");

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <style>
    @page { size: A4; margin: 25mm 20mm 25mm 25mm; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12pt; color: #333; line-height: 1.5; }
    .sender { font-size: 8pt; color: #666; border-bottom: 1px solid #ccc; padding-bottom: 2px; margin-bottom: 24px; }
    .recipient { margin-bottom: 24px; line-height: 1.4; }
    .date { text-align: right; margin-bottom: 24px; }
    .body { margin-top: 16px; }
  </style>
</head>
<body>
  <div class="sender">${senderAddress}</div>
  <div class="recipient">
    ${data.kundenname}<br/>
  </div>
  <div class="date">${formatDateForDisplay(todayISO())}</div>
  <div class="body">
    ${paragraphs}
  </div>
</body>
</html>`;

  const { pdfBuffer } = await generatePdfFromHtml(html, "Begleitschreiben");
  return pdfBuffer;
}
