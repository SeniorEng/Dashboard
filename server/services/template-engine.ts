import { documentStorage } from "../storage/documents";
import { storage } from "../storage";
import { formatDateISO } from "@shared/utils/datetime";

export interface TemplatePlaceholders {
  [key: string]: string;
}

const PLACEHOLDER_CATALOG: Record<string, { label: string; source: string }> = {
  customer_name: { label: "Kundenname", source: "customer" },
  customer_address: { label: "Kundenadresse", source: "customer" },
  customer_birthdate: { label: "Geburtsdatum", source: "customer" },
  customer_phone: { label: "Telefonnummer", source: "customer" },
  customer_email: { label: "E-Mail", source: "customer" },
  pflegegrad: { label: "Pflegegrad", source: "customer" },
  versichertennummer: { label: "Versichertennummer", source: "insurance" },
  insurance_name: { label: "Pflegekasse Name", source: "insurance" },
  ik_nummer: { label: "IK-Nummer", source: "insurance" },
  vertragsbeginn: { label: "Vertragsbeginn", source: "system" },
  mandatsreferenz: { label: "Mandatsreferenz", source: "system" },
  customer_signature: { label: "Kundenunterschrift", source: "signature" },
  employee_signature: { label: "Mitarbeiterunterschrift", source: "signature" },
  current_date: { label: "Aktuelles Datum", source: "system" },
  company_name: { label: "Firmenname", source: "system" },
};

export function getPlaceholderCatalog() {
  return Object.entries(PLACEHOLDER_CATALOG).map(([key, value]) => ({
    key: `{{${key}}}`,
    ...value,
  }));
}

export async function buildPlaceholders(
  customerId: number,
  overrides: TemplatePlaceholders = {}
): Promise<TemplatePlaceholders> {
  const customer = await storage.getCustomer(customerId);
  if (!customer) throw new Error("Kunde nicht gefunden");

  const today = new Date();
  const placeholders: TemplatePlaceholders = {
    customer_name: customer.name || "",
    customer_address: [customer.strasse, `${customer.plz || ""} ${customer.stadt || ""}`].filter(Boolean).join(", "),
    customer_birthdate: customer.geburtsdatum || "",
    customer_phone: customer.telefon || "",
    customer_email: customer.email || "",
    pflegegrad: customer.pflegegrad ? `Pflegegrad ${customer.pflegegrad}` : "Nicht angegeben",
    versichertennummer: "",
    insurance_name: "",
    ik_nummer: "",
    vertragsbeginn: formatDateISO(today),
    mandatsreferenz: `SE-${customerId}-${today.getFullYear()}`,
    current_date: formatDateISO(today),
    company_name: "SeniorenEngel GmbH",
    customer_signature: "",
    employee_signature: "",
    ...overrides,
  };

  return placeholders;
}

export function renderTemplate(htmlContent: string, placeholders: TemplatePlaceholders): string {
  let rendered = htmlContent;
  for (const [key, value] of Object.entries(placeholders)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    rendered = rendered.replace(pattern, value);
  }
  rendered = rendered.replace(/\{\{[a-z_]+\}\}/g, "");
  return rendered;
}

export async function renderTemplateForCustomer(
  templateSlug: string,
  customerId: number,
  overrides: TemplatePlaceholders = {}
): Promise<{ html: string; templateId: number; templateVersion: number }> {
  const template = await documentStorage.getDocumentTemplateBySlug(templateSlug);
  if (!template) throw new Error(`Vorlage "${templateSlug}" nicht gefunden`);

  const placeholders = await buildPlaceholders(customerId, overrides);
  const html = renderTemplate(template.htmlContent, placeholders);

  return {
    html,
    templateId: template.id,
    templateVersion: template.version,
  };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function wrapInPrintableHtml(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 2cm; size: A4; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; font-size: 12pt; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 18pt; margin-bottom: 0.5em; }
  h2 { font-size: 14pt; margin-top: 1.5em; margin-bottom: 0.5em; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1em 0; }
  .signatures { display: flex; gap: 2cm; margin-top: 3em; page-break-inside: avoid; }
  .signature-block { flex: 1; }
  .signature-area { border-bottom: 1px solid #333; min-height: 60px; margin-top: 0.5em; display: flex; align-items: flex-end; }
  .signature-area img { max-height: 60px; }
  @media print { body { -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}
