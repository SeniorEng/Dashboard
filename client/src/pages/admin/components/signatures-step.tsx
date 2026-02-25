import { useState, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { SignaturePad, type SignatureMetadata } from "@/components/ui/signature-pad";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { FileText, Check, AlertCircle, Loader2, AlertTriangle, Upload, Camera, X, Pen, ChevronDown, ChevronUp } from "lucide-react";
import { iconSize } from "@/design-system";
import { BILLING_TYPE_LABELS, type BillingType } from "@shared/domain/customers";
import { useUpload } from "@/hooks/use-upload";
import { useToast } from "@/hooks/use-toast";
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

interface DocumentTypeWithTemplate {
  id: number;
  name: string;
  description: string | null;
  targetType: string;
  context: string;
  hasTemplate: boolean;
  templateName: string | null;
  templateSlug: string | null;
}

export interface WizardUploadedDoc {
  documentTypeId: number;
  fileName: string;
  objectPath: string;
}

type CustomerFormDataForPreview = CustomerFormData;

interface SignaturesStepProps {
  billingType: BillingType;
  customerSignatures: Record<string, string>;
  onSignatureChange: (slug: string, signatureData: string, location?: string | null) => void;
  uploadedDocuments: WizardUploadedDoc[];
  onUploadedDocumentsChange: (docs: WizardUploadedDoc[]) => void;
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
  const isFullDocument = html.trimStart().startsWith("<!DOCTYPE") || html.trimStart().startsWith("<html");

  if (isFullDocument) {
    const win = window.open("", "_blank");
    if (win) {
      win.document.write(html);
      win.document.close();
    }
    return;
  }

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


export function SignaturesStep({
  billingType,
  customerSignatures,
  onSignatureChange,
  uploadedDocuments,
  onUploadedDocumentsChange,
  formData,
}: SignaturesStepProps) {
  const { data: templates, isLoading: templatesLoading, isError, refetch } = useQuery({
    queryKey: ["/api/customers/document-templates/billing-type", billingType],
    queryFn: async () => {
      const result = await api.get<TemplateWithRequirement[]>(
        `/customers/document-templates/billing-type/${billingType}`
      );
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const { data: docTypes, isLoading: docTypesLoading } = useQuery({
    queryKey: ["customers", "document-types", "customer", "vertragsabschluss"],
    queryFn: async () => {
      const result = await api.get<DocumentTypeWithTemplate[]>(
        "/customers/document-types/customer?context=vertragsabschluss"
      );
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  const isLoading = templatesLoading || docTypesLoading;

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

  const templateSlugs = new Set((templates || []).map(t => t.slug));
  const uploadOnlyDocTypes = (docTypes || []).filter(dt => !dt.hasTemplate && !templateSlugs.has(dt.templateSlug || ""));

  const pflichtDocs = templates?.filter(t => t.requirement === "pflicht") || [];
  const optionalDocs = templates?.filter(t => t.requirement === "optional") || [];

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Folgende Dokumente werden bei der Kundenanlage benötigt. Sie können digital unterschrieben oder als physisches Dokument hochgeladen werden.
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
              onSignatureChange={(data, location) => onSignatureChange(doc.slug, data, location)}
              uploadedDoc={uploadedDocuments.find(u => {
                const matchingType = (docTypes || []).find(dt => dt.templateSlug === doc.slug);
                return matchingType && u.documentTypeId === matchingType.id;
              })}
              documentTypeId={(docTypes || []).find(dt => dt.templateSlug === doc.slug)?.id}
              onDocUploaded={(uploaded) => {
                const matchingType = (docTypes || []).find(dt => dt.templateSlug === doc.slug);
                if (!matchingType) return;
                const filtered = uploadedDocuments.filter(u => u.documentTypeId !== matchingType.id);
                onUploadedDocumentsChange([...filtered, uploaded]);
              }}
              onDocRemoved={() => {
                const matchingType = (docTypes || []).find(dt => dt.templateSlug === doc.slug);
                if (!matchingType) return;
                onUploadedDocumentsChange(uploadedDocuments.filter(u => u.documentTypeId !== matchingType.id));
              }}
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
              onSignatureChange={(data, location) => onSignatureChange(doc.slug, data, location)}
              uploadedDoc={uploadedDocuments.find(u => {
                const matchingType = (docTypes || []).find(dt => dt.templateSlug === doc.slug);
                return matchingType && u.documentTypeId === matchingType.id;
              })}
              documentTypeId={(docTypes || []).find(dt => dt.templateSlug === doc.slug)?.id}
              onDocUploaded={(uploaded) => {
                const matchingType = (docTypes || []).find(dt => dt.templateSlug === doc.slug);
                if (!matchingType) return;
                const filtered = uploadedDocuments.filter(u => u.documentTypeId !== matchingType.id);
                onUploadedDocumentsChange([...filtered, uploaded]);
              }}
              onDocRemoved={() => {
                const matchingType = (docTypes || []).find(dt => dt.templateSlug === doc.slug);
                if (!matchingType) return;
                onUploadedDocumentsChange(uploadedDocuments.filter(u => u.documentTypeId !== matchingType.id));
              }}
              formData={formData}
            />
          ))}
        </div>
      )}

      {uploadOnlyDocTypes.length > 0 && (
        <OptionalDocsSection
          uploadOnlyDocTypes={uploadOnlyDocTypes}
          uploadedDocuments={uploadedDocuments}
          onUploadedDocumentsChange={onUploadedDocumentsChange}
        />
      )}

      <div className="p-3 bg-teal-50 border border-teal-100 rounded-lg">
        <p className="text-xs text-teal-800">
          Unterschriften und Uploads können auch nachträglich in der Kundenansicht unter "Dokumente" erfasst werden.
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
  uploadedDoc,
  documentTypeId,
  onDocUploaded,
  onDocRemoved,
  formData,
}: {
  doc: TemplateWithRequirement;
  signature?: string;
  onSignatureChange: (data: string, location?: string | null) => void;
  uploadedDoc?: WizardUploadedDoc;
  documentTypeId?: number;
  onDocUploaded: (doc: WizardUploadedDoc) => void;
  onDocRemoved: () => void;
  formData?: CustomerFormDataForPreview;
}) {
  const { toast } = useToast();
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const isSigned = !!signature;
  const isUploaded = !!uploadedDoc;
  const isFulfilled = isSigned || isUploaded;

  const { uploadFile, isUploading } = useUpload({
    onError: (error) => {
      toast({ title: "Upload-Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleFileSelect = useCallback(async (file: File) => {
    if (!documentTypeId) return;
    const result = await uploadFile(file);
    if (result) {
      onDocUploaded({
        documentTypeId,
        fileName: file.name,
        objectPath: result.objectPath,
      });
      setShowUpload(false);
    }
  }, [documentTypeId, uploadFile, onDocUploaded]);

  const handlePreview = useCallback(() => {
    if (!formData || !doc.htmlContent) return;
    const rendered = renderClientSide(doc.htmlContent, formData, signature);
    openPrintPreview(rendered, doc.name);
  }, [doc, formData, signature]);

  const handleSignatureSave = useCallback((signatureData: string, metadata?: SignatureMetadata) => {
    const location = metadata?.location ? `${metadata.location.lat},${metadata.location.lng}` : null;
    onSignatureChange(signatureData, location);
    setShowSignaturePad(false);
    if (isUploaded) onDocRemoved();
  }, [onSignatureChange, isUploaded, onDocRemoved]);

  return (
    <Card
      className={`transition-colors ${isFulfilled ? "border-green-200 bg-green-50/30" : "border-gray-200"}`}
      data-testid={`signature-doc-${doc.slug}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex items-center justify-center w-10 h-10 rounded-full shrink-0 ${
              isFulfilled ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"
            }`}
            aria-label={isFulfilled ? "Erledigt" : "Noch offen"}
          >
            {isFulfilled ? <Check className={iconSize.md} /> : <FileText className={iconSize.md} />}
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
              {isUploaded && !isSigned && (
                <Badge variant="default" className="text-[10px] px-1.5 py-0.5 leading-none bg-blue-600">
                  Hochgeladen
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
              ) : showUpload ? (
                <UploadArea
                  isUploading={isUploading}
                  onFileSelect={handleFileSelect}
                  onCancel={() => setShowUpload(false)}
                  cameraInputRef={cameraInputRef}
                  testIdSuffix={doc.slug}
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={isSigned ? "outline" : "default"}
                    onClick={() => setShowSignaturePad(true)}
                    className={`text-sm min-h-[44px] ${!isSigned ? "bg-teal-600 hover:bg-teal-700" : ""}`}
                    data-testid={`button-sign-${doc.slug}`}
                  >
                    <Pen className={`${iconSize.sm} mr-1.5`} />
                    {isSigned ? "Unterschrift ändern" : "Unterschreiben"}
                  </Button>
                  {documentTypeId && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowUpload(true)}
                      className="text-sm min-h-[44px]"
                      data-testid={`button-upload-alt-${doc.slug}`}
                    >
                      <Upload className={`${iconSize.sm} mr-1.5`} />
                      {isUploaded ? "Erneut hochladen" : "Stattdessen hochladen"}
                    </Button>
                  )}
                </div>
              )}

              {isUploaded && !showUpload && (
                <div className="flex items-center gap-2 p-2 bg-blue-50 rounded-md">
                  <FileText className="h-4 w-4 text-blue-500 shrink-0" />
                  <span className="text-xs text-blue-700 truncate flex-1">{uploadedDoc!.fileName}</span>
                  <button
                    type="button"
                    onClick={() => onDocRemoved()}
                    className="text-xs text-gray-400 hover:text-red-500"
                    data-testid={`button-remove-upload-${doc.slug}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
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

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileSelect(file);
          e.target.value = "";
        }}
        className="hidden"
        data-testid={`input-camera-${doc.slug}`}
      />
    </Card>
  );
}

function OptionalDocsSection({
  uploadOnlyDocTypes,
  uploadedDocuments,
  onUploadedDocumentsChange,
}: {
  uploadOnlyDocTypes: DocumentTypeWithTemplate[];
  uploadedDocuments: WizardUploadedDoc[];
  onUploadedDocumentsChange: (docs: WizardUploadedDoc[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const uploadedCount = uploadOnlyDocTypes.filter(dt => uploadedDocuments.some(u => u.documentTypeId === dt.id)).length;

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-700 py-2"
        data-testid="toggle-optional-docs"
      >
        <span className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-gray-500" />
          Weitere Dokumente ({uploadedCount}/{uploadOnlyDocTypes.length})
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
      </button>
      {expanded && (
        <div className="space-y-3">
          {uploadOnlyDocTypes.map((dt) => (
            <UploadOnlyCard
              key={dt.id}
              docType={dt}
              uploadedDoc={uploadedDocuments.find(u => u.documentTypeId === dt.id)}
              onDocUploaded={(uploaded) => {
                const filtered = uploadedDocuments.filter(u => u.documentTypeId !== dt.id);
                onUploadedDocumentsChange([...filtered, uploaded]);
              }}
              onDocRemoved={() => {
                onUploadedDocumentsChange(uploadedDocuments.filter(u => u.documentTypeId !== dt.id));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadOnlyCard({
  docType,
  uploadedDoc,
  onDocUploaded,
  onDocRemoved,
}: {
  docType: DocumentTypeWithTemplate;
  uploadedDoc?: WizardUploadedDoc;
  onDocUploaded: (doc: WizardUploadedDoc) => void;
  onDocRemoved: () => void;
}) {
  const { toast } = useToast();
  const [showUpload, setShowUpload] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const isUploaded = !!uploadedDoc;

  const { uploadFile, isUploading } = useUpload({
    onError: (error) => {
      toast({ title: "Upload-Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleFileSelect = useCallback(async (file: File) => {
    const result = await uploadFile(file);
    if (result) {
      onDocUploaded({
        documentTypeId: docType.id,
        fileName: file.name,
        objectPath: result.objectPath,
      });
      setShowUpload(false);
    }
  }, [docType.id, uploadFile, onDocUploaded]);

  return (
    <Card
      className={`transition-colors ${isUploaded ? "border-green-200 bg-green-50/30" : "border-gray-200"}`}
      data-testid={`upload-only-doc-${docType.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex items-center justify-center w-10 h-10 rounded-full shrink-0 ${
              isUploaded ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"
            }`}
          >
            {isUploaded ? <Check className={iconSize.md} /> : <Upload className={iconSize.md} />}
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-gray-900">{docType.name}</h4>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 leading-none">
                Nur Upload
              </Badge>
              {isUploaded && (
                <Badge variant="default" className="text-[10px] px-1.5 py-0.5 leading-none bg-blue-600">
                  Hochgeladen
                </Badge>
              )}
            </div>
            {docType.description && (
              <p className="text-sm text-gray-500 mt-1.5">{docType.description}</p>
            )}

            <div className="space-y-2 mt-3">
              {showUpload ? (
                <UploadArea
                  isUploading={isUploading}
                  onFileSelect={handleFileSelect}
                  onCancel={() => setShowUpload(false)}
                  cameraInputRef={cameraInputRef}
                  testIdSuffix={`type-${docType.id}`}
                />
              ) : (
                <Button
                  type="button"
                  variant={isUploaded ? "outline" : "default"}
                  onClick={() => setShowUpload(true)}
                  className={`text-sm min-h-[44px] ${!isUploaded ? "bg-teal-600 hover:bg-teal-700" : ""}`}
                  data-testid={`button-upload-${docType.id}`}
                >
                  <Upload className={`${iconSize.sm} mr-1.5`} />
                  {isUploaded ? "Erneut hochladen" : "Hochladen"}
                </Button>
              )}

              {isUploaded && !showUpload && (
                <div className="flex items-center gap-2 p-2 bg-blue-50 rounded-md">
                  <FileText className="h-4 w-4 text-blue-500 shrink-0" />
                  <span className="text-xs text-blue-700 truncate flex-1">{uploadedDoc!.fileName}</span>
                  <button
                    type="button"
                    onClick={() => onDocRemoved()}
                    className="text-xs text-gray-400 hover:text-red-500"
                    data-testid={`button-remove-upload-type-${docType.id}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileSelect(file);
          e.target.value = "";
        }}
        className="hidden"
        data-testid={`input-camera-type-${docType.id}`}
      />
    </Card>
  );
}

function UploadArea({
  isUploading,
  onFileSelect,
  onCancel,
  cameraInputRef,
  testIdSuffix,
}: {
  isUploading: boolean;
  onFileSelect: (file: File) => void;
  onCancel: () => void;
  cameraInputRef: React.RefObject<HTMLInputElement | null>;
  testIdSuffix: string;
}) {
  return (
    <div className="p-3 bg-gray-50 rounded-lg space-y-2">
      <Label>Dokument hochladen</Label>
      <div className="flex gap-2">
        <label className="flex-1 cursor-pointer">
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFileSelect(file);
              e.target.value = "";
            }}
            className="hidden"
            disabled={isUploading}
            data-testid={`input-file-upload-${testIdSuffix}`}
          />
          <div className="flex items-center justify-center gap-2 h-10 px-3 rounded-md border border-gray-200 bg-white text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100 transition-colors">
            {isUploading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Wird hochgeladen...</>
            ) : (
              <><Upload className="h-4 w-4" /> Datei wählen</>
            )}
          </div>
        </label>
        <Button
          type="button"
          variant="outline"
          onClick={() => cameraInputRef.current?.click()}
          disabled={isUploading}
          className="flex items-center gap-2"
          data-testid={`button-camera-upload-${testIdSuffix}`}
        >
          <Camera className="h-4 w-4" />
          Foto
        </Button>
      </div>
      <p className="text-[11px] text-gray-400">PDF, Bild oder Word-Dokument (max. 10 MB)</p>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} data-testid={`button-cancel-upload-${testIdSuffix}`}>
        Abbrechen
      </Button>
    </div>
  );
}
