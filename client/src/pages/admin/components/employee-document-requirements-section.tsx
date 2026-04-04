import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { parseLocalDate } from "@shared/utils/datetime";
import { iconSize } from "@/design-system";
import {
  FileCheck2,
  CheckCircle2,
  Clock,
  XCircle,
  Upload,
  Loader2,
  AlertTriangle,
  Shield,
  Briefcase,
} from "lucide-react";

interface DocumentRequirement {
  documentType: {
    id: number;
    name: string;
    description: string | null;
    inputMethod: string;
    renewalDays: number | null;
    isMandatory: boolean;
  };
  requirement: "pflicht" | "optional";
  triggeredBy: string;
  template?: {
    id: number;
    slug: string;
    name: string;
  } | null;
}

interface ProofItem {
  id: number;
  qualificationId: number | null;
  documentTypeId: number;
  status: string;
  fileName: string | null;
  objectPath: string | null;
  uploadedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  documentType: { id: number; name: string };
  qualification: { id: number; name: string } | null;
}

interface DocumentItem {
  id: number;
  documentTypeId: number;
  fileName: string;
  uploadedAt: string;
  isCurrent: boolean;
  reviewDueDate: string | null;
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; label: string; badgeClass: string }> = {
  approved: {
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />,
    label: "Freigegeben",
    badgeClass: "bg-green-100 text-green-700 border-green-200",
  },
  uploaded: {
    icon: <Upload className="h-3.5 w-3.5 text-blue-500" />,
    label: "Wird geprüft",
    badgeClass: "bg-blue-100 text-blue-700 border-blue-200",
  },
  pending: {
    icon: <Clock className="h-3.5 w-3.5 text-amber-500" />,
    label: "Ausstehend",
    badgeClass: "bg-amber-50 text-amber-700 border-amber-200",
  },
  rejected: {
    icon: <XCircle className="h-3.5 w-3.5 text-red-500" />,
    label: "Abgelehnt",
    badgeClass: "bg-red-100 text-red-700 border-red-200",
  },
  fulfilled: {
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />,
    label: "Vorhanden",
    badgeClass: "bg-green-100 text-green-700 border-green-200",
  },
  missing: {
    icon: <Clock className="h-3.5 w-3.5 text-amber-500" />,
    label: "Noch nicht hochgeladen",
    badgeClass: "bg-amber-50 text-amber-700 border-amber-200",
  },
};

function getOverdueInfo(reviewDueDate: string | null): { isOverdue: boolean; isDueSoon: boolean } {
  if (!reviewDueDate) return { isOverdue: false, isDueSoon: false };
  const due = parseLocalDate(reviewDueDate);
  const now = new Date();
  const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return {
    isOverdue: diffDays < 0,
    isDueSoon: diffDays >= 0 && diffDays <= 30,
  };
}

export function EmployeeDocumentRequirementsSection({ employeeId }: { employeeId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { uploadFile, isUploading } = useUpload();

  const { data: requirements, isLoading: reqLoading } = useQuery<DocumentRequirement[]>({
    queryKey: ["admin", "employee-document-requirements", employeeId],
    queryFn: async () => unwrapResult(await api.get<DocumentRequirement[]>(`/admin/document-requirements/employee/${employeeId}`)),
  });

  const { data: proofs } = useQuery<ProofItem[]>({
    queryKey: ["admin", "employee-proofs", employeeId],
    queryFn: async () => unwrapResult(await api.get<ProofItem[]>(`/admin/employee/${employeeId}/proofs`)),
  });

  const { data: documents } = useQuery<DocumentItem[]>({
    queryKey: ["admin", "employees", employeeId, "documents", "current"],
    queryFn: async () => unwrapResult(await api.get<DocumentItem[]>(`/admin/employees/${employeeId}/documents`)),
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, proofId }: { file: File; proofId: number }) => {
      const uploadResult = await uploadFile(file);
      if (!uploadResult) throw new Error("Upload fehlgeschlagen");
      return unwrapResult(await api.patch(`/admin/proofs/${proofId}/upload`, {
        fileName: file.name,
        objectPath: uploadResult.objectPath,
      }));
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "employee-proofs", "employee-documents");
      toast({ title: "Nachweis hochgeladen" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  if (reqLoading) {
    return (
      <Card data-testid="section-employee-document-requirements">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileCheck2 className="h-4 w-4" />
            Dokumentenpflichten
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!requirements || requirements.length === 0) {
    return (
      <Card data-testid="section-employee-document-requirements">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileCheck2 className="h-4 w-4" />
            Dokumentenpflichten
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-3">
            Keine Dokumentenpflichten für diesen Mitarbeiter
          </p>
        </CardContent>
      </Card>
    );
  }

  const proofsByDocType = new Map<number, ProofItem>();
  for (const proof of (proofs || [])) {
    const existing = proofsByDocType.get(proof.documentTypeId);
    if (!existing || getProofPriority(proof.status) > getProofPriority(existing.status)) {
      proofsByDocType.set(proof.documentTypeId, proof);
    }
  }

  const documentsByType = new Map<number, DocumentItem>();
  for (const doc of (documents || [])) {
    if (doc.isCurrent) {
      documentsByType.set(doc.documentTypeId, doc);
    }
  }

  const generalReqs = requirements.filter((r) =>
    r.triggeredBy === "Immer verpflichtend" || r.triggeredBy === "Gilt für alle"
  );
  const roleBasedReqs = requirements.filter((r) =>
    r.triggeredBy !== "Immer verpflichtend" && r.triggeredBy !== "Gilt für alle"
  );

  return (
    <Card data-testid="section-employee-document-requirements">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileCheck2 className="h-4 w-4" />
          Dokumentenpflichten
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {generalReqs.length > 0 && (
          <RequirementGroup
            title="Allgemein"
            icon={<Shield className="h-3.5 w-3.5 text-teal-600" />}
            requirements={generalReqs}
            proofsByDocType={proofsByDocType}
            documentsByType={documentsByType}
            onUpload={(file, proofId) => uploadMutation.mutate({ file, proofId })}
            isUploading={isUploading || uploadMutation.isPending}
          />
        )}

        {roleBasedReqs.length > 0 && (
          <RequirementGroup
            title="Rollenbasiert"
            icon={<Briefcase className="h-3.5 w-3.5 text-blue-600" />}
            requirements={roleBasedReqs}
            proofsByDocType={proofsByDocType}
            documentsByType={documentsByType}
            onUpload={(file, proofId) => uploadMutation.mutate({ file, proofId })}
            isUploading={isUploading || uploadMutation.isPending}
          />
        )}
      </CardContent>
    </Card>
  );
}

function getProofPriority(status: string): number {
  switch (status) {
    case "approved": return 4;
    case "uploaded": return 3;
    case "rejected": return 1;
    case "pending": return 2;
    default: return 0;
  }
}

function RequirementGroup({
  title,
  icon,
  requirements,
  proofsByDocType,
  documentsByType,
  onUpload,
  isUploading,
}: {
  title: string;
  icon: React.ReactNode;
  requirements: DocumentRequirement[];
  proofsByDocType: Map<number, ProofItem>;
  documentsByType: Map<number, DocumentItem>;
  onUpload: (file: File, proofId: number) => void;
  isUploading: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
      </div>
      <div className="space-y-2">
        {requirements.map((req) => (
          <RequirementItem
            key={req.documentType.id}
            requirement={req}
            proof={proofsByDocType.get(req.documentType.id)}
            document={documentsByType.get(req.documentType.id)}
            onUpload={onUpload}
            isUploading={isUploading}
          />
        ))}
      </div>
    </div>
  );
}

function RequirementItem({
  requirement,
  proof,
  document,
  onUpload,
  isUploading,
}: {
  requirement: DocumentRequirement;
  proof?: ProofItem;
  document?: DocumentItem;
  onUpload: (file: File, proofId: number) => void;
  isUploading: boolean;
}) {
  let status: string;
  let reviewDueDate: string | null = null;

  if (proof) {
    status = proof.status;
  } else if (document) {
    status = "fulfilled";
    reviewDueDate = document.reviewDueDate;
  } else {
    status = "missing";
  }

  const config = STATUS_CONFIG[status] || STATUS_CONFIG.missing;
  const { isOverdue, isDueSoon } = getOverdueInfo(reviewDueDate);
  const canUpload = proof && (proof.status === "pending" || proof.status === "rejected");

  let borderClass = "border-gray-100";
  if (isOverdue) borderClass = "border-red-200 bg-red-50/30";
  else if (isDueSoon) borderClass = "border-amber-200 bg-amber-50/30";
  else if (status === "rejected") borderClass = "border-red-200";

  return (
    <div
      className={`border rounded-lg p-3 ${borderClass}`}
      data-testid={`requirement-${requirement.documentType.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-medium text-sm truncate">{requirement.documentType.name}</span>
            <Badge variant="secondary" className={`text-xs ${config.badgeClass}`}>
              {config.label}
            </Badge>
            {requirement.requirement === "pflicht" && (
              <Badge variant="outline" className="text-xs">Pflicht</Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{requirement.triggeredBy}</span>
            {isOverdue && (
              <span className="flex items-center gap-1 text-red-600 font-medium">
                <AlertTriangle className="h-3 w-3" />
                Überfällig
              </span>
            )}
            {isDueSoon && !isOverdue && (
              <span className="flex items-center gap-1 text-amber-600 font-medium">
                <AlertTriangle className="h-3 w-3" />
                Bald fällig
              </span>
            )}
            {reviewDueDate && (
              <span>
                Fällig: {parseLocalDate(reviewDueDate).toLocaleDateString("de-DE")}
              </span>
            )}
          </div>
          {proof?.rejectionReason && status === "rejected" && (
            <p className="text-xs text-red-600 mt-1">
              Ablehnungsgrund: {proof.rejectionReason}
            </p>
          )}
          {proof?.fileName && status !== "pending" && status !== "rejected" && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{proof.fileName}</p>
          )}
          {document && !proof && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{document.fileName}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {config.icon}
          {canUpload && (
            <label className="cursor-pointer ml-1">
              <input
                type="file"
                className="hidden"
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && proof) {
                    onUpload(file, proof.id);
                    e.target.value = "";
                  }
                }}
                disabled={isUploading}
                data-testid={`input-upload-requirement-${requirement.documentType.id}`}
              />
              <div className="inline-flex items-center justify-center h-8 px-2.5 rounded-md text-xs font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors">
                {isUploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Upload className="h-3.5 w-3.5 mr-1" />
                    {status === "rejected" ? "Erneut" : "Upload"}
                  </>
                )}
              </div>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
