import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { api, unwrapResult } from "@/lib/api/client";
import { FileText, Upload, Loader2 } from "lucide-react";
import { iconSize } from "@/design-system";
import type { DocumentType, EmployeeDocument } from "@shared/schema";

interface DocumentWithType extends EmployeeDocument {
  documentType?: DocumentType;
}

export function DocumentsSection({ employeeId: _employeeId }: { employeeId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { uploadFile, isUploading } = useUpload();

  const { data: documents = [], isLoading: docsLoading } = useQuery<DocumentWithType[]>({
    queryKey: ["profile-documents"],
    queryFn: async () => {
      const result = await api.get<DocumentWithType[]>("/profile/documents");
      return unwrapResult(result);
    },
  });

  const { data: documentTypes = [] } = useQuery<DocumentType[]>({
    queryKey: ["profile-document-types"],
    queryFn: async () => {
      const result = await api.get<DocumentType[]>("/profile/document-types");
      return unwrapResult(result);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, documentTypeId }: { file: File; documentTypeId: number }) => {
      const uploadResult = await uploadFile(file);
      if (!uploadResult) throw new Error("Upload fehlgeschlagen");

      const result = await api.post("/profile/documents", {
        documentTypeId,
        fileName: file.name,
        objectPath: uploadResult.objectPath,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile-documents"] });
      toast({ title: "Dokument hochgeladen" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return (
    <SectionCard title="Meine Dokumente" icon={<FileText className={iconSize.sm} />}>
      {docsLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-3">
          {documentTypes.map((docType) => {
            const currentDoc = documents.find((d) => d.documentTypeId === docType.id && d.isCurrent);
            return (
              <div key={docType.id} className="flex items-center justify-between p-3 rounded-lg border" data-testid={`doc-type-${docType.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{docType.name}</p>
                  {currentDoc ? (
                    <p className="text-xs text-muted-foreground truncate">
                      {currentDoc.fileName} — hochgeladen am {new Date(currentDoc.uploadedAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}
                    </p>
                  ) : (
                    <p className="text-xs text-amber-600">Noch nicht hochgeladen</p>
                  )}
                </div>
                <div className="ml-2 shrink-0">
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          uploadMutation.mutate({ file, documentTypeId: docType.id });
                          e.target.value = "";
                        }
                      }}
                      disabled={isUploading || uploadMutation.isPending}
                      data-testid={`input-upload-doc-${docType.id}`}
                    />
                    <div className="inline-flex items-center justify-center h-9 px-3 rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors">
                      {uploadMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : currentDoc ? (
                        <>
                          <Upload className="h-4 w-4 mr-1" />
                          Aktualisieren
                        </>
                      ) : (
                        <>
                          <Upload className="h-4 w-4 mr-1" />
                          Hochladen
                        </>
                      )}
                    </div>
                  </label>
                </div>
              </div>
            );
          })}
          {documentTypes.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4" data-testid="text-no-doc-types">
              Keine Dokumententypen konfiguriert.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
