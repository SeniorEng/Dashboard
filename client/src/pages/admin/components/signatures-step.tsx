import { useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SignaturePad } from "@/components/ui/signature-pad";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { FileText, Check, AlertCircle, Loader2, AlertTriangle } from "lucide-react";
import { iconSize } from "@/design-system";
import { BILLING_TYPE_LABELS, type BillingType } from "@shared/domain/customers";
import type { CustomerFormData, ContactFormData } from "./customer-types";

interface TemplateWithRequirement {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  htmlContent: string;
  requirement: string;
  sortOrder: number;
}

type CustomerFormDataForPreview = CustomerFormData;

interface SignaturesStepProps {
  billingType: BillingType;
  customerSignatures: Record<string, string>;
  onSignatureChange: (slug: string, signatureData: string) => void;
  formData?: CustomerFormDataForPreview;
}

function formatDateDE(dateStr: string): string {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function getPrimaryContact(contacts: ContactFormData[]): ContactFormData | undefined {
  return contacts.find(c => c.isPrimary) || contacts[0];
}

function renderClientSide(htmlContent: string, formData: CustomerFormDataForPreview, signatureData?: string): string {
  const today = new Date();
  const todayDE = `${today.getDate().toString().padStart(2, "0")}.${(today.getMonth() + 1).toString().padStart(2, "0")}.${today.getFullYear()}`;
  const primaryContact = getPrimaryContact(formData.contacts || []);
  const periodLabel = formData.contractPeriod === "monthly" ? "pro Monat" : "pro Woche";

  const placeholders: Record<string, string> = {
    customer_name: `${formData.vorname} ${formData.nachname}`.trim(),
    customer_vorname: formData.vorname || "",
    customer_nachname: formData.nachname || "",
    customer_address: [`${formData.strasse} ${formData.nr}`.trim(), `${formData.plz} ${formData.stadt}`.trim()].filter(Boolean).join(", "),
    customer_strasse: formData.strasse || "",
    customer_hausnummer: formData.nr || "",
    customer_plz: formData.plz || "",
    customer_stadt: formData.stadt || "",
    customer_birthdate: formatDateDE(formData.geburtsdatum),
    customer_phone: formData.telefon || "",
    customer_festnetz: formData.festnetz || "",
    customer_email: formData.email || "",
    pflegegrad: formData.pflegegrad && formData.pflegegrad !== "0" ? `Pflegegrad ${formData.pflegegrad}` : "",
    pflegegrad_nummer: formData.pflegegrad && formData.pflegegrad !== "0" ? formData.pflegegrad : "",
    pflegegrad_seit: formatDateDE(formData.pflegegradSeit),
    abrechnungsart: BILLING_TYPE_LABELS[formData.billingType] || formData.billingType,
    versichertennummer: formData.versichertennummer || "",
    vorerkrankungen: formData.vorerkrankungen || "",
    haustier: formData.haustierVorhanden ? "Ja" : "Nein",
    haustier_details: formData.haustierDetails || "",
    personenbefoerderung: formData.personenbefoerderungGewuenscht ? "Ja" : "Nein",
    vertragsdatum: formatDateDE(formData.contractDate),
    vertragsbeginn: formatDateDE(formData.contractStart),
    vereinbarte_leistungen: formData.vereinbarteLeistungen || "",
    vertragsstunden: formData.contractHours || "",
    vertragsperiode: periodLabel,
    kontaktperson_name: primaryContact ? `${primaryContact.vorname} ${primaryContact.nachname}`.trim() : "",
    kontaktperson_telefon: primaryContact?.telefon || "",
    kontaktperson_email: primaryContact?.email || "",
    kontaktperson_typ: primaryContact?.contactType || "",
    mandatsreferenz: `SE-[wird nach Speicherung ergänzt]-${today.getFullYear()}`,
    current_date: todayDE,
    heute: todayDE,
    company_name: "SeniorenEngel GmbH",
    customer_signature: signatureData ? `<img src="${signatureData}" style="max-height:60px;" />` : "",
    employee_signature: "",
  };

  let rendered = htmlContent;
  for (const [key, value] of Object.entries(placeholders)) {
    rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  rendered = rendered.replace(/\{\{[a-z_]+\}\}/g, "");
  return rendered;
}

function openPrintPreview(html: string, title: string) {
  const fullHtml = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  @page { margin: 2cm; size: A4; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; font-size: 12pt; line-height: 1.6; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 2cm; }
  h1 { font-size: 18pt; margin-bottom: 0.5em; }
  h2 { font-size: 14pt; margin-top: 1.5em; margin-bottom: 0.5em; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1em 0; }
  .signatures { display: flex; gap: 2cm; margin-top: 3em; page-break-inside: avoid; }
  .signature-block { flex: 1; }
  .signature-area { border-bottom: 1px solid #333; min-height: 60px; margin-top: 0.5em; display: flex; align-items: flex-end; }
  .signature-area img { max-height: 60px; }
  @media print { body { padding: 0; } .no-print { display: none !important; } }
</style>
</head>
<body>
<div class="no-print" style="text-align:center; padding:12px; margin-bottom:20px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px;">
  <button onclick="window.print()" style="padding:10px 24px; font-size:14px; background:#0d9488; color:white; border:none; border-radius:6px; cursor:pointer; margin-right:8px;">Als PDF drucken / speichern</button>
  <button onclick="window.close()" style="padding:10px 24px; font-size:14px; background:#e5e7eb; color:#374151; border:none; border-radius:6px; cursor:pointer;">Schließen</button>
</div>
${html}
</body>
</html>`;

  const win = window.open("", "_blank");
  if (win) {
    win.document.write(fullHtml);
    win.document.close();
  }
}


export function SignaturesStep({ billingType, customerSignatures, onSignatureChange, formData }: SignaturesStepProps) {
  const { data: templates, isLoading, isError, refetch } = useQuery({
    queryKey: ["/api/customers/document-templates/billing-type", billingType],
    queryFn: async () => {
      const result = await api.get<TemplateWithRequirement[]>(
        `/customers/document-templates/billing-type/${billingType}`
      );
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <AlertTriangle className="w-8 h-8 text-amber-500" />
        <p className="text-sm text-gray-600 text-center">
          Dokumentvorlagen konnten nicht geladen werden.
        </p>
        <Button variant="outline" onClick={() => refetch()} className="min-h-[44px]" data-testid="button-retry-templates">
          Erneut versuchen
        </Button>
      </div>
    );
  }

  const pflichtDocs = templates?.filter(t => t.requirement === "pflicht") || [];
  const optionalDocs = templates?.filter(t => t.requirement === "optional") || [];

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Folgende Dokumente müssen vom Kunden unterschrieben werden. Pflichtdokumente sind markiert.
      </p>

      {pflichtDocs.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500" />
            Pflichtdokumente
          </h3>
          {pflichtDocs.map((doc) => (
            <DocumentSignatureCard
              key={doc.slug}
              doc={doc}
              signature={customerSignatures[doc.slug]}
              onSignatureChange={(data) => onSignatureChange(doc.slug, data)}
              formData={formData}
            />
          ))}
        </div>
      )}

      {optionalDocs.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">
            Optionale Dokumente
          </h3>
          {optionalDocs.map((doc) => (
            <DocumentSignatureCard
              key={doc.slug}
              doc={doc}
              signature={customerSignatures[doc.slug]}
              onSignatureChange={(data) => onSignatureChange(doc.slug, data)}
              formData={formData}
            />
          ))}
        </div>
      )}

      <div className="p-3 bg-teal-50 border border-teal-100 rounded-lg">
        <p className="text-xs text-teal-800">
          Unterschriften können auch nachträglich in der Kundenansicht unter "Dokumente" erfasst werden.
          Der Kunde kann trotzdem angelegt werden.
        </p>
      </div>
    </div>
  );
}

function DocumentSignatureCard({
  doc,
  signature,
  onSignatureChange,
  formData,
}: {
  doc: TemplateWithRequirement;
  signature?: string;
  onSignatureChange: (data: string) => void;
  formData?: CustomerFormDataForPreview;
}) {
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const isSigned = !!signature;

  const handlePreview = useCallback(() => {
    if (!formData || !doc.htmlContent) return;
    const rendered = renderClientSide(doc.htmlContent, formData, signature);
    openPrintPreview(rendered, doc.name);
  }, [doc, formData, signature]);

  const handleSignatureSave = useCallback((signatureData: string) => {
    onSignatureChange(signatureData);
    setShowSignaturePad(false);
  }, [onSignatureChange]);

  return (
    <Card
      className={`transition-colors ${isSigned ? "border-green-200 bg-green-50/30" : "border-gray-200"}`}
      data-testid={`signature-doc-${doc.slug}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex items-center justify-center w-10 h-10 rounded-full shrink-0 ${
              isSigned ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"
            }`}
            aria-label={isSigned ? "Unterschrieben" : "Noch nicht unterschrieben"}
          >
            {isSigned ? <Check className={iconSize.md} /> : <FileText className={iconSize.md} />}
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-gray-900">{doc.name}</h4>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <Badge
                variant={doc.requirement === "pflicht" ? "destructive" : "secondary"}
                className="text-[10px] px-1.5 py-0.5 leading-none"
              >
                {doc.requirement === "pflicht" ? "Pflicht" : "Optional"}
              </Badge>
              {isSigned && (
                <Badge variant="default" className="text-[10px] px-1.5 py-0.5 leading-none bg-green-600">
                  Unterschrieben
                </Badge>
              )}
            </div>
            {doc.description && (
              <p className="text-sm text-gray-500 mt-1.5">{doc.description}</p>
            )}

            <div className="space-y-2 mt-3">
              {showSignaturePad ? (
                <SignaturePad
                  title={`Unterschrift: ${doc.name}`}
                  onSave={handleSignatureSave}
                  onCancel={() => setShowSignaturePad(false)}
                />
              ) : (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowSignaturePad(true)}
                    className="text-sm min-h-[44px]"
                    data-testid={`button-sign-${doc.slug}`}
                  >
                    {isSigned ? "Unterschrift ändern" : "Unterschreiben"}
                  </Button>
                </div>
              )}
              {isSigned && formData && doc.htmlContent && (
                <div className="pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handlePreview}
                    className="text-sm min-h-[44px] w-full justify-center text-teal-700 border-teal-300 bg-teal-50 hover:bg-teal-100"
                    data-testid={`button-preview-${doc.slug}`}
                  >
                    <FileText className={`${iconSize.sm} mr-1.5`} />
                    Vorschau & Drucken
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
