import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Loader2,
  FileCheck2,
  CheckCircle2,
  XCircle,
  Eye,
  GraduationCap,
  User,
} from "lucide-react";
import { Link } from "wouter";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";

interface PendingProof {
  id: number;
  employeeId: number;
  qualificationId: number;
  documentTypeId: number;
  status: string;
  fileName: string | null;
  objectPath: string | null;
  uploadedAt: string | null;
  documentType: { id: number; name: string };
  qualification: { id: number; name: string };
  employee: { id: number; displayName: string };
}

export default function ProofReviewPage() {
  return (
    <Layout variant="admin">
      <ProofReviewContent />
    </Layout>
  );
}

function ProofReviewContent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [rejectingProof, setRejectingProof] = useState<PendingProof | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");

  const { data: proofs, isLoading } = useQuery<PendingProof[]>({
    queryKey: ["admin", "pending-proofs"],
    queryFn: async () => unwrapResult(await api.get<PendingProof[]>("/admin/qualifications/proofs/pending-review")),
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ proofId, approved, rejectionReason }: { proofId: number; approved: boolean; rejectionReason?: string }) =>
      unwrapResult(await api.patch(`/admin/qualifications/proofs/${proofId}/review`, { approved, rejectionReason })),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "pending-proofs"] });
      toast({ title: variables.approved ? "Nachweis freigegeben" : "Nachweis abgelehnt" });
      setRejectingProof(null);
      setRejectionReason("");
    },
    onError: () => toast({ title: "Fehler", variant: "destructive" }),
  });

  const groupedByEmployee = (proofs || []).reduce<Record<string, PendingProof[]>>((acc, proof) => {
    const key = proof.employee.displayName;
    if (!acc[key]) acc[key] = [];
    acc[key].push(proof);
    return acc;
  }, {});

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin/qualifications">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold" data-testid="text-page-title">Nachweis-Prüfung</h1>
          <p className="text-sm text-muted-foreground">
            {proofs?.length ?? 0} hochgeladene Nachweise zur Prüfung
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !proofs?.length ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle2 className="h-12 w-12 mx-auto text-green-500/50 mb-3" />
            <p className="text-muted-foreground">Keine ausstehenden Nachweise zur Prüfung.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedByEmployee).map(([employeeName, employeeProofs]) => (
            <Card key={employeeName} data-testid={`proofs-group-${employeeName}`}>
              <CardContent className="py-3 px-4 space-y-3">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium text-sm">{employeeName}</span>
                  <Badge variant="secondary" className="text-xs">{employeeProofs.length}</Badge>
                </div>
                <div className="space-y-2">
                  {employeeProofs.map((proof) => (
                    <div key={proof.id} className="flex items-center gap-3 p-2 rounded-lg border bg-muted/30" data-testid={`review-proof-${proof.id}`}>
                      <FileCheck2 className="h-4 w-4 text-blue-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{proof.documentType.name}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <GraduationCap className="h-3 w-3" />
                          <span className="truncate">{proof.qualification.name}</span>
                          {proof.uploadedAt && (
                            <>
                              <span>·</span>
                              <span>{new Date(proof.uploadedAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                            </>
                          )}
                        </div>
                        {proof.fileName && (
                          <p className="text-xs text-muted-foreground truncate">{proof.fileName}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {proof.objectPath && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Nachweis anzeigen"
                            onClick={() => window.open(`/api/object-storage/download?path=${encodeURIComponent(proof.objectPath!)}`, '_blank')}
                            data-testid={`button-view-proof-${proof.id}`}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-green-600 hover:text-green-700 hover:bg-green-50"
                          aria-label="Nachweis genehmigen"
                          onClick={() => reviewMutation.mutate({ proofId: proof.id, approved: true })}
                          disabled={reviewMutation.isPending}
                          data-testid={`button-approve-proof-${proof.id}`}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                          aria-label="Nachweis ablehnen"
                          onClick={() => { setRejectingProof(proof); setRejectionReason(""); }}
                          disabled={reviewMutation.isPending}
                          data-testid={`button-reject-proof-${proof.id}`}
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!rejectingProof} onOpenChange={(open) => { if (!open) { setRejectingProof(null); setRejectionReason(""); } }}>
        <DialogContent className="fixed inset-0 flex items-center justify-center">
          <DialogHeader>
            <DialogTitle>Nachweis ablehnen</DialogTitle>
          </DialogHeader>
          {rejectingProof && (
            <div className="space-y-4">
              <div className="text-sm">
                <p><strong>{rejectingProof.employee.displayName}</strong></p>
                <p className="text-muted-foreground">{rejectingProof.documentType.name} — {rejectingProof.qualification.name}</p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Ablehnungsgrund</label>
                <Textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="Bitte geben Sie den Grund für die Ablehnung an..."
                  rows={3}
                  data-testid="input-rejection-reason"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => { setRejectingProof(null); setRejectionReason(""); }}
                  className="flex-1"
                >
                  Abbrechen
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => reviewMutation.mutate({ proofId: rejectingProof.id, approved: false, rejectionReason })}
                  disabled={reviewMutation.isPending}
                  className="flex-1"
                  data-testid="button-confirm-reject"
                >
                  {reviewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ablehnen"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
