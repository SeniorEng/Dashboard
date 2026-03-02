import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/patterns/status-badge";
import { iconSize } from "@/design-system";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { useUpload } from "@/hooks/use-upload";
import { ReviewBadge, getReviewStatus } from "./review-badge";
import { DigitalDocumentFlow } from "./digital-document-flow";
import { Pen } from "lucide-react";

interface DocumentTypeData {
  id: number;
  name: string;
  description: string | null;
  targetType: string;
  reviewIntervalMonths: number | null;
  reminderLeadTimeDays: number | null;
  isActive: boolean;
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
  documentType: DocumentTypeData;
}

interface GeneratedDocumentData {
  id: number;
  customerId: number | null;
  templateId: number;
  templateVersion: number;
  documentTypeId: number | null;
  fileName: string;
  objectPath: string;
  customerSignatureData: string | null;
  employeeSignatureData: string | null;
  signedAt: string | null;
  integrityHash: string | null;
  generatedAt: string;
}

export function CustomerDocumentsSection({ customerId, customerName }: { customerId: number; customerName: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isDigitalFlowOpen, setIsDigitalFlowOpen] = useState(false);
  const [selectedDocTypeId, setSelectedDocTypeId] = useState("");
  const [notes, setNotes] = useState("");
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [filePreviews, setFilePreviews] = useState<{ file: File; preview?: string }[]>([]);

  const { data: documents, isLoading: docsLoading } = useQuery<CustomerDocumentData[]>({
    queryKey: ["admin", "customers", customerId, "documents"],
    queryFn: async () => {
      const result = await api.get<CustomerDocumentData[]>(`/admin/customers/${customerId}/documents`);
      return unwrapResult(result);
    },
  });

  const { data: docTypes } = useQuery<DocumentTypeData[]>({
    queryKey: ["admin", "document-types", "customer"],
    queryFn: async () => {
      const result = await api.get<DocumentTypeData[]>("/admin/document-types?targetType=customer");
      return unwrapResult(result);
    },
  });

  const { data: generatedDocs } = useQuery<GeneratedDocumentData[]>({
    queryKey: ["admin", "customers", customerId, "generated-documents"],
    queryFn: async () => {
      const result = await api.get<GeneratedDocumentData[]>(`/admin/customers/${customerId}/generated-documents`);
      return unwrapResult(result);
    },
  });

  const { data: history, isLoading: historyLoading } = useQuery<CustomerDocumentData[]>({
    queryKey: ["admin", "customers", customerId, "documents", expandedHistory, "history"],
    queryFn: async () => {
      const result = await api.get<CustomerDocumentData[]>(`/admin/customers/${customerId}/documents/${expandedHistory}/history`);
      return unwrapResult(result);
    },
    enabled: !!expandedHistory,
  });

  const addFiles = useCallback((newFiles: File[]) => {
    setSelectedFiles(prev => [...prev, ...newFiles]);
    const newPreviews = newFiles.map(file => {
      const isImage = file.type.startsWith("image/");
      return {
        file,
        preview: isImage ? URL.createObjectURL(file) : undefined,
      };
    });
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
    mutationFn: async (data: { documentTypeId: number; fileName: string; objectPath: string; notes?: string | null; skipDeactivation?: boolean }) => {
      const result = await api.post(`/admin/customers/${customerId}/documents`, data);
      return unwrapResult(result);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleUpload = useCallback(async () => {
    if (selectedFiles.length === 0 || !selectedDocTypeId) return;

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const uploadResult = await uploadFile(file);
      if (!uploadResult) return;

      await saveMutation.mutateAsync({
        documentTypeId: parseInt(selectedDocTypeId),
        fileName: file.name,
        objectPath: uploadResult.objectPath,
        notes: notes || null,
        skipDeactivation: i > 0,
      });
    }

    queryClient.invalidateQueries({ queryKey: ["admin", "customers", customerId, "documents"] });
    const count = selectedFiles.length;
    setIsUploadOpen(false);
    setSelectedDocTypeId("");
    setNotes("");
    clearAllFiles();
    toast({ title: count > 1 ? `${count} Dokumente hinzugefügt` : "Dokument hinzugefügt" });
  }, [selectedFiles, selectedDocTypeId, notes, uploadFile, saveMutation, queryClient, customerId, toast, clearAllFiles]);

  const uploadedDocTypeIds = new Set(documents?.map(d => d.documentTypeId) || []);
  const availableDocTypes = (docTypes?.filter(dt => dt.isActive) || []).sort((a, b) => a.name.localeCompare(b.name, "de"));
  const missingDocTypes = availableDocTypes.filter(dt => !uploadedDocTypeIds.has(dt.id));

  const isSubmitting = isUploading || saveMutation.isPending;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <FileCheck2 className={iconSize.sm} />
          Dokumente
        </h3>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsDigitalFlowOpen(true)}
            data-testid="button-digital-document"
          >
            <Pen className={`${iconSize.sm} mr-1`} />
            <span className="hidden sm:inline">Digital erstellen</span>
            <span className="sm:hidden">Digital</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsUploadOpen(!isUploadOpen)}
            data-testid="button-upload-customer-document"
          >
            <Upload className={`${iconSize.sm} mr-1`} />
            <span className="hidden sm:inline">Hochladen</span>
            <span className="sm:hidden">Upload</span>
          </Button>
        </div>
      </div>

      {isUploadOpen && (
        <div className="mb-4 p-4 bg-gray-50 rounded-lg space-y-3">
          <div className="space-y-2">
            <Label>Dokumententyp *</Label>
            <Select value={selectedDocTypeId} onValueChange={setSelectedDocTypeId}>
              <SelectTrigger data-testid="select-customer-doc-type">
                <SelectValue placeholder="Typ auswählen..." />
              </SelectTrigger>
              <SelectContent>
                {availableDocTypes.map(dt => (
                  <SelectItem key={dt.id} value={dt.id.toString()}>
                    {dt.name}
                    {dt.reviewIntervalMonths ? ` (alle ${dt.reviewIntervalMonths} Mon.)` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
                  data-testid="input-customer-document-file"
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
                data-testid="button-camera-capture"
              >
                <Camera className="h-4 w-4" />
                Foto
              </Button>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onCameraFileChange}
                className="hidden"
                data-testid="input-camera-capture"
              />
            </div>
            <p className="text-[11px] text-gray-500">PDF, Bild oder Word-Dokument (max. 10 MB je Datei). Mehrere Fotos/Dateien möglich.</p>

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
                    data-testid="button-clear-all-files"
                  >
                    Alle entfernen
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {filePreviews.map((item, idx) => (
                    <div key={idx} className="relative group rounded-lg border border-gray-200 overflow-hidden bg-gray-50">
                      {item.preview ? (
                        <img
                          src={item.preview}
                          alt={item.file.name}
                          className="w-full h-20 object-cover"
                        />
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
              data-testid="input-customer-document-notes"
            />
          </div>

          <div className="flex gap-2">
            <Button
              onClick={handleUpload}
              disabled={isSubmitting || selectedFiles.length === 0 || !selectedDocTypeId}
              data-testid="button-submit-customer-document"
            >
              {isSubmitting ? (
                <><Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />Wird hinzugefügt...</>
              ) : selectedFiles.length > 1 ? `${selectedFiles.length} Dateien hinzufügen` : "Hinzufügen"}
            </Button>
            <Button variant="outline" onClick={() => { setIsUploadOpen(false); clearAllFiles(); }}>
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      {docsLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : documents && documents.length > 0 ? (
        <div className="space-y-2">
          {documents.map((doc) => {
            const status = getReviewStatus(doc.reviewDueDate);
            const borderClass = status === "overdue" ? "border-red-200" : status === "warning" ? "border-amber-200" : "border-gray-100";

            return (
              <div key={doc.id} className={`p-3 bg-white border rounded-lg ${borderClass}`} data-testid={`customer-doc-${doc.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <FileText className={`${iconSize.sm} text-gray-400 shrink-0`} />
                      <span className="text-sm font-medium text-gray-900 truncate">{doc.documentType.name}</span>
                    </div>
                    <div className="ml-6 space-y-1">
                      <p className="text-xs text-gray-500 truncate">{doc.fileName}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-gray-500">
                          Hochgeladen: {formatDateForDisplay(doc.uploadedAt.split("T")[0])}
                        </span>
                        <ReviewBadge reviewDueDate={doc.reviewDueDate} />
                      </div>
                      {doc.notes && <p className="text-xs text-gray-500 italic">{doc.notes}</p>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <a
                      href={doc.objectPath}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-gray-100"
                      data-testid={`button-download-customer-doc-${doc.id}`}
                    >
                      <Download className={`${iconSize.sm} text-gray-600`} />
                    </a>
                    {doc.documentType.reviewIntervalMonths && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => setExpandedHistory(expandedHistory === doc.documentTypeId ? null : doc.documentTypeId)}
                        data-testid={`button-customer-history-${doc.documentTypeId}`}
                      >
                        {expandedHistory === doc.documentTypeId ? (
                          <ChevronUp className={`${iconSize.sm} text-gray-600`} />
                        ) : (
                          <ChevronDown className={`${iconSize.sm} text-gray-600`} />
                        )}
                      </Button>
                    )}
                  </div>
                </div>

                {expandedHistory === doc.documentTypeId && (
                  <div className="mt-3 ml-6 pt-3 border-t border-gray-100">
                    <p className="text-xs font-medium text-gray-500 mb-2">Dokumentenhistorie</p>
                    {historyLoading ? (
                      <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
                    ) : history && history.length > 1 ? (
                      <div className="space-y-1.5">
                        {history.filter(h => !h.isCurrent).map(h => (
                          <div key={h.id} className="flex items-center justify-between text-xs text-gray-500 p-1.5 bg-gray-50 rounded">
                            <span className="truncate flex-1">{h.fileName}</span>
                            <span className="shrink-0 ml-2">{formatDateForDisplay(h.uploadedAt.split("T")[0])}</span>
                            <a
                              href={h.objectPath}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="ml-2 shrink-0"
                            >
                              <Download className="h-3 w-3 text-gray-400 hover:text-gray-600" />
                            </a>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">Keine älteren Versionen</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-gray-500 py-4 text-center">Noch keine Dokumente hochgeladen</p>
      )}

      {generatedDocs && generatedDocs.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Pen className="h-3 w-3" />
            Digital erstellte Dokumente
          </h4>
          <div className="space-y-2">
            {generatedDocs.map((doc) => (
              <div key={doc.id} className="p-3 bg-white border border-teal-100 rounded-lg" data-testid={`generated-doc-${doc.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <FileText className={`${iconSize.sm} text-teal-600 shrink-0`} />
                      <span className="text-sm font-medium text-gray-900 truncate">{doc.fileName}</span>
                    </div>
                    <div className="ml-6 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-gray-500">
                          Erstellt: {formatDateForDisplay(doc.generatedAt.split("T")[0])}
                        </span>
                        {doc.customerSignatureData && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-teal-50 text-teal-700">Kd. unterschrieben</span>
                        )}
                        {doc.employeeSignatureData && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">MA unterschrieben</span>
                        )}
                        {doc.integrityHash && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">Verifiziert</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <a
                    href={`/api/admin/generated-documents/${doc.id}/download`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-gray-100 shrink-0"
                    data-testid={`button-download-generated-doc-${doc.id}`}
                  >
                    <Download className={`${iconSize.sm} text-gray-600`} />
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <DigitalDocumentFlow
        open={isDigitalFlowOpen}
        onOpenChange={setIsDigitalFlowOpen}
        customerId={customerId}
        targetName={customerName}
        targetType="customer"
        context="bestandskunde"
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ["admin", "customers", customerId, "documents"] });
        }}
      />
    </div>
  );
}
