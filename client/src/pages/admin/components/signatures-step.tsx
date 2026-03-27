import { useState, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { SignaturePad, type SignatureMetadata } from "@/components/ui/signature-pad";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { FileText, Check, AlertCircle, Loader2, AlertTriangle, Upload, Camera, X, Pen, ChevronDown, ChevronUp, Eye, ArrowLeft } from "lucide-react";
import { iconSize } from "@/design-system";
import { type BillingType } from "@shared/domain/customers";
import { useUpload } from "@/hooks/use-upload";
import { useToast } from "@/hooks/use-toast";
import { DocumentPreview } from "@/features/documents/document-preview";
import type { CustomerFormData } from "./customer-types";

interface DocumentRequirement {
  documentType: {
    id: number;
    name: string;
    description: string | null;
    inputMethod: string;
  };
  requirement: "pflicht" | "optional";
  triggeredBy: string;
  template?: {
    id: number;
    slug: string;
    name: string;
  } | null;
}

export interface WizardUploadedDoc {
  documentTypeId: number;
  fileName: string;
  objectPath: string;
}

interface SignaturesStepProps {
  billingType: BillingType | "";
  customerSignatures: Record<string, string>;
  onSignatureChange: (slug: string, signatureData: string, location?: string | null) => void;
  uploadedDocuments: WizardUploadedDoc[];
  onUploadedDocumentsChange: (docs: WizardUploadedDoc[]) => void;
  formData?: CustomerFormData;
}


export function SignaturesStep({
  billingType,
  customerSignatures,
  onSignatureChange,
  uploadedDocuments,
  onUploadedDocumentsChange,
  formData,
}: SignaturesStepProps) {
  const { data: requirements, isLoading, isError, refetch } = useQuery({
    queryKey: ["/api/customers/document-requirements", billingType],
    queryFn: async () => {
      const result = await api.get<DocumentRequirement[]>(
        `/customers/document-requirements/${billingType}`
      );
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="loading-signatures">
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

  const pflichtDocs = requirements?.filter(r => r.requirement === "pflicht") || [];
  const optionalDocs = requirements?.filter(r => r.requirement === "optional") || [];

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
          {pflichtDocs.map((req) => (
            <RequirementCard
              key={req.documentType.id}
              requirement={req}
              signature={req.template ? customerSignatures[req.template.slug] : undefined}
              onSignatureChange={(data, location) => {
                if (req.template) onSignatureChange(req.template.slug, data, location);
              }}
              uploadedDoc={uploadedDocuments.find(u => u.documentTypeId === req.documentType.id)}
              onDocUploaded={(uploaded) => {
                const filtered = uploadedDocuments.filter(u => u.documentTypeId !== req.documentType.id);
                onUploadedDocumentsChange([...filtered, uploaded]);
              }}
              onDocRemoved={() => {
                onUploadedDocumentsChange(uploadedDocuments.filter(u => u.documentTypeId !== req.documentType.id));
              }}
              formData={formData}
            />
          ))}
        </div>
      )}

      {optionalDocs.length > 0 && (
        <OptionalDocsSection
          requirements={optionalDocs}
          customerSignatures={customerSignatures}
          onSignatureChange={onSignatureChange}
          uploadedDocuments={uploadedDocuments}
          onUploadedDocumentsChange={onUploadedDocumentsChange}
          formData={formData}
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

function RequirementCard({
  requirement,
  signature,
  onSignatureChange,
  uploadedDoc,
  onDocUploaded,
  onDocRemoved,
  formData,
}: {
  requirement: DocumentRequirement;
  signature?: string;
  onSignatureChange: (data: string, location?: string | null) => void;
  uploadedDoc?: WizardUploadedDoc;
  onDocUploaded: (doc: WizardUploadedDoc) => void;
  onDocRemoved: () => void;
  formData?: CustomerFormData;
}) {
  const { toast } = useToast();
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const { documentType, template } = requirement;
  const canSign = (documentType.inputMethod === "signature" || documentType.inputMethod === "both") && !!template;
  const canUpload = documentType.inputMethod === "upload" || documentType.inputMethod === "both" || !template;

  const isSigned = !!signature;
  const isUploaded = !!uploadedDoc;
  const isFulfilled = isSigned || isUploaded;
  const testSlug = template?.slug ?? `type-${documentType.id}`;

  const { uploadFile, isUploading } = useUpload({
    onError: (error) => {
      toast({ title: "Upload-Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleFileSelect = useCallback(async (file: File) => {
    const result = await uploadFile(file);
    if (result) {
      onDocUploaded({
        documentTypeId: documentType.id,
        fileName: file.name,
        objectPath: result.objectPath,
      });
      setShowUpload(false);
    }
  }, [documentType.id, uploadFile, onDocUploaded]);

  const handleSignatureSave = useCallback((signatureData: string, metadata?: SignatureMetadata) => {
    const location = metadata?.location ? `${metadata.location.lat},${metadata.location.lng}` : null;
    onSignatureChange(signatureData, location);
    setShowSignaturePad(false);
    setShowPreview(false);
    setPreviewHtml(null);
    if (isUploaded) onDocRemoved();
  }, [onSignatureChange, isUploaded, onDocRemoved]);

  const handleShowPreview = useCallback(async () => {
    if (previewHtml) {
      setShowPreview(true);
      return;
    }

    if (!formData || !template) {
      toast({ title: "Hinweis", description: "Vorschau ist nur verfügbar, wenn Kundendaten ausgefüllt sind.", variant: "destructive" });
      return;
    }

    setIsLoadingPreview(true);
    try {
      const result = await api.post("/admin/document-templates/render-preview", {
        templateSlug: template.slug,
        formData: {
          vorname: formData.vorname,
          nachname: formData.nachname,
          geburtsdatum: formData.geburtsdatum,
          email: formData.email,
          telefon: formData.telefon,
          festnetz: formData.festnetz,
          strasse: formData.strasse,
          nr: formData.nr,
          plz: formData.plz,
          stadt: formData.stadt,
          pflegegrad: formData.pflegegrad,
          billingType: formData.billingType,
          vorerkrankungen: formData.vorerkrankungen,
          haustierVorhanden: formData.haustierVorhanden,
          haustierDetails: formData.haustierDetails,
          personenbefoerderungGewuenscht: formData.personenbefoerderungGewuenscht,
          versichertennummer: formData.versichertennummer,
          contractDate: formData.contractDate,
          contractStart: formData.contractStart,
          vereinbarteLeistungen: formData.vereinbarteLeistungen,
          contractHours: formData.contractHours,
          contractPeriod: formData.contractPeriod,
          contacts: formData.contacts?.map(c => ({
            vorname: c.vorname,
            nachname: c.nachname,
            contactType: c.contactType,
            festnetz: c.festnetz,
            mobilnummer: c.mobilnummer,
            email: c.email,
            isPrimary: c.isPrimary,
          })),
          insuranceProviderId: formData.insuranceProviderId,
        },
        overrides: signature ? {
          customer_signature: `<img src="${signature}" alt="Kundenunterschrift" style="max-height:240px;" />`,
        } : undefined,
      });
      const data = unwrapResult(result) as { html: string };
      setPreviewHtml(data.html);
      setShowPreview(true);
    } catch (error: unknown) {
      toast({
        title: "Vorschau-Fehler",
        description: error instanceof Error ? error.message : "Dokument konnte nicht geladen werden",
        variant: "destructive",
      });
    } finally {
      setIsLoadingPreview(false);
    }
  }, [previewHtml, formData, template, toast, signature]);

  return (
    <Card
      className={`transition-colors ${isFulfilled ? "border-green-200 bg-green-50/30" : "border-gray-200"}`}
      data-testid={`signature-doc-${testSlug}`}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0 ${
              isFulfilled ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-500"
            }`}
            aria-label={isFulfilled ? "Erledigt" : "Noch offen"}
          >
            {isFulfilled ? <Check className={iconSize.sm} /> : <FileText className={iconSize.sm} />}
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-gray-900">{documentType.name}</h4>
            <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
              <Badge
                variant={requirement.requirement === "pflicht" ? "destructive" : "secondary"}
                className="text-[10px] px-1.5 py-0.5 leading-none"
              >
                {requirement.requirement === "pflicht" ? "Pflicht" : "Optional"}
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
          </div>
        </div>
        {documentType.description && (
          <p className="text-sm text-gray-500">{documentType.description}</p>
        )}

        {showPreview && previewHtml && (
          <div className="space-y-3">
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <DocumentPreview html={previewHtml} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowPreview(false)}
                className="min-h-[44px]"
                data-testid={`button-close-preview-${testSlug}`}
              >
                <ArrowLeft className={`${iconSize.sm} mr-1.5`} />
                Vorschau schließen
              </Button>
              {canSign && !isSigned && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setShowPreview(false);
                    setShowSignaturePad(true);
                  }}
                  className="min-h-[44px] bg-teal-600 hover:bg-teal-700"
                  data-testid={`button-sign-after-preview-${testSlug}`}
                >
                  <Pen className={`${iconSize.sm} mr-1.5`} />
                  Jetzt unterschreiben
                </Button>
              )}
            </div>
          </div>
        )}

        {!showPreview && (
          <div className="space-y-2">
            {showSignaturePad && canSign ? (
              <SignaturePad
                title={`Unterschrift: ${documentType.name}`}
                onSave={handleSignatureSave}
                onCancel={() => setShowSignaturePad(false)}
              />
            ) : showUpload && canUpload ? (
              <UploadArea
                isUploading={isUploading}
                onFileSelect={handleFileSelect}
                onCancel={() => setShowUpload(false)}
                cameraInputRef={cameraInputRef}
                testIdSuffix={testSlug}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {canSign && formData && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleShowPreview}
                    disabled={isLoadingPreview}
                    className="text-sm min-h-[44px]"
                    data-testid={`button-preview-${testSlug}`}
                  >
                    {isLoadingPreview ? (
                      <><Loader2 className={`${iconSize.sm} mr-1.5 animate-spin`} />Wird geladen...</>
                    ) : (
                      <><Eye className={`${iconSize.sm} mr-1.5`} />Vorschau</>
                    )}
                  </Button>
                )}
                {canSign && (
                  <Button
                    type="button"
                    variant={isSigned ? "outline" : "default"}
                    onClick={() => setShowSignaturePad(true)}
                    className={`text-sm min-h-[44px] ${!isSigned ? "bg-teal-600 hover:bg-teal-700" : ""}`}
                    data-testid={`button-sign-${testSlug}`}
                  >
                    <Pen className={`${iconSize.sm} mr-1.5`} />
                    {isSigned ? "Unterschrift ändern" : "Unterschreiben"}
                  </Button>
                )}
                {canUpload && (
                  <Button
                    type="button"
                    variant={canSign ? "outline" : (isUploaded ? "outline" : "default")}
                    onClick={() => setShowUpload(true)}
                    className={`text-sm min-h-[44px] ${!canSign && !isUploaded ? "bg-teal-600 hover:bg-teal-700" : ""}`}
                    data-testid={`button-upload-alt-${testSlug}`}
                  >
                    <Upload className={`${iconSize.sm} mr-1.5`} />
                    {isUploaded ? "Erneut hochladen" : (canSign ? "Stattdessen hochladen" : "Hochladen")}
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
                  className="p-2 text-gray-500 hover:text-red-500 rounded-md"
                  aria-label="Upload entfernen"
                  data-testid={`button-remove-upload-${testSlug}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        )}
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
        data-testid={`input-camera-${testSlug}`}
      />
    </Card>
  );
}

function OptionalDocsSection({
  requirements,
  customerSignatures,
  onSignatureChange,
  uploadedDocuments,
  onUploadedDocumentsChange,
  formData,
}: {
  requirements: DocumentRequirement[];
  customerSignatures: Record<string, string>;
  onSignatureChange: (slug: string, signatureData: string, location?: string | null) => void;
  uploadedDocuments: WizardUploadedDoc[];
  onUploadedDocumentsChange: (docs: WizardUploadedDoc[]) => void;
  formData?: CustomerFormData;
}) {
  const [expanded, setExpanded] = useState(false);
  const uploadedCount = requirements.filter(r =>
    uploadedDocuments.some(u => u.documentTypeId === r.documentType.id) ||
    (r.template && customerSignatures[r.template.slug])
  ).length;

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
          Optionale Dokumente ({uploadedCount}/{requirements.length})
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
      </button>
      {expanded && (
        <div className="space-y-3">
          {requirements.map((req) => (
            <RequirementCard
              key={req.documentType.id}
              requirement={req}
              signature={req.template ? customerSignatures[req.template.slug] : undefined}
              onSignatureChange={(data, location) => {
                if (req.template) onSignatureChange(req.template.slug, data, location);
              }}
              uploadedDoc={uploadedDocuments.find(u => u.documentTypeId === req.documentType.id)}
              onDocUploaded={(uploaded) => {
                const filtered = uploadedDocuments.filter(u => u.documentTypeId !== req.documentType.id);
                onUploadedDocumentsChange([...filtered, uploaded]);
              }}
              onDocRemoved={() => {
                onUploadedDocumentsChange(uploadedDocuments.filter(u => u.documentTypeId !== req.documentType.id));
              }}
              formData={formData}
            />
          ))}
        </div>
      )}
    </div>
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
      <p className="text-[11px] text-gray-500">PDF, Bild oder Word-Dokument (max. 10 MB)</p>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} data-testid={`button-cancel-upload-${testIdSuffix}`}>
        Abbrechen
      </Button>
    </div>
  );
}
