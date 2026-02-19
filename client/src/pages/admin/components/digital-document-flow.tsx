import { useState, useCallback } from "react";
import DOMPurify from "dompurify";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
  ArrowRight,
  Check,
  Eye,
  Pen,
  Download,
  Link2,
  Copy,
  Send,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";
import { SignaturePad } from "@/components/ui/signature-pad";

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

type FlowStep = "select" | "preview" | "sign-customer" | "sign-employee" | "choose-signing-method" | "generating" | "done";

interface DigitalDocumentFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId?: number;
  employeeId?: number;
  targetName: string;
  targetType?: "customer" | "employee";
  context?: "vertragsabschluss" | "bestandskunde";
  onComplete?: () => void;
}

export function DigitalDocumentFlow({
  open,
  onOpenChange,
  customerId,
  employeeId,
  targetName,
  targetType = "customer",
  context = "bestandskunde",
  onComplete,
}: DigitalDocumentFlowProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<FlowStep>("select");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [renderedHtml, setRenderedHtml] = useState<string | null>(null);
  const [customerSignature, setCustomerSignature] = useState<string | null>(null);
  const [employeeSignature, setEmployeeSignature] = useState<string | null>(null);
  const [generatedDoc, setGeneratedDoc] = useState<GenerateResult | null>(null);
  const [isRendering, setIsRendering] = useState(false);

  const { data: templates, isLoading: templatesLoading } = useQuery<TemplateOption[]>({
    queryKey: ["admin", "document-templates", "by-context", context, targetType],
    queryFn: async () => {
      const res = await fetch(`/api/admin/document-templates/by-context?context=${context}&targetType=${targetType}`, { credentials: "include" });
      if (!res.ok) throw new Error("Vorlagen konnten nicht geladen werden");
      return res.json();
    },
    enabled: open,
  });

  const selectedTemplate = templates?.find(t => t.id.toString() === selectedTemplateId);

  const generateMutation = useMutation({
    mutationFn: async (data: {
      templateId: number;
      customerId?: number | null;
      employeeId?: number | null;
      customerSignatureData?: string | null;
      employeeSignatureData?: string | null;
      deferEmployeeSignature?: boolean;
    }) => {
      const result = await api.post("/admin/documents/generate-pdf", data);
      return unwrapResult(result) as GenerateResult;
    },
    onSuccess: (result) => {
      setGeneratedDoc(result);
      setStep("done");
      if (customerId) {
        queryClient.invalidateQueries({ queryKey: ["admin", "customers", customerId, "documents"] });
        queryClient.invalidateQueries({ queryKey: ["admin", "customers", customerId, "generated-documents"] });
      }
      if (employeeId) {
        queryClient.invalidateQueries({ queryKey: ["admin", "employees", employeeId, "documents"] });
        queryClient.invalidateQueries({ queryKey: ["admin", "employees", employeeId, "generated-documents"] });
      }
      const msg = result.signingLink
        ? "Das PDF wurde erstellt. Ein Unterschrifts-Link wurde generiert."
        : "Das PDF wurde erfolgreich generiert und gespeichert.";
      toast({ title: "Dokument erstellt", description: msg });
    },
    onError: (error: Error) => {
      setStep("preview");
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleRenderPreview = useCallback(async () => {
    if (!selectedTemplate) return;
    setIsRendering(true);
    try {
      const renderData: Record<string, any> = {
        templateSlug: selectedTemplate.slug,
        customerId: customerId || 0,
      };
      if (employeeId && !customerId) {
        renderData.overrides = { customer_name: targetName };
      }
      const result = await api.post("/admin/document-templates/render", renderData);
      const data = unwrapResult(result) as RenderResult;
      setRenderedHtml(data.html);
      setStep("preview");
    } catch (error: any) {
      toast({ title: "Vorschau-Fehler", description: error.message || "Vorlage konnte nicht gerendert werden", variant: "destructive" });
    } finally {
      setIsRendering(false);
    }
  }, [selectedTemplate, customerId, employeeId, targetName, toast]);

  const handleNextFromPreview = useCallback(() => {
    if (!selectedTemplate) return;
    if (selectedTemplate.requiresCustomerSignature) {
      setStep("sign-customer");
    } else if (selectedTemplate.requiresEmployeeSignature) {
      if (targetType === "employee" && employeeId) {
        setStep("choose-signing-method");
      } else {
        setStep("sign-employee");
      }
    } else {
      handleGenerate();
    }
  }, [selectedTemplate, targetType, employeeId]);

  const handleCustomerSigned = useCallback((signatureData: string) => {
    setCustomerSignature(signatureData);
    if (selectedTemplate?.requiresEmployeeSignature) {
      if (targetType === "employee" && employeeId) {
        setStep("choose-signing-method");
      } else {
        setStep("sign-employee");
      }
    } else {
      handleGenerateWithSignatures(signatureData, null, false);
    }
  }, [selectedTemplate, targetType, employeeId]);

  const handleEmployeeSigned = useCallback((signatureData: string) => {
    setEmployeeSignature(signatureData);
    handleGenerateWithSignatures(customerSignature, signatureData, false);
  }, [customerSignature]);

  const handleSendSigningLink = useCallback(() => {
    if (!selectedTemplate) return;
    setStep("generating");
    generateMutation.mutate({
      templateId: selectedTemplate.id,
      customerId: customerId || null,
      employeeId: employeeId || null,
      customerSignatureData: customerSignature,
      employeeSignatureData: null,
      deferEmployeeSignature: true,
    });
  }, [selectedTemplate, customerId, employeeId, customerSignature, generateMutation]);

  const handleGenerate = useCallback(() => {
    if (!selectedTemplate) return;
    setStep("generating");
    generateMutation.mutate({
      templateId: selectedTemplate.id,
      customerId: customerId || null,
      employeeId: employeeId || null,
      customerSignatureData: customerSignature,
      employeeSignatureData: employeeSignature,
    });
  }, [selectedTemplate, customerId, employeeId, customerSignature, employeeSignature, generateMutation]);

  const handleGenerateWithSignatures = useCallback((custSig: string | null, empSig: string | null, defer: boolean) => {
    if (!selectedTemplate) return;
    setStep("generating");
    generateMutation.mutate({
      templateId: selectedTemplate.id,
      customerId: customerId || null,
      employeeId: employeeId || null,
      customerSignatureData: custSig,
      employeeSignatureData: defer ? null : empSig,
      deferEmployeeSignature: defer,
    });
  }, [selectedTemplate, customerId, employeeId, generateMutation]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
    setTimeout(() => {
      setStep("select");
      setSelectedTemplateId("");
      setRenderedHtml(null);
      setCustomerSignature(null);
      setEmployeeSignature(null);
      setGeneratedDoc(null);
    }, 300);
    if (generatedDoc) {
      onComplete?.();
    }
  }, [onOpenChange, generatedDoc, onComplete]);

  const handleCopyLink = useCallback(async () => {
    if (generatedDoc?.signingLink) {
      await navigator.clipboard.writeText(generatedDoc.signingLink);
      toast({ title: "Link kopiert", description: "Der Unterschrifts-Link wurde in die Zwischenablage kopiert." });
    }
  }, [generatedDoc, toast]);

  const handleBack = useCallback(() => {
    if (step === "preview") setStep("select");
    else if (step === "sign-customer") setStep("preview");
    else if (step === "choose-signing-method") {
      if (selectedTemplate?.requiresCustomerSignature) {
        setStep("sign-customer");
        setCustomerSignature(null);
      } else {
        setStep("preview");
      }
    }
    else if (step === "sign-employee") {
      if (targetType === "employee" && employeeId) {
        setStep("choose-signing-method");
      } else if (selectedTemplate?.requiresCustomerSignature) {
        setStep("sign-customer");
        setCustomerSignature(null);
      } else {
        setStep("preview");
      }
    }
  }, [step, selectedTemplate, targetType, employeeId]);

  const stepTitle = (() => {
    switch (step) {
      case "select": return "Vorlage auswählen";
      case "preview": return "Dokumentenvorschau";
      case "sign-customer": return targetType === "employee" ? "Arbeitgeber-Unterschrift" : "Kundenunterschrift";
      case "sign-employee": return "Mitarbeiterunterschrift";
      case "choose-signing-method": return "Mitarbeiter-Unterschrift";
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
              Wählen Sie eine Vorlage, um ein digitales Dokument für <strong>{targetName}</strong> zu erstellen.
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
                      <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                        Version {selectedTemplate.version}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={handleClose} data-testid="button-cancel-digital-flow">
                    Abbrechen
                  </Button>
                  <Button
                    onClick={handleRenderPreview}
                    disabled={!selectedTemplateId || isRendering}
                    data-testid="button-preview-template"
                  >
                    {isRendering ? (
                      <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Wird geladen...</>
                    ) : (
                      <><Eye className={`${iconSize.sm} mr-2`} />Vorschau anzeigen</>
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>Keine Vorlagen für diesen Kontext verfügbar.</p>
                <p className="text-xs mt-1">Erstellen Sie Vorlagen im Admin-Bereich unter Vertragsvorlagen.</p>
              </div>
            )}
          </div>
        )}

        {step === "preview" && renderedHtml && (
          <div className="space-y-4 mt-2">
            <div className="border rounded-lg p-4 sm:p-6 bg-white max-h-[50vh] overflow-y-auto">
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderedHtml, { ALLOWED_TAGS: ['h1','h2','h3','h4','p','br','strong','em','ul','ol','li','table','tr','td','th','thead','tbody','img','div','span','hr','b','i','u','a'], ALLOWED_ATTR: ['class','style','src','alt','width','height','colspan','rowspan','href'] }) }}
                data-testid="preview-rendered-document"
              />
            </div>

            <div className="flex items-center justify-between gap-2 pt-2">
              <Button variant="outline" onClick={handleBack} data-testid="button-back-to-select">
                <ArrowLeft className={`${iconSize.sm} mr-1`} />
                Zurück
              </Button>
              <Button onClick={handleNextFromPreview} data-testid="button-proceed-to-sign">
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
              {targetType === "customer"
                ? <>Bitte lassen Sie den Kunden <strong>{targetName}</strong> hier unterschreiben.</>
                : <>Bitte unterschreiben Sie, <strong>{targetName}</strong>.</>
              }
            </p>
            <SignaturePad
              title={targetType === "customer" ? "Kundenunterschrift" : "Unterschrift"}
              description={`Unterschrift von ${targetName}`}
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

        {step === "choose-signing-method" && (
          <div className="space-y-4 mt-2">
            {customerSignature && (
              <div className="p-2 bg-green-50 rounded-lg flex items-center gap-2 text-sm text-green-700">
                <Check className="h-4 w-4" />
                Arbeitgeber-Unterschrift erfasst
              </div>
            )}
            <p className="text-sm text-gray-600">
              Wie soll <strong>{targetName}</strong> das Dokument unterschreiben?
            </p>

            <div className="grid gap-3">
              <button
                onClick={() => setStep("sign-employee")}
                className="p-4 border-2 border-gray-200 rounded-lg hover:border-teal-400 hover:bg-teal-50/50 transition-colors text-left group"
                data-testid="button-sign-now"
              >
                <div className="flex items-start gap-3">
                  <Pen className="h-5 w-5 text-teal-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-gray-900">Jetzt vor Ort unterschreiben</p>
                    <p className="text-sm text-gray-500 mt-0.5">Der Mitarbeiter unterschreibt jetzt auf diesem Gerät</p>
                  </div>
                </div>
              </button>

              <button
                onClick={handleSendSigningLink}
                className="p-4 border-2 border-gray-200 rounded-lg hover:border-blue-400 hover:bg-blue-50/50 transition-colors text-left group"
                data-testid="button-send-signing-link"
              >
                <div className="flex items-start gap-3">
                  <Send className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-gray-900">Unterschrifts-Link senden</p>
                    <p className="text-sm text-gray-500 mt-0.5">Ein Link wird erstellt, den Sie dem Mitarbeiter per E-Mail oder WhatsApp schicken können. Der Link ist 7 Tage gültig.</p>
                  </div>
                </div>
              </button>
            </div>

            <div className="flex justify-start pt-2">
              <Button variant="outline" size="sm" onClick={handleBack} data-testid="button-back-from-choose-method">
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
                {targetType === "employee" ? "Arbeitgeber-Unterschrift erfasst" : "Kundenunterschrift erfasst"}
              </div>
            )}
            <SignaturePad
              title="Mitarbeiterunterschrift"
              description={`Unterschrift von ${targetName}`}
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
            {generatedDoc.signingLink ? (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-center space-y-3">
                <Link2 className="h-10 w-10 text-blue-600 mx-auto" />
                <div>
                  <p className="text-lg font-semibold text-blue-800">Unterschrifts-Link erstellt</p>
                  <p className="text-sm text-blue-700 mt-1">
                    Das Dokument <strong>{generatedDoc.fileName}</strong> wartet auf die Unterschrift des Mitarbeiters.
                  </p>
                </div>
                <div className="mt-3 p-3 bg-white rounded-lg border border-blue-100">
                  <p className="text-xs text-gray-500 mb-2">Senden Sie diesen Link an den Mitarbeiter:</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={generatedDoc.signingLink}
                      className="flex-1 text-xs font-mono bg-gray-50 border rounded px-2 py-1.5 text-gray-700"
                      data-testid="input-signing-link"
                    />
                    <Button size="sm" variant="outline" onClick={handleCopyLink} data-testid="button-copy-signing-link">
                      <Copy className="h-3.5 w-3.5 mr-1" />
                      Kopieren
                    </Button>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">Der Link ist 7 Tage gültig und kann nur einmal verwendet werden.</p>
                </div>
              </div>
            ) : (
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
            )}

            <div className="flex justify-center gap-3">
              <a
                href={`/api/admin/generated-documents/${generatedDoc.id}/download`}
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
