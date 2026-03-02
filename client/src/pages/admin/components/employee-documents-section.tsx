import { useState, useCallback } from "react";
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
  Loader2,
  Upload,
  FileCheck2,
  ChevronDown,
  ChevronRight,
  FileText,
  Download,
  Clock,
  FolderOpen,
  History,
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
  reviewIntervalMonths: number | null;
  reminderLeadTimeDays: number | null;
  isActive: boolean;
}

interface DocumentFileData {
  id: number;
  employeeId: number;
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
  employeeId: number | null;
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
  signingStatus: string | null;
}

export function EmployeeDocumentsSection({ employeeId, userName, isAdmin = false }: { employeeId: number; userName: string; isAdmin?: boolean }) {
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

  const { data: groupedDocs, isLoading: docsLoading } = useQuery<GroupedDocData[]>({
    queryKey: ["admin", "employees", employeeId, "documents", "grouped"],
    queryFn: async () => {
      const result = await api.get<GroupedDocData[]>(`/admin/employees/${employeeId}/documents?grouped=true`);
      return unwrapResult(result);
    },
  });

  const { data: docTypes } = useQuery<DocumentTypeData[]>({
    queryKey: ["admin", "document-types", "employee"],
    queryFn: async () => {
      const result = await api.get<DocumentTypeData[]>("/admin/document-types?targetType=employee");
      return unwrapResult(result);
    },
  });

  const { data: generatedDocs } = useQuery<GeneratedDocumentData[]>({
    queryKey: ["admin", "employees", employeeId, "generated-documents"],
    queryFn: async () => {
      const result = await api.get<GeneratedDocumentData[]>(`/admin/employees/${employeeId}/generated-documents`);
      return unwrapResult(result);
    },
  });

  const { uploadFile, isUploading } = useUpload({
    onError: (error) => {
      toast({ title: "Upload-Fehler", description: error.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: { documentTypeId: number; fileName: string; objectPath: string; notes?: string | null; skipDeactivation?: boolean; batchId?: string; batchLabel?: string }) => {
      const result = await api.post(`/admin/employees/${employeeId}/documents`, data);
      return unwrapResult(result);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

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

    queryClient.invalidateQueries({ queryKey: ["admin", "employees", employeeId, "documents"] });
    setIsUploadOpen(false);
    setSelectedDocTypeId("");
    setBatchLabel("");
    setNotes("");
    setSelectedFiles([]);
    toast({ title: selectedFiles.length > 1 ? `${selectedFiles.length} Dokumente hinzugefügt` : "Dokument hinzugefügt" });
  }, [selectedFiles, selectedDocTypeId, notes, batchLabel, uploadFile, saveMutation, queryClient, employeeId, toast]);

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
    <div className="mt-6 pt-6 border-t">
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
            data-testid="button-digital-employee-document"
          >
            <Pen className={`${iconSize.sm} mr-1`} />
            <span className="hidden sm:inline">Digital erstellen</span>
            <span className="sm:hidden">Digital</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsUploadOpen(!isUploadOpen)}
            data-testid="button-upload-document"
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
              <SelectTrigger data-testid="select-doc-type">
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
            <Label>Dateien auswählen *</Label>
            <Input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
              multiple
              onChange={(e) => setSelectedFiles(Array.from(e.target.files || []))}
              className="text-base"
              data-testid="input-document-file"
            />
            <p className="text-[11px] text-gray-500">PDF, Bild oder Word-Dokument (max. 10 MB je Datei). Mehrere Dateien möglich.</p>
            {selectedFiles.length > 1 && (
              <p className="text-xs text-teal-600">{selectedFiles.length} Dateien ausgewählt</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Bezeichnung (optional)</Label>
            <Input
              value={batchLabel}
              onChange={(e) => setBatchLabel(e.target.value)}
              placeholder="z.B. Minijob-Vertrag, Midijob-Vertrag"
              className="text-base"
              data-testid="input-batch-label"
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
              data-testid="input-document-notes"
            />
          </div>

          <div className="flex gap-2">
            <Button
              onClick={handleUpload}
              disabled={isSubmitting || selectedFiles.length === 0 || !selectedDocTypeId}
              data-testid="button-submit-document"
            >
              {isSubmitting ? (
                <><Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />Wird hinzugefügt...</>
              ) : selectedFiles.length > 1 ? `${selectedFiles.length} Dateien hinzufügen` : "Hinzufügen"}
            </Button>
            <Button variant="outline" onClick={() => { setIsUploadOpen(false); setSelectedFiles([]); setBatchLabel(""); setNotes(""); }}>
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
              <div key={group.documentType.id} className={`bg-white border rounded-lg ${borderClass}`} data-testid={`doctype-group-${group.documentType.id}`}>
                <button
                  onClick={() => toggleType(group.documentType.id)}
                  className="w-full p-3 flex items-center justify-between gap-2 text-left hover:bg-gray-50 rounded-lg transition-colors"
                  data-testid={`button-toggle-doctype-${group.documentType.id}`}
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
                      <div key={batch.batchId} className="ml-2 pl-3 border-l-2 border-teal-100" data-testid={`batch-${batch.batchId}`}>
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
                        </div>
                        <div className="space-y-1">
                          {batch.files.map((file) => (
                            <div key={file.id} className="flex items-center justify-between gap-2 py-1 px-2 rounded hover:bg-gray-50" data-testid={`doc-${file.id}`}>
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <FileText className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                                <span className="text-xs text-gray-700 truncate">{file.fileName}</span>
                              </div>
                              <a
                                href={file.objectPath}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center h-7 w-7 rounded hover:bg-gray-100 shrink-0"
                                data-testid={`button-download-doc-${file.id}`}
                              >
                                <Download className="h-3.5 w-3.5 text-gray-500" />
                              </a>
                            </div>
                          ))}
                        </div>
                        {batch.files[0]?.notes && (
                          <p className="text-[11px] text-gray-500 italic mt-1 ml-2">{batch.files[0].notes}</p>
                        )}
                      </div>
                    ))}

                    {isAdmin && group.archivedBatches.length > 0 && (
                      <div className="ml-2">
                        <button
                          onClick={() => setShowArchive(showArchive === group.documentType.id ? null : group.documentType.id)}
                          className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 mt-1"
                          data-testid={`button-archive-${group.documentType.id}`}
                        >
                          <History className="h-3 w-3" />
                          {group.archivedBatches.length} ältere{group.archivedBatches.length === 1 ? "r Upload" : " Uploads"}
                        </button>

                        {showArchive === group.documentType.id && (
                          <div className="mt-2 space-y-2">
                            {group.archivedBatches.map((batch) => (
                              <div key={batch.batchId} className="pl-3 border-l-2 border-gray-200 opacity-60" data-testid={`archived-batch-${batch.batchId}`}>
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
                        {doc.signingStatus === "pending_employee_signature" ? (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Warte auf Unterschrift
                          </span>
                        ) : doc.employeeSignatureData ? (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">Unterschrieben</span>
                        ) : null}
                        {doc.integrityHash && doc.signingStatus !== "pending_employee_signature" && (
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
        employeeId={employeeId}
        targetName={userName}
        targetType="employee"
        context="bestandskunde"
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ["admin", "employees", employeeId, "documents"] });
        }}
      />
    </div>
  );
}
