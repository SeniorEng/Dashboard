import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { iconSize } from "@/design-system";
import {
  Loader2,
  Upload,
  FileCheck2,
  ChevronDown,
  ChevronUp,
  FileText,
  Download,
  Camera,
  X,
  FilePlus2,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatDateDisplay } from "@shared/utils/format";
import { useUpload } from "@/hooks/use-upload";
import { DigitalDocumentFlow } from "./digital-document-flow";

interface DocumentTypeWithTemplate {
  id: number;
  name: string;
  description: string | null;
  targetType: string;
  context: string;
  reviewIntervalMonths: number | null;
  reminderLeadTimeDays: number | null;
  isActive: boolean;
  hasTemplate: boolean;
  templateName: string | null;
  templateSlug: string | null;
}

interface CustomerDocumentData {
  id: number;
  customerId: number;
  documentTypeId: number;
  fileName: string;
  objectPath: string;
  uploadedAt: string;
  reviewDueDate: string | null;
  isCurrent: boolean;
  notes: string | null;
  documentType: { id: number; name: string };
}

interface GeneratedDocumentData {
  id: number;
  customerId: number;
  templateId: number;
  documentTypeId: number | null;
  fileName: string;
  objectPath: string;
  integrityHash: string | null;
  signingStatus: string;
  generatedAt: string;
  template: { name: string; slug: string; documentTypeId: number | null };
}

function getReviewStatus(reviewDueDate: string | null): "ok" | "warning" | "overdue" | "none" {
  if (!reviewDueDate) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(reviewDueDate + "T00:00:00");
  const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "overdue";
  if (diffDays <= 30) return "warning";
  return "ok";
}

function ReviewBadge({ reviewDueDate }: { reviewDueDate: string | null }) {
  const status = getReviewStatus(reviewDueDate);
  if (status === "none") return null;

  const styles = {
    ok: "bg-green-100 text-green-700",
    warning: "bg-amber-100 text-amber-700",
    overdue: "bg-red-100 text-red-700",
  };

  const labels = {
    ok: `Prüfung bis ${formatDateDisplay(reviewDueDate!)}`,
    warning: `Prüfung fällig: ${formatDateDisplay(reviewDueDate!)}`,
    overdue: `Überfällig: ${formatDateDisplay(reviewDueDate!)}`,
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded inline-flex items-center gap-1 ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

interface DocTypeRow {
  docType: DocumentTypeWithTemplate;
  uploadedDoc: CustomerDocumentData | null;
  generatedDocs: GeneratedDocumentData[];
}

export function CustomerDocumentsSection({ customerId, customerName }: { customerId: number; customerName: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [uploadingForTypeId, setUploadingForTypeId] = useState<number | null>(null);
  const [digitalFlowForTypeSlug, setDigitalFlowForTypeSlug] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null);
  const [expandedType, setExpandedType] = useState<number | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [filePreviews, setFilePreviews] = useState<{ file: File; preview?: string }[]>([]);

  const { data: docTypes, isLoading: typesLoading } = useQuery<DocumentTypeWithTemplate[]>({
    queryKey: ["customers", "document-types", "customer", "bestandskunde"],
    queryFn: async () => {
      const result = await api.get<DocumentTypeWithTemplate[]>("/customers/document-types/customer?context=bestandskunde");
      return unwrapResult(result);
    },
  });

  const { data: documents, isLoading: docsLoading } = useQuery<CustomerDocumentData[]>({
    queryKey: ["customers", customerId, "documents"],
    queryFn: async () => {
      const result = await api.get<CustomerDocumentData[]>(`/customers/${customerId}/documents`);
      return unwrapResult(result);
    },
  });

  const { data: generatedDocs } = useQuery<GeneratedDocumentData[]>({
    queryKey: ["customers", customerId, "generated-documents"],
    queryFn: async () => {
      const result = await api.get<GeneratedDocumentData[]>(`/customers/${customerId}/generated-documents`);
      return unwrapResult(result);
    },
  });

  const { data: history, isLoading: historyLoading } = useQuery<CustomerDocumentData[]>({
    queryKey: ["customers", customerId, "documents", expandedHistory, "history"],
    queryFn: async () => {
      const result = await api.get<CustomerDocumentData[]>(`/customers/${customerId}/documents/${expandedHistory}/history`);
      return unwrapResult(result);
    },
    enabled: !!expandedHistory,
  });

  const rows: DocTypeRow[] = (docTypes || []).map(dt => {
    const uploadedDoc = documents?.find(d => d.documentTypeId === dt.id && d.isCurrent) || null;
    const genDocs = (generatedDocs || []).filter(gd => {
      if (gd.documentTypeId === dt.id) return true;
      if (gd.template?.documentTypeId === dt.id) return true;
      return false;
    });
    return { docType: dt, uploadedDoc, generatedDocs: genDocs };
  });

  const orphanGeneratedDocs = (generatedDocs || []).filter(gd => {
    const matchesAnyType = (docTypes || []).some(dt =>
      gd.documentTypeId === dt.id || gd.template?.documentTypeId === dt.id
    );
    return !matchesAnyType;
  });

  const addFiles = useCallback((newFiles: File[]) => {
    setSelectedFiles(prev => [...prev, ...newFiles]);
    const newPreviews = newFiles.map(file => ({
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setFilePreviews(prev => [...prev, ...newPreviews]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setFilePreviews(prev => {
      const removed = prev[index];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const clearAllFiles = useCallback(() => {
    filePreviews.forEach(p => { if (p.preview) URL.revokeObjectURL(p.preview); });
    setFilePreviews([]);
    setSelectedFiles([]);
  }, [filePreviews]);

  const handleCameraCapture = useCallback(() => {
    cameraInputRef.current?.click();
  }, []);

  const onCameraFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) addFiles(files);
    e.target.value = "";
  }, [addFiles]);

  const { uploadFile, isUploading } = useUpload({
    onError: (error) => {
      toast({ title: "Upload-Fehler", description: error.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: { documentTypeId: number; fileName: string; objectPath: string; notes?: string | null }) => {
      const result = await api.post(`/customers/${customerId}/documents`, data);
      return unwrapResult(result);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleUpload = useCallback(async () => {
    if (selectedFiles.length === 0 || uploadingForTypeId === null) return;

    for (const file of selectedFiles) {
      const uploadResult = await uploadFile(file);
      if (!uploadResult) return;

      await saveMutation.mutateAsync({
        documentTypeId: uploadingForTypeId,
        fileName: file.name,
        objectPath: uploadResult.objectPath,
        notes: notes || null,
      });
    }

    queryClient.invalidateQueries({ queryKey: ["customers", customerId, "documents"] });
    const count = selectedFiles.length;
    setUploadingForTypeId(null);
    setNotes("");
    clearAllFiles();
    toast({ title: count > 1 ? `${count} Dokumente hinzugefügt` : "Dokument hinzugefügt" });
  }, [selectedFiles, uploadingForTypeId, notes, uploadFile, saveMutation, queryClient, customerId, toast, clearAllFiles]);

  const isSubmitting = isUploading || saveMutation.isPending;
  const loading = typesLoading || docsLoading;

  const openUploadForType = (typeId: number) => {
    clearAllFiles();
    setNotes("");
    setUploadingForTypeId(typeId);
    setExpandedType(typeId);
  };

  const openDigitalFlowForType = (slug: string) => {
    setDigitalFlowForTypeSlug(slug);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <FileCheck2 className={iconSize.sm} />
          Dokumente
        </h3>
      </div>

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onCameraFileChange}
        className="hidden"
        data-testid="input-camera-capture"
      />

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500 py-4 text-center">Keine Dokumententypen für Kunden konfiguriert</p>
      ) : (
        <div className="space-y-2">
          {rows.map(({ docType, uploadedDoc, generatedDocs: genDocs }) => {
            const hasAnyDoc = !!uploadedDoc || genDocs.length > 0;
            const isExpanded = expandedType === docType.id;
            const isUploadingHere = uploadingForTypeId === docType.id;
            const latestGenDoc = genDocs[0];
            const reviewStatus = uploadedDoc ? getReviewStatus(uploadedDoc.reviewDueDate) : "none";
            const borderClass = reviewStatus === "overdue" ? "border-red-200" : reviewStatus === "warning" ? "border-amber-200" : hasAnyDoc ? "border-green-100" : "border-gray-200 border-dashed";

            return (
              <div key={docType.id} className={`border rounded-lg bg-white ${borderClass}`} data-testid={`doctype-row-${docType.id}`}>
                <div
                  className="p-3 cursor-pointer"
                  onClick={() => setExpandedType(isExpanded ? null : docType.id)}
                  data-testid={`doctype-toggle-${docType.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {hasAnyDoc ? (
                          <CheckCircle2 className={`${iconSize.sm} text-green-500 shrink-0`} />
                        ) : (
                          <AlertCircle className={`${iconSize.sm} text-gray-300 shrink-0`} />
                        )}
                        <span className="text-sm font-medium text-gray-900">{docType.name}</span>
                      </div>
                      <div className="ml-6 flex flex-wrap items-center gap-2">
                        {hasAnyDoc ? (
                          <>
                            {uploadedDoc && (
                              <span className="text-xs text-gray-500">
                                Upload: {formatDateDisplay(uploadedDoc.uploadedAt.split("T")[0])}
                              </span>
                            )}
                            {latestGenDoc && (
                              <span className={`text-xs px-1.5 py-0.5 rounded ${
                                latestGenDoc.signingStatus === "complete" ? "bg-green-100 text-green-700" :
                                "bg-amber-100 text-amber-700"
                              }`}>
                                {latestGenDoc.signingStatus === "complete" ? "Digital unterschrieben" : "Unterschrift ausstehend"}
                              </span>
                            )}
                            {uploadedDoc && <ReviewBadge reviewDueDate={uploadedDoc.reviewDueDate} />}
                          </>
                        ) : (
                          <span className="text-xs text-gray-400">Noch nicht vorhanden</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isExpanded ? (
                        <ChevronUp className={`${iconSize.sm} text-gray-400`} />
                      ) : (
                        <ChevronDown className={`${iconSize.sm} text-gray-400`} />
                      )}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3 border-t border-gray-100">
                    <div className="flex flex-wrap gap-2 mt-3 mb-3">
                      {docType.hasTemplate && docType.templateSlug && (
                        <Button
                          variant="default"
                          size="sm"
                          className="bg-teal-600 hover:bg-teal-700"
                          onClick={(e) => { e.stopPropagation(); openDigitalFlowForType(docType.templateSlug!); }}
                          data-testid={`button-digital-create-${docType.id}`}
                        >
                          <FilePlus2 className={`${iconSize.sm} mr-1`} />
                          Digital erstellen
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); openUploadForType(docType.id); }}
                        data-testid={`button-upload-for-type-${docType.id}`}
                      >
                        <Upload className={`${iconSize.sm} mr-1`} />
                        Hochladen
                      </Button>
                    </div>

                    {isUploadingHere && (
                      <div className="mb-3 p-3 bg-gray-50 rounded-lg space-y-3">
                        <div className="space-y-2">
                          <Label>Dateien auswählen oder Foto aufnehmen *</Label>
                          <div className="flex gap-2">
                            <label className="flex-1 cursor-pointer">
                              <input
                                type="file"
                                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                                multiple
                                onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ""; }}
                                className="hidden"
                                data-testid={`input-file-for-type-${docType.id}`}
                              />
                              <div className="flex items-center justify-center gap-2 h-10 px-3 rounded-md border border-gray-200 bg-white text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100 transition-colors">
                                <Upload className="h-4 w-4" />
                                Dateien wählen
                              </div>
                            </label>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={handleCameraCapture}
                              className="flex items-center gap-2"
                              data-testid={`button-camera-for-type-${docType.id}`}
                            >
                              <Camera className="h-4 w-4" />
                              Foto
                            </Button>
                          </div>
                          <p className="text-[11px] text-gray-400">PDF, Bild oder Word-Dokument (max. 10 MB). Mehrere Dateien möglich.</p>

                          {filePreviews.length > 0 && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <p className="text-xs text-teal-600 font-medium">
                                  {filePreviews.length} {filePreviews.length === 1 ? "Datei" : "Dateien"} ausgewählt
                                </p>
                                <button
                                  type="button"
                                  onClick={clearAllFiles}
                                  className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                                  data-testid={`button-clear-files-${docType.id}`}
                                >
                                  Alle entfernen
                                </button>
                              </div>
                              <div className="grid grid-cols-3 gap-2">
                                {filePreviews.map((item, idx) => (
                                  <div key={idx} className="relative group rounded-lg border border-gray-200 overflow-hidden bg-gray-50">
                                    {item.preview ? (
                                      <img src={item.preview} alt={item.file.name} className="w-full h-20 object-cover" />
                                    ) : (
                                      <div className="w-full h-20 flex flex-col items-center justify-center gap-1">
                                        <FileText className="h-5 w-5 text-gray-400" />
                                        <span className="text-[10px] text-gray-500 px-1 truncate max-w-full">{item.file.name.split('.').pop()?.toUpperCase()}</span>
                                      </div>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => removeFile(idx)}
                                      className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/50 flex items-center justify-center sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                                      data-testid={`button-remove-file-${idx}`}
                                    >
                                      <X className="h-3 w-3 text-white" />
                                    </button>
                                    <p className="text-[10px] text-gray-500 p-1 truncate">{item.file.name}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label>Notiz (optional)</Label>
                          <Input
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="z.B. Gültig bis 2026"
                            className="text-base"
                            data-testid={`input-notes-for-type-${docType.id}`}
                          />
                        </div>

                        <div className="flex gap-2">
                          <Button
                            onClick={handleUpload}
                            disabled={isSubmitting || selectedFiles.length === 0}
                            data-testid={`button-submit-upload-${docType.id}`}
                          >
                            {isSubmitting ? (
                              <><Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />Wird hinzugefügt...</>
                            ) : selectedFiles.length > 1 ? `${selectedFiles.length} Dateien hinzufügen` : "Hinzufügen"}
                          </Button>
                          <Button variant="outline" onClick={() => { setUploadingForTypeId(null); clearAllFiles(); }}>
                            Abbrechen
                          </Button>
                        </div>
                      </div>
                    )}

                    {uploadedDoc && (
                      <div className="p-2 bg-gray-50 rounded-lg mb-2" data-testid={`uploaded-doc-${uploadedDoc.id}`}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <Upload className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                            <span className="text-xs text-gray-700 truncate">{uploadedDoc.fileName}</span>
                            <span className="text-xs text-gray-400 shrink-0">
                              {formatDateDisplay(uploadedDoc.uploadedAt.split("T")[0])}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <a
                              href={uploadedDoc.objectPath}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-gray-200"
                              data-testid={`button-download-doc-${uploadedDoc.id}`}
                            >
                              <Download className="h-3.5 w-3.5 text-gray-600" />
                            </a>
                            {docType.reviewIntervalMonths && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedHistory(expandedHistory === docType.id ? null : docType.id);
                                }}
                                data-testid={`button-history-${docType.id}`}
                              >
                                <Clock className="h-3.5 w-3.5 text-gray-400" />
                              </Button>
                            )}
                          </div>
                        </div>
                        {uploadedDoc.notes && <p className="text-xs text-gray-500 italic mt-1 ml-5">{uploadedDoc.notes}</p>}

                        {expandedHistory === docType.id && (
                          <div className="mt-2 pt-2 border-t border-gray-200 ml-5">
                            <p className="text-xs font-medium text-gray-500 mb-1">Historie</p>
                            {historyLoading ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" />
                            ) : history && history.length > 1 ? (
                              <div className="space-y-1">
                                {history.filter(h => !h.isCurrent).map(h => (
                                  <div key={h.id} className="flex items-center justify-between text-xs text-gray-500 p-1 bg-white rounded">
                                    <span className="truncate flex-1">{h.fileName}</span>
                                    <span className="shrink-0 ml-2">{formatDateDisplay(h.uploadedAt.split("T")[0])}</span>
                                    <a href={h.objectPath} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0">
                                      <Download className="h-3 w-3 text-gray-400 hover:text-gray-600" />
                                    </a>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-gray-400">Keine älteren Versionen</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {genDocs.length > 0 && (
                      <div className="space-y-1">
                        {genDocs.map(gd => (
                          <div key={gd.id} className="p-2 bg-gray-50 rounded-lg flex items-center justify-between gap-2" data-testid={`generated-doc-${gd.id}`}>
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <FilePlus2 className="h-3.5 w-3.5 text-teal-500 shrink-0" />
                              <span className="text-xs text-gray-700 truncate">{gd.fileName}</span>
                              <span className="text-xs text-gray-400 shrink-0">
                                {formatDateDisplay(gd.generatedAt.split("T")[0])}
                              </span>
                              <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                                gd.signingStatus === "complete" ? "bg-green-100 text-green-700" :
                                "bg-amber-100 text-amber-700"
                              }`}>
                                {gd.signingStatus === "complete" ? "Unterschrieben" : "Ausstehend"}
                              </span>
                            </div>
                            <a
                              href={`/api/customers/generated-documents/${gd.id}/download`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-gray-200 shrink-0"
                              data-testid={`button-download-generated-${gd.id}`}
                            >
                              <Download className="h-3.5 w-3.5 text-gray-600" />
                            </a>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {orphanGeneratedDocs.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <FilePlus2 className="h-3.5 w-3.5" />
            Weitere digitale Dokumente
          </h4>
          <div className="space-y-1">
            {orphanGeneratedDocs.map(gd => (
              <div key={gd.id} className="p-3 bg-white border border-gray-100 rounded-lg flex items-start justify-between gap-2" data-testid={`orphan-generated-doc-${gd.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className={`${iconSize.sm} text-teal-500 shrink-0`} />
                    <span className="text-sm font-medium text-gray-900 truncate">{gd.fileName}</span>
                  </div>
                  <div className="ml-6 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-400">
                      {formatDateDisplay(gd.generatedAt.split("T")[0])}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      gd.signingStatus === "complete" ? "bg-green-100 text-green-700" :
                      "bg-amber-100 text-amber-700"
                    }`}>
                      {gd.signingStatus === "complete" ? "Unterschrieben" : "Ausstehend"}
                    </span>
                  </div>
                </div>
                <a
                  href={`/api/customers/generated-documents/${gd.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-gray-100 shrink-0"
                  data-testid={`button-download-orphan-${gd.id}`}
                >
                  <Download className={`${iconSize.sm} text-gray-600`} />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      <DigitalDocumentFlow
        open={!!digitalFlowForTypeSlug}
        onOpenChange={(open) => { if (!open) setDigitalFlowForTypeSlug(null); }}
        customerId={customerId}
        customerName={customerName}
        preselectedTemplateSlug={digitalFlowForTypeSlug || undefined}
      />
    </div>
  );
}
