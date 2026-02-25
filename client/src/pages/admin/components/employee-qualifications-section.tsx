import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Loader2,
  GraduationCap,
  X,
  FileCheck2,
  CheckCircle2,
  Clock,
  XCircle,
  Upload,
} from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";

interface Qualification {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
}

interface EmployeeQualification {
  id: number;
  employeeId: number;
  qualificationId: number;
  assignedAt: string;
  qualification: Qualification;
}

interface ProofItem {
  id: number;
  qualificationId: number;
  documentTypeId: number;
  status: string;
  fileName: string | null;
  uploadedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  documentType: { id: number; name: string };
  qualification: { id: number; name: string };
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="h-3.5 w-3.5 text-amber-500" />,
  uploaded: <Upload className="h-3.5 w-3.5 text-blue-500" />,
  approved: <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />,
  rejected: <XCircle className="h-3.5 w-3.5 text-red-500" />,
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Ausstehend",
  uploaded: "Hochgeladen",
  approved: "Freigegeben",
  rejected: "Abgelehnt",
};

export function EmployeeQualificationsSection({ employeeId }: { employeeId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedQualId, setSelectedQualId] = useState<string>("");

  const { data: employeeQuals, isLoading: qualsLoading } = useQuery<EmployeeQualification[]>({
    queryKey: ["admin", "employee-qualifications", employeeId],
    queryFn: async () => unwrapResult(await api.get<EmployeeQualification[]>(`/admin/qualifications/employee/${employeeId}/qualifications`)),
  });

  const { data: allQuals } = useQuery<Qualification[]>({
    queryKey: ["admin", "qualifications-active"],
    queryFn: async () => unwrapResult(await api.get<Qualification[]>("/admin/qualifications?activeOnly=true")),
  });

  const { data: proofs } = useQuery<ProofItem[]>({
    queryKey: ["admin", "employee-proofs", employeeId],
    queryFn: async () => unwrapResult(await api.get<ProofItem[]>(`/admin/qualifications/employee/${employeeId}/proofs`)),
  });

  const assignedQualIds = new Set(employeeQuals?.map((eq) => eq.qualificationId) || []);
  const availableQuals = allQuals?.filter((q) => !assignedQualIds.has(q.id)) || [];

  const assignMutation = useMutation({
    mutationFn: async (qualificationId: number) => unwrapResult(await api.post(`/admin/qualifications/employee/${employeeId}/assign`, { qualificationId })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "employee-qualifications", employeeId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "employee-proofs", employeeId] });
      setSelectedQualId("");
      toast({ title: "Qualifikation zugewiesen" });
    },
    onError: () => toast({ title: "Fehler", variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (qualificationId: number) => unwrapResult(await api.delete(`/admin/qualifications/employee/${employeeId}/qualifications/${qualificationId}`)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "employee-qualifications", employeeId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "employee-proofs", employeeId] });
      toast({ title: "Qualifikation entfernt" });
    },
    onError: () => toast({ title: "Fehler", variant: "destructive" }),
  });

  const proofsByQual = (qualId: number) => proofs?.filter((p) => p.qualificationId === qualId) || [];

  return (
    <Card data-testid="section-employee-qualifications">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <GraduationCap className="h-4 w-4" />
          Qualifikationen
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {availableQuals.length > 0 && (
          <div className="flex items-center gap-2">
            <Select value={selectedQualId} onValueChange={setSelectedQualId}>
              <SelectTrigger className="flex-1" data-testid="select-qualification">
                <SelectValue placeholder="Qualifikation wählen..." />
              </SelectTrigger>
              <SelectContent>
                {availableQuals.map((q) => (
                  <SelectItem key={q.id} value={q.id.toString()}>
                    {q.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!selectedQualId || assignMutation.isPending}
              onClick={() => assignMutation.mutate(parseInt(selectedQualId))}
              data-testid="button-assign-qualification"
            >
              {assignMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className={iconSize.sm} />}
              Zuweisen
            </Button>
          </div>
        )}

        {qualsLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !employeeQuals?.length ? (
          <p className="text-sm text-muted-foreground text-center py-3">Keine Qualifikationen zugewiesen</p>
        ) : (
          <div className="space-y-3">
            {employeeQuals.map((eq) => {
              const qualProofs = proofsByQual(eq.qualificationId);
              const allApproved = qualProofs.length > 0 && qualProofs.every((p) => p.status === "approved");
              const hasPending = qualProofs.some((p) => p.status === "pending" || p.status === "rejected");

              return (
                <div key={eq.id} className="border rounded-lg p-3" data-testid={`qualification-assignment-${eq.qualificationId}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <GraduationCap className="h-4 w-4 text-primary" />
                      <span className="font-medium text-sm">{eq.qualification.name}</span>
                      {allApproved && <Badge variant="default" className="text-xs bg-green-100 text-green-700 border-green-200">Vollständig</Badge>}
                      {hasPending && <Badge variant="secondary" className="text-xs bg-amber-50 text-amber-700 border-amber-200">Offen</Badge>}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Qualifikation entfernen"
                      onClick={() => removeMutation.mutate(eq.qualificationId)}
                      data-testid={`button-remove-qual-${eq.qualificationId}`}
                    >
                      <X className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>

                  {qualProofs.length > 0 && (
                    <div className="space-y-1 ml-6">
                      {qualProofs.map((proof) => (
                        <div key={proof.id} className="flex items-center gap-2 text-xs" data-testid={`proof-item-${proof.id}`}>
                          {STATUS_ICONS[proof.status]}
                          <FileCheck2 className="h-3 w-3 text-muted-foreground" />
                          <span className="flex-1 truncate">{proof.documentType.name}</span>
                          <span className="text-muted-foreground">{STATUS_LABELS[proof.status]}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
