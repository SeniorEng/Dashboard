import { documentStorage } from "../storage/documents";
import { storage } from "../storage";
import { formatDateISO, formatDateForDisplay } from "@shared/utils/datetime";
import { BILLING_TYPE_LABELS, type BillingType } from "@shared/domain/customers";

export interface TemplatePlaceholders {
  [key: string]: string;
}

const PLACEHOLDER_CATALOG: Record<string, { label: string; source: string }> = {
  customer_name: { label: "Kundenname (Vor- und Nachname)", source: "customer" },
  customer_vorname: { label: "Vorname", source: "customer" },
  customer_nachname: { label: "Nachname", source: "customer" },
  customer_address: { label: "Vollständige Adresse", source: "customer" },
  customer_strasse: { label: "Straße", source: "customer" },
  customer_hausnummer: { label: "Hausnummer", source: "customer" },
  customer_plz: { label: "Postleitzahl", source: "customer" },
  customer_stadt: { label: "Stadt", source: "customer" },
  customer_birthdate: { label: "Geburtsdatum", source: "customer" },
  customer_phone: { label: "Mobilnummer", source: "customer" },
  customer_festnetz: { label: "Festnetznummer", source: "customer" },
  customer_email: { label: "E-Mail", source: "customer" },
  pflegegrad: { label: "Pflegegrad (z.B. 'Pflegegrad 3')", source: "customer" },
  pflegegrad_nummer: { label: "Pflegegrad (nur Zahl)", source: "customer" },
  pflegegrad_seit: { label: "Pflegegrad seit (Datum)", source: "customer" },
  abrechnungsart: { label: "Abrechnungsart (z.B. 'Selbstzahler')", source: "customer" },
  versichertennummer: { label: "Versichertennummer", source: "insurance" },
  insurance_name: { label: "Pflegekasse Name", source: "insurance" },
  ik_nummer: { label: "IK-Nummer", source: "insurance" },
  vorerkrankungen: { label: "Vorerkrankungen", source: "customer" },
  haustier: { label: "Haustier vorhanden (Ja/Nein)", source: "customer" },
  haustier_details: { label: "Haustier Details", source: "customer" },
  personenbefoerderung: { label: "Personenbeförderung gewünscht (Ja/Nein)", source: "customer" },
  vertragsdatum: { label: "Vertragsdatum (Abschlussdatum)", source: "contract" },
  vertragsbeginn: { label: "Vertragsbeginn", source: "contract" },
  vereinbarte_leistungen: { label: "Vereinbarte Leistungen", source: "contract" },
  vertragsstunden: { label: "Vereinbarte Stunden", source: "contract" },
  vertragsperiode: { label: "Vertragsperiode (pro Woche/Monat)", source: "contract" },
  kontaktperson_name: { label: "Kontaktperson Name", source: "contact" },
  kontaktperson_telefon: { label: "Kontaktperson Telefon", source: "contact" },
  kontaktperson_email: { label: "Kontaktperson E-Mail", source: "contact" },
  kontaktperson_typ: { label: "Kontaktperson Typ", source: "contact" },
  mandatsreferenz: { label: "SEPA-Mandatsreferenz", source: "system" },
  current_date: { label: "Aktuelles Datum", source: "system" },
  heute: { label: "Heutiges Datum", source: "system" },
  company_name: { label: "Firmenname", source: "system" },
  customer_signature: { label: "Kundenunterschrift", source: "signature" },
  employee_signature: { label: "Mitarbeiterunterschrift", source: "signature" },
};

export function getPlaceholderCatalog() {
  return Object.entries(PLACEHOLDER_CATALOG).map(([key, value]) => ({
    key: `{{${key}}}`,
    ...value,
  }));
}

export interface InputField {
  key: string;
  label: string;
}

export function extractInputPlaceholders(htmlContent: string): InputField[] {
  const regex = /\{\{input:([^}]+)\}\}/g;
  const fields: InputField[] = [];
  const seen = new Set<string>();
  let match;
  while ((match = regex.exec(htmlContent)) !== null) {
    const label = match[1].trim();
    const key = `input_${label.toLowerCase().replace(/[^a-zäöüß0-9]+/gi, "_").replace(/^_|_$/g, "")}`;
    if (!seen.has(key)) {
      seen.add(key);
      fields.push({ key, label });
    }
  }
  return fields;
}

function formatDE(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  try {
    return formatDateForDisplay(dateStr);
  } catch {
    return dateStr;
  }
}

export async function buildPlaceholders(
  customerId: number,
  overrides: TemplatePlaceholders = {}
): Promise<TemplatePlaceholders> {
  const customer = await storage.getCustomer(customerId);
  if (!customer) throw new Error("Kunde nicht gefunden");

  const today = new Date();
  const todayDE = formatDateForDisplay(formatDateISO(today));

  const placeholders: TemplatePlaceholders = {
    customer_name: customer.name || "",
    customer_vorname: customer.vorname || "",
    customer_nachname: customer.nachname || "",
    customer_address: [customer.strasse, `${customer.plz || ""} ${customer.stadt || ""}`].filter(Boolean).join(", "),
    customer_strasse: customer.strasse || "",
    customer_hausnummer: customer.nr || "",
    customer_plz: customer.plz || "",
    customer_stadt: customer.stadt || "",
    customer_birthdate: formatDE(customer.geburtsdatum),
    customer_phone: customer.telefon || "",
    customer_festnetz: customer.festnetz || "",
    customer_email: customer.email || "",
    pflegegrad: customer.pflegegrad ? `Pflegegrad ${customer.pflegegrad}` : "",
    pflegegrad_nummer: customer.pflegegrad ? String(customer.pflegegrad) : "",
    pflegegrad_seit: "",
    abrechnungsart: BILLING_TYPE_LABELS[customer.billingType as BillingType] || customer.billingType || "",
    versichertennummer: "",
    insurance_name: "",
    ik_nummer: "",
    vorerkrankungen: customer.vorerkrankungen || "",
    haustier: customer.haustierVorhanden ? "Ja" : "Nein",
    haustier_details: customer.haustierDetails || "",
    personenbefoerderung: customer.personenbefoerderungGewuenscht ? "Ja" : "Nein",
    vertragsdatum: todayDE,
    vertragsbeginn: todayDE,
    vereinbarte_leistungen: "",
    vertragsstunden: "",
    vertragsperiode: "",
    kontaktperson_name: "",
    kontaktperson_telefon: "",
    kontaktperson_email: "",
    kontaktperson_typ: "",
    mandatsreferenz: `SE-${customerId}-${today.getFullYear()}`,
    current_date: todayDE,
    heute: todayDE,
    company_name: "SeniorenEngel GmbH",
    customer_signature: "",
    employee_signature: "",
    ...overrides,
  };

  return placeholders;
}

export function renderTemplate(htmlContent: string, placeholders: TemplatePlaceholders): string {
  let rendered = htmlContent;

  rendered = rendered.replace(/\{\{input:([^}]+)\}\}/g, (_match, rawLabel: string) => {
    const label = rawLabel.trim();
    const key = `input_${label.toLowerCase().replace(/[^a-zäöüß0-9]+/gi, "_").replace(/^_|_$/g, "")}`;
    const value = placeholders[key];
    return value ? escapeHtml(value) : "";
  });

  for (const [key, value] of Object.entries(placeholders)) {
    const isSignature = key.includes("signature");
    const safeValue = isSignature ? value : escapeHtml(value);
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    rendered = rendered.replace(pattern, safeValue);
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
