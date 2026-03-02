import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { iconSize } from "@/design-system";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2,
  Upload,
  FileCheck2,
  ChevronDown,
  ChevronRight,
  FileText,
  Download,
  Camera,
  X,
  FolderOpen,
  History,
  Trash2,
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

interface DocumentFileData {
  id: number;
  customerId: number;
  documentTypeId: number;
  fileName: string;
  objectPath: string;
  uploadedAt: string;
  reviewDueDate: string | null;
  isCurrent: boolean;
  notes: string | null;
  batchId: string;
  batchLabel: string | null;
}

interface BatchData {
  batchId: string;
  batchLabel: string | null;
  uploadedAt: string;
  files: DocumentFileData[];
}

interface GroupedDocData {
  documentType: DocumentTypeData;
  currentBatches: BatchData[];
  archivedBatches: BatchData[];
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

type DeleteTarget = { type: "file"; id: number; fileName: string } | { type: "batch"; batchId: string; fileCount: number };

export function CustomerDocumentsSection({ customerId, customerName }: { customerId: number; customerName: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isDigitalFlowOpen, setIsDigitalFlowOpen] = useState(false);
  const [selectedDocTypeId, setSelectedDocTypeId] = useState("");
  const [batchLabel, setBatchLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [expandedTypes, setExpandedTypes] = useState<Set<number>>(new Set());
  const [showArchive, setShowArchive] = useState<number | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [filePreviews, setFilePreviews] = useState<{ file: File; preview?: string }[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const { data: groupedDocs, isLoading: docsLoading } = useQuery<GroupedDocData[]>({
    queryKey: ["admin", "customers", customerId, "documents", "grouped"],
    queryFn: async () => {
      const result = await api.get<GroupedDocData[]>(`/admin/customers/${customerId}/documents?grouped=true`);
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
    mutationFn: async (data: { documentTypeId: number; fileName: string; objectPath: string; notes?: string | null; skipDeactivation?: boolean; batchId?: string; batchLabel?: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/documents`, data);
      return unwrapResult(result);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: async (documentId: number) => {
      const result = await api.delete(`/admin/customers/${customerId}/documents/${documentId}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "customers", customerId, "documents"] });
      toast({ title: "Dokument gelöscht" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteBatchMutation = useMutation({
    mutationFn: async (batchId: string) => {
      const result = await api.delete(`/admin/customers/${customerId}/documents/batch/${batchId}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "customers", customerId, "documents"] });
      toast({ title: "Upload gelöscht" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    if (deleteTarget.type === "file") {
      deleteFileMutation.mutate(deleteTarget.id);
    } else {
      deleteBatchMutation.mutate(deleteTarget.batchId);
    }
    setDeleteTarget(null);
  }, [deleteTarget, deleteFileMutation, deleteBatchMutation]);

  const handleUpload = useCallback(async () => {
    if (selectedFiles.length === 0 || !selectedDocTypeId) return;

    const uploadBatchId = crypto.randomUUID();

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
        batchId: uploadBatchId,
        batchLabel: batchLabel || undefined,
      });
    }

    queryClient.invalidateQueries({ queryKey: ["admin", "customers", customerId, "documents"] });
    const count = selectedFiles.length;
    setIsUploadOpen(false);
    setSelectedDocTypeId("");
    setBatchLabel("");
    setNotes("");
    clearAllFiles();
    toast({ title: count > 1 ? `${count} Dokumente hinzugefügt` : "Dokument hinzugefügt" });
  }, [selectedFiles, selectedDocTypeId, notes, batchLabel, uploadFile, saveMutation, queryClient, customerId, toast, clearAllFiles]);

  const toggleType = (typeId: number) => {
    setExpandedTypes(prev => {
      const next = new Set(prev);
      if (next.has(typeId)) {
        next.delete(typeId);
      } else {
        next.add(typeId);
      }
      return next;
    });
  };

  const availableDocTypes = (docTypes?.filter(dt => dt.isActive) || []).sort((a, b) => a.name.localeCompare(b.name, "de"));
  const isSubmitting = isUploading || saveMutation.isPending;
  const isDeleting = deleteFileMutation.isPending || deleteBatchMutation.isPending;

  const getBestReviewStatus = (batches: BatchData[]) => {
    let worstStatus: "ok" | "warning" | "overdue" | null = null;
    for (const batch of batches) {
      for (const file of batch.files) {
        const s = getReviewStatus(file.reviewDueDate);
        if (s === "overdue") return "overdue";
        if (s === "warning") worstStatus = "warning";
        if (!worstStatus && s === "ok") worstStatus = "ok";
      }
    }
    return worstStatus;
  };

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
            <Label>Bezeichnung (optional)</Label>
            <Input
              value={batchLabel}
              onChange={(e) => setBatchLabel(e.target.value)}
              placeholder="z.B. Pflegevertrag, Vollmacht"
              className="text-base"
              data-testid="input-customer-batch-label"
            />
            <p className="text-[11px] text-gray-500">Hilft beim Zuordnen, wenn es mehrere Uploads gibt</p>
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
            <Button variant="outline" onClick={() => { setIsUploadOpen(false); clearAllFiles(); setBatchLabel(""); setNotes(""); }}>
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      {docsLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : groupedDocs && groupedDocs.length > 0 ? (
        <div className="space-y-2">
          {groupedDocs.map((group) => {
            const isExpanded = expandedTypes.has(group.documentType.id);
            const totalFiles = group.currentBatches.reduce((sum, b) => sum + b.files.length, 0);
            const reviewStatus = getBestReviewStatus(group.currentBatches);
            const borderClass = reviewStatus === "overdue" ? "border-red-200" : reviewStatus === "warning" ? "border-amber-200" : "border-gray-100";

            return (
              <div key={group.documentType.id} className={`bg-white border rounded-lg ${borderClass}`} data-testid={`customer-doctype-group-${group.documentType.id}`}>
                <button
                  onClick={() => toggleType(group.documentType.id)}
                  className="w-full p-3 flex items-center justify-between gap-2 text-left hover:bg-gray-50 rounded-lg transition-colors"
                  data-testid={`button-toggle-customer-doctype-${group.documentType.id}`}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <FolderOpen className={`${iconSize.sm} text-teal-600 shrink-0`} />
                    <span className="text-sm font-medium text-gray-900 truncate">{group.documentType.name}</span>
                    <span className="text-xs text-gray-400 shrink-0">
                      {group.currentBatches.length === 1 && totalFiles === 1
                        ? "1 Datei"
                        : group.currentBatches.length === 1
                        ? `${totalFiles} Dateien`
                        : `${group.currentBatches.length} Uploads`}
                    </span>
                    {group.currentBatches.length > 0 && (
                      <ReviewBadge reviewDueDate={group.currentBatches[0]?.files[0]?.reviewDueDate ?? null} />
                    )}
                  </div>
                  {isExpanded ? (
                    <ChevronDown className={`${iconSize.sm} text-gray-400 shrink-0`} />
                  ) : (
                    <ChevronRight className={`${iconSize.sm} text-gray-400 shrink-0`} />
                  )}
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-2">
                    {group.currentBatches.map((batch) => (
                      <div key={batch.batchId} className="ml-2 pl-3 border-l-2 border-teal-100" data-testid={`customer-batch-${batch.batchId}`}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs text-gray-500">
                            {formatDateForDisplay(batch.uploadedAt.split("T")[0])}
                          </span>
                          {batch.batchLabel && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-teal-50 text-teal-700">{batch.batchLabel}</span>
                          )}
                          {batch.files.length > 1 && (
                            <span className="text-xs text-gray-400">{batch.files.length} Dateien</span>
                          )}
                          {batch.files.length > 1 && (
                            <button
                              onClick={() => setDeleteTarget({ type: "batch", batchId: batch.batchId, fileCount: batch.files.length })}
                              className="ml-auto text-gray-300 hover:text-red-500 transition-colors"
                              disabled={isDeleting}
                              data-testid={`button-delete-customer-batch-${batch.batchId}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="space-y-1">
                          {batch.files.map((file) => (
                            <div key={file.id} className="flex items-center justify-between gap-2 py-1 px-2 rounded hover:bg-gray-50" data-testid={`customer-doc-${file.id}`}>
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <FileText className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                                <span className="text-xs text-gray-700 truncate">{file.fileName}</span>
                              </div>
                              <div className="flex items-center gap-0.5 shrink-0">
                                <a
                                  href={file.objectPath}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-gray-100"
                                  data-testid={`button-download-customer-doc-${file.id}`}
                                >
                                  <Download className="h-3.5 w-3.5 text-gray-500" />
                                </a>
                                <button
                                  onClick={() => setDeleteTarget({ type: "file", id: file.id, fileName: file.fileName })}
                                  className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors"
                                  disabled={isDeleting}
                                  data-testid={`button-delete-customer-doc-${file.id}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                        {batch.files[0]?.notes && (
                          <p className="text-[11px] text-gray-500 italic mt-1 ml-2">{batch.files[0].notes}</p>
                        )}
                      </div>
                    ))}

                    {group.archivedBatches.length > 0 && (
                      <div className="ml-2">
                        <button
                          onClick={() => setShowArchive(showArchive === group.documentType.id ? null : group.documentType.id)}
                          className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 mt-1"
                          data-testid={`button-customer-archive-${group.documentType.id}`}
                        >
                          <History className="h-3 w-3" />
                          {group.archivedBatches.length} ältere{group.archivedBatches.length === 1 ? "r Upload" : " Uploads"}
                        </button>

                        {showArchive === group.documentType.id && (
                          <div className="mt-2 space-y-2">
                            {group.archivedBatches.map((batch) => (
                              <div key={batch.batchId} className="pl-3 border-l-2 border-gray-200 opacity-60" data-testid={`customer-archived-batch-${batch.batchId}`}>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-xs text-gray-500">
                                    {formatDateForDisplay(batch.uploadedAt.split("T")[0])}
                                  </span>
                                  {batch.batchLabel && (
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{batch.batchLabel}</span>
                                  )}
                                </div>
                                <div className="space-y-1">
                                  {batch.files.map((file) => (
                                    <div key={file.id} className="flex items-center justify-between gap-2 py-1 px-2 rounded">
                                      <div className="flex items-center gap-2 flex-1 min-w-0">
                                        <FileText className="h-3 w-3 text-gray-400 shrink-0" />
                                        <span className="text-[11px] text-gray-500 truncate">{file.fileName}</span>
                                      </div>
                                      <a
                                        href={file.objectPath}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ml-2 shrink-0"
                                      >
                                        <Download className="h-3 w-3 text-gray-400 hover:text-gray-600" />
                                      </a>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
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

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.type === "batch" ? "Upload löschen?" : "Dokument löschen?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "batch"
                ? `Alle ${deleteTarget.fileCount} Dateien dieses Uploads werden gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.`
                : `Die Datei "${deleteTarget?.fileName}" wird gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700 text-white"
              data-testid="button-confirm-delete-customer"
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
