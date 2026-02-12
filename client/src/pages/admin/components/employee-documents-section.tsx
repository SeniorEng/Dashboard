import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  CalendarClock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatDateDisplay } from "@shared/utils/format";
import { useUpload } from "@/hooks/use-upload";

interface DocumentTypeData {
  id: number;
  name: string;
  description: string | null;
  reviewIntervalMonths: number | null;
  reminderLeadTimeDays: number | null;
  isActive: boolean;
}

interface EmployeeDocumentData {
  id: number;
  employeeId: number;
  documentTypeId: number;
  fileName: string;
  objectPath: string;
  uploadedAt: string;
  reviewDueDate: string | null;
  isCurrent: boolean;
  notes: string | null;
  documentType: DocumentTypeData;
}

function getReviewStatus(reviewDueDate: string | null): "ok" | "warning" | "overdue" | "none" {
  if (!reviewDueDate) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(reviewDueDate);
  const diffDays = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
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
      {status === "overdue" && <AlertTriangle className="h-3 w-3" />}
      {status === "warning" && <CalendarClock className="h-3 w-3" />}
      {labels[status]}
    </span>
  );
}

export function EmployeeDocumentsSection({ employeeId, userName, isAdmin = false }: { employeeId: number; userName: string; isAdmin?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [selectedDocTypeId, setSelectedDocTypeId] = useState("");
  const [notes, setNotes] = useState("");
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const { data: documents, isLoading: docsLoading } = useQuery<EmployeeDocumentData[]>({
    queryKey: ["admin", "employees", employeeId, "documents"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/employees/${employeeId}/documents`, { credentials: "include" });
      if (!res.ok) throw new Error("Dokumente konnten nicht geladen werden");
      return res.json();
    },
  });

  const { data: docTypes } = useQuery<DocumentTypeData[]>({
    queryKey: ["admin", "document-types", "employee"],
    queryFn: async () => {
      const res = await fetch("/api/admin/document-types?targetType=employee", { credentials: "include" });
      if (!res.ok) throw new Error("Dokumententypen konnten nicht geladen werden");
      return res.json();
    },
  });

  const { data: history, isLoading: historyLoading } = useQuery<EmployeeDocumentData[]>({
    queryKey: ["admin", "employees", employeeId, "documents", expandedHistory, "history"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/employees/${employeeId}/documents/${expandedHistory}/history`, { credentials: "include" });
      if (!res.ok) throw new Error("Dokumentenhistorie konnte nicht geladen werden");
      return res.json();
    },
    enabled: !!expandedHistory && isAdmin,
  });

  const { uploadFile, isUploading } = useUpload({
    onError: (error) => {
      toast({ title: "Upload-Fehler", description: error.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: { documentTypeId: number; fileName: string; objectPath: string; notes?: string | null }) => {
      const result = await api.post(`/admin/employees/${employeeId}/documents`, data);
      return unwrapResult(result);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleUpload = useCallback(async () => {
    if (selectedFiles.length === 0 || !selectedDocTypeId) return;

    for (const file of selectedFiles) {
      const uploadResult = await uploadFile(file);
      if (!uploadResult) return;

      await saveMutation.mutateAsync({
        documentTypeId: parseInt(selectedDocTypeId),
        fileName: file.name,
        objectPath: uploadResult.objectPath,
        notes: notes || null,
      });
    }

    queryClient.invalidateQueries({ queryKey: ["admin", "employees", employeeId, "documents"] });
    setIsUploadOpen(false);
    setSelectedDocTypeId("");
    setNotes("");
    setSelectedFiles([]);
    toast({ title: selectedFiles.length > 1 ? `${selectedFiles.length} Dokumente hinzugefügt` : "Dokument hinzugefügt" });
  }, [selectedFiles, selectedDocTypeId, notes, uploadFile, saveMutation, queryClient, employeeId, toast]);

  const uploadedDocTypeIds = new Set(documents?.map(d => d.documentTypeId) || []);
  const availableDocTypes = docTypes?.filter(dt => dt.isActive) || [];
  const missingDocTypes = availableDocTypes.filter(dt => !uploadedDocTypeIds.has(dt.id));

  const isSubmitting = isUploading || saveMutation.isPending;

  return (
    <div className="mt-6 pt-6 border-t">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <FileCheck2 className={iconSize.sm} />
          Dokumente
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsUploadOpen(!isUploadOpen)}
          data-testid="button-upload-document"
        >
          <Upload className={`${iconSize.sm} mr-1`} />
          Hinzufügen
        </Button>
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
            <p className="text-[11px] text-gray-400">PDF, Bild oder Word-Dokument (max. 10 MB je Datei). Mehrere Dateien möglich.</p>
            {selectedFiles.length > 1 && (
              <p className="text-xs text-teal-600">{selectedFiles.length} Dateien ausgewählt</p>
            )}
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
            <Button variant="outline" onClick={() => { setIsUploadOpen(false); setSelectedFiles([]); }}>
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
              <div key={doc.id} className={`p-3 bg-white border rounded-lg ${borderClass}`} data-testid={`doc-${doc.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <FileText className={`${iconSize.sm} text-gray-400 shrink-0`} />
                      <span className="text-sm font-medium text-gray-900 truncate">{doc.documentType.name}</span>
                    </div>
                    <div className="ml-6 space-y-1">
                      <p className="text-xs text-gray-500 truncate">{doc.fileName}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-gray-400">
                          Hochgeladen: {formatDateDisplay(doc.uploadedAt.split("T")[0])}
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
                      data-testid={`button-download-doc-${doc.id}`}
                    >
                      <Download className={`${iconSize.sm} text-gray-600`} />
                    </a>
                    {isAdmin && doc.documentType.reviewIntervalMonths && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => setExpandedHistory(expandedHistory === doc.documentTypeId ? null : doc.documentTypeId)}
                        data-testid={`button-history-${doc.documentTypeId}`}
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

                {isAdmin && expandedHistory === doc.documentTypeId && (
                  <div className="mt-3 ml-6 pt-3 border-t border-gray-100">
                    <p className="text-xs font-medium text-gray-500 mb-2">Dokumentenhistorie</p>
                    {historyLoading ? (
                      <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
                    ) : history && history.length > 1 ? (
                      <div className="space-y-1.5">
                        {history.filter(h => !h.isCurrent).map(h => (
                          <div key={h.id} className="flex items-center justify-between text-xs text-gray-500 p-1.5 bg-gray-50 rounded">
                            <span className="truncate flex-1">{h.fileName}</span>
                            <span className="shrink-0 ml-2">{formatDateDisplay(h.uploadedAt.split("T")[0])}</span>
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
                      <p className="text-xs text-gray-400">Keine älteren Versionen</p>
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

      {missingDocTypes.length > 0 && documents && documents.length > 0 && (
        <div className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg">
          <p className="text-xs font-medium text-amber-700 mb-1">Fehlende Dokumente:</p>
          <div className="flex flex-wrap gap-1">
            {missingDocTypes.map(dt => (
              <Badge key={dt.id} variant="outline" className="text-xs border-amber-200 text-amber-600">
                {dt.name}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
