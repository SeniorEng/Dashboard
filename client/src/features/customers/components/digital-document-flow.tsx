import { useState, useCallback } from "react";
import DOMPurify from "dompurify";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  FileText,
  ArrowLeft,
  Check,
  Eye,
  Pen,
  Download,
  ClipboardEdit,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";
import { SignaturePad } from "@/components/ui/signature-pad";

interface InputField {
  key: string;
  label: string;
}

interface TemplateOption {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  context: string;
  targetType: string;
  requiresCustomerSignature: boolean;
  requiresEmployeeSignature: boolean;
  documentTypeId: number | null;
  version: number;
  inputFields: InputField[];
}

interface RenderResult {
  html: string;
  printableHtml: string;
  templateId: number;
  templateVersion: number;
}

interface GenerateResult {
  id: number;
  fileName: string;
  objectPath: string;
  integrityHash: string;
  signingStatus?: string;
  signingLink?: string | null;
}

type FlowStep = "select" | "fill-inputs" | "preview" | "sign-customer" | "sign-employee" | "generating" | "done";

interface DigitalDocumentFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: number;
  customerName: string;
  onComplete?: () => void;
}

export function DigitalDocumentFlow({
  open,
  onOpenChange,
  customerId,
  customerName,
  onComplete,
}: DigitalDocumentFlowProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<FlowStep>("select");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null);
  const [customerSignature, setCustomerSignature] = useState<string | null>(null);
  const [employeeSignature, setEmployeeSignature] = useState<string | null>(null);
  const [generatedDoc, setGeneratedDoc] = useState<GenerateResult | null>(null);
  const [isRendering, setIsRendering] = useState(false);

  const { data: templates, isLoading: templatesLoading } = useQuery<TemplateOption[]>({
    queryKey: ["customers", customerId, "document-templates"],
    queryFn: async () => {
      const result = await api.get<TemplateOption[]>(`/customers/${customerId}/document-templates`);
      return unwrapResult(result);
    },
    enabled: open,
  });

  const selectedTemplate = templates?.find(t => t.id.toString() === selectedTemplateId);
  const hasInputFields = selectedTemplate && selectedTemplate.inputFields.length > 0;

  const generateMutation = useMutation({
    mutationFn: async (data: {
      templateId: number;
      customerSignatureData?: string | null;
      employeeSignatureData?: string | null;
      placeholderOverrides?: Record<string, string>;
    }) => {
      const result = await api.post(`/customers/${customerId}/documents/generate-pdf`, data);
      return unwrapResult(result) as GenerateResult;
    },
    onSuccess: (result) => {
      setGeneratedDoc(result);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["customers", customerId, "documents"] });
      queryClient.invalidateQueries({ queryKey: ["customers", customerId, "generated-documents"] });
      toast({ title: "Dokument erstellt", description: "Das PDF wurde erfolgreich generiert und gespeichert." });
    },
    onError: (error: Error) => {
      setStep("preview");
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleSelectNext = useCallback(() => {
    if (!selectedTemplate) return;
    if (hasInputFields) {
      const initial: Record<string, string> = {};
      selectedTemplate.inputFields.forEach(f => { initial[f.key] = inputValues[f.key] || ""; });
      setInputValues(initial);
      setStep("fill-inputs");
    } else {
      handleRenderPreview({});
    }
  }, [selectedTemplate, hasInputFields, inputValues]);

  const handleRenderPreview = useCallback(async (overrides: Record<string, string>) => {
    if (!selectedTemplate) return;
    setIsRendering(true);
    try {
      const result = await api.post(`/customers/${customerId}/document-templates/render`, {
        templateSlug: selectedTemplate.slug,
        overrides,
      });
      const data = unwrapResult(result) as RenderResult;
      setRenderedHtml(data.html);
      setStep("preview");
    } catch (error: any) {
      toast({ title: "Vorschau-Fehler", description: error.message || "Vorlage konnte nicht gerendert werden", variant: "destructive" });
    } finally {
      setIsRendering(false);
    }
  }, [selectedTemplate, customerId, toast]);

  const handleInputsNext = useCallback(() => {
    handleRenderPreview(inputValues);
  }, [inputValues, handleRenderPreview]);

  const handleNextFromPreview = useCallback(() => {
    if (!selectedTemplate) return;
    if (selectedTemplate.requiresCustomerSignature) {
      setStep("sign-customer");
    } else if (selectedTemplate.requiresEmployeeSignature) {
      setStep("sign-employee");
    } else {
      handleGenerate(null, null);
    }
  }, [selectedTemplate]);

  const handleCustomerSigned = useCallback((signatureData: string) => {
    setCustomerSignature(signatureData);
    if (selectedTemplate?.requiresEmployeeSignature) {
      setStep("sign-employee");
    } else {
      handleGenerate(signatureData, null);
    }
  }, [selectedTemplate]);

  const handleEmployeeSigned = useCallback((signatureData: string) => {
    setEmployeeSignature(signatureData);
    handleGenerate(customerSignature, signatureData);
  }, [customerSignature]);

  const handleGenerate = useCallback((custSig: string | null, empSig: string | null) => {
    if (!selectedTemplate) return;
    setStep("generating");
    generateMutation.mutate({
      templateId: selectedTemplate.id,
      customerSignatureData: custSig,
      employeeSignatureData: empSig,
      placeholderOverrides: inputValues,
    });
  }, [selectedTemplate, inputValues, generateMutation]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
    setTimeout(() => {
      setStep("select");
      setSelectedTemplateId("");
      setInputValues({});
      setRenderedHtml(null);
      setCustomerSignature(null);
      setEmployeeSignature(null);
      setGeneratedDoc(null);
    }, 300);
    if (generatedDoc) {
      onComplete?.();
    }
  }, [onOpenChange, generatedDoc, onComplete]);

  const handleBack = useCallback(() => {
    if (step === "fill-inputs") setStep("select");
    else if (step === "preview") setStep(hasInputFields ? "fill-inputs" : "select");
    else if (step === "sign-customer") setStep("preview");
    else if (step === "sign-employee") {
      if (selectedTemplate?.requiresCustomerSignature) {
        setStep("sign-customer");
        setCustomerSignature(null);
      } else {
        setStep("preview");
      }
    }
  }, [step, hasInputFields, selectedTemplate]);

  const stepTitle = (() => {
    switch (step) {
      case "select": return "Vorlage auswählen";
      case "fill-inputs": return "Angaben ausfüllen";
      case "preview": return "Dokumentenvorschau";
      case "sign-customer": return "Kundenunterschrift";
      case "sign-employee": return "Mitarbeiterunterschrift";
      case "generating": return "PDF wird erstellt...";
      case "done": return "Dokument erstellt";
    }
  })();

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className={iconSize.sm} />
            {stepTitle}
          </DialogTitle>
        </DialogHeader>

        {step === "select" && (
          <div className="space-y-4 mt-2">
            <p className="text-sm text-gray-600">
              Wählen Sie eine Vorlage, um ein Dokument für <strong>{customerName}</strong> zu erstellen.
            </p>

            {templatesLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
              </div>
            ) : templates && templates.length > 0 ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Dokumentenvorlage</Label>
                  <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                    <SelectTrigger data-testid="select-digital-template">
                      <SelectValue placeholder="Vorlage auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map(t => (
                        <SelectItem key={t.id} value={t.id.toString()}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedTemplate && (
                  <div className="p-3 bg-gray-50 rounded-lg space-y-2">
                    {selectedTemplate.description && (
                      <p className="text-sm text-gray-600">{selectedTemplate.description}</p>
                    )}
                    <div className="flex flex-wrap gap-2 text-xs">
                      {selectedTemplate.inputFields.length > 0 && (
                        <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 inline-flex items-center gap-1">
                          <ClipboardEdit className="h-3 w-3" />
                          {selectedTemplate.inputFields.length} Eingabefeld{selectedTemplate.inputFields.length !== 1 ? "er" : ""}
                        </span>
                      )}
                      {selectedTemplate.requiresCustomerSignature && (
                        <span className="px-2 py-0.5 rounded bg-teal-50 text-teal-700 inline-flex items-center gap-1">
                          <Pen className="h-3 w-3" />
                          Kundenunterschrift
                        </span>
                      )}
                      {selectedTemplate.requiresEmployeeSignature && (
                        <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 inline-flex items-center gap-1">
                          <Pen className="h-3 w-3" />
                          Mitarbeiterunterschrift
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={handleClose} data-testid="button-cancel-digital-flow">
                    Abbrechen
                  </Button>
                  <Button
                    onClick={handleSelectNext}
                    disabled={!selectedTemplateId || isRendering}
                    data-testid="button-next-from-select"
                  >
                    {isRendering ? (
                      <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Wird geladen...</>
                    ) : hasInputFields ? (
                      <><ClipboardEdit className={`${iconSize.sm} mr-2`} />Weiter zu Angaben</>
                    ) : (
                      <><Eye className={`${iconSize.sm} mr-2`} />Vorschau anzeigen</>
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>Keine Vorlagen verfügbar.</p>
                <p className="text-xs mt-1">Der Administrator muss Vorlagen im Verwaltungsbereich anlegen.</p>
              </div>
            )}
          </div>
        )}

        {step === "fill-inputs" && selectedTemplate && (
          <div className="space-y-4 mt-2">
            <p className="text-sm text-gray-600">
              Bitte füllen Sie die folgenden Angaben für das Dokument aus.
            </p>

            <div className="space-y-3">
              {selectedTemplate.inputFields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={field.key}>{field.label}</Label>
                  <Input
                    id={field.key}
                    value={inputValues[field.key] || ""}
                    onChange={(e) => setInputValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.label}
                    className="text-base"
                    data-testid={`input-field-${field.key}`}
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 pt-2">
              <Button variant="outline" onClick={handleBack} data-testid="button-back-from-inputs">
                <ArrowLeft className={`${iconSize.sm} mr-1`} />
                Zurück
              </Button>
              <Button
                onClick={handleInputsNext}
                disabled={isRendering}
                data-testid="button-preview-from-inputs"
              >
                {isRendering ? (
                  <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Wird geladen...</>
                ) : (
                  <><Eye className={`${iconSize.sm} mr-2`} />Vorschau anzeigen</>
                )}
              </Button>
            </div>
          </div>
        )}

        {step === "preview" && renderedHtml && (
          <div className="space-y-4 mt-2">
            <div className="border rounded-lg p-4 sm:p-6 bg-white max-h-[50vh] overflow-y-auto">
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderedHtml, { ALLOWED_TAGS: ['html','head','body','style','h1','h2','h3','h4','h5','h6','p','br','strong','em','ul','ol','li','table','tr','td','th','thead','tbody','tfoot','caption','colgroup','col','img','div','span','hr','b','i','u','a','header','footer','section','nav','main','article','aside','figure','figcaption','blockquote','pre','code','dl','dt','dd','meta','title','label','input'], ALLOWED_ATTR: ['class','style','src','alt','width','height','colspan','rowspan','href','id','lang','charset','name','content','type','for','value','placeholder','readonly'] }) }}
                data-testid="preview-rendered-document"
              />
            </div>

            <div className="flex items-center justify-between gap-2 pt-2">
              <Button variant="outline" onClick={handleBack} data-testid="button-back-from-preview">
                <ArrowLeft className={`${iconSize.sm} mr-1`} />
                Zurück
              </Button>
              <Button onClick={handleNextFromPreview} data-testid="button-proceed-from-preview">
                {selectedTemplate?.requiresCustomerSignature || selectedTemplate?.requiresEmployeeSignature ? (
                  <><Pen className={`${iconSize.sm} mr-2`} />Weiter zum Unterschreiben</>
                ) : (
                  <><Check className={`${iconSize.sm} mr-2`} />PDF erstellen</>
                )}
              </Button>
            </div>
          </div>
        )}

        {step === "sign-customer" && (
          <div className="space-y-4 mt-2">
            <p className="text-sm text-gray-600">
              Bitte lassen Sie den Kunden <strong>{customerName}</strong> hier unterschreiben.
            </p>
            <SignaturePad
              title="Kundenunterschrift"
              description={`Unterschrift von ${customerName}`}
              onSave={handleCustomerSigned}
              onCancel={handleBack}
            />
            <div className="flex justify-start">
              <Button variant="outline" size="sm" onClick={handleBack} data-testid="button-back-from-customer-sign">
                <ArrowLeft className={`${iconSize.sm} mr-1`} />
                Zurück
              </Button>
            </div>
          </div>
        )}

        {step === "sign-employee" && (
          <div className="space-y-4 mt-2">
            <p className="text-sm text-gray-600">
              Bitte unterschreiben Sie als Mitarbeiter.
            </p>
            {customerSignature && (
              <div className="p-2 bg-green-50 rounded-lg flex items-center gap-2 text-sm text-green-700">
                <Check className="h-4 w-4" />
                Kundenunterschrift erfasst
              </div>
            )}
            <SignaturePad
              title="Mitarbeiterunterschrift"
              description="Ihre Unterschrift"
              onSave={handleEmployeeSigned}
              onCancel={handleBack}
            />
            <div className="flex justify-start">
              <Button variant="outline" size="sm" onClick={handleBack} data-testid="button-back-from-employee-sign">
                <ArrowLeft className={`${iconSize.sm} mr-1`} />
                Zurück
              </Button>
            </div>
          </div>
        )}

        {step === "generating" && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            <p className="text-sm text-gray-600">PDF wird erstellt und gespeichert...</p>
            <p className="text-xs text-gray-400">Dies kann einen Moment dauern.</p>
          </div>
        )}

        {step === "done" && generatedDoc && (
          <div className="space-y-4 mt-2">
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-center space-y-3">
              <Check className="h-10 w-10 text-green-600 mx-auto" />
              <div>
                <p className="text-lg font-semibold text-green-800">Dokument erfolgreich erstellt</p>
                <p className="text-sm text-green-700 mt-1">{generatedDoc.fileName}</p>
              </div>
              {generatedDoc.integrityHash && (
                <p className="text-xs text-green-600 font-mono break-all">
                  SHA-256: {generatedDoc.integrityHash}
                </p>
              )}
            </div>

            <div className="flex justify-center gap-3">
              <a
                href={`/api/customers/generated-documents/${generatedDoc.id}/download`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" data-testid="button-download-generated-pdf">
                  <Download className={`${iconSize.sm} mr-2`} />
                  PDF herunterladen
                </Button>
              </a>
              <Button onClick={handleClose} data-testid="button-close-digital-flow">
                Fertig
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
