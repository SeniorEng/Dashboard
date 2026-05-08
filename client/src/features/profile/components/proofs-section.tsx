import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { api, unwrapResult } from "@/lib/api/client";
import { GraduationCap, CheckCircle2, Clock, XCircle, Upload, Loader2 } from "lucide-react";
import { iconSize } from "@/design-system";
import type { ProofItem } from "../types";

export function ProofsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { uploadFile, isUploading } = useUpload();

  const { data: proofs = [], isLoading } = useQuery<ProofItem[]>({
    queryKey: ["profile-proofs"],
    queryFn: async () => unwrapResult(await api.get<ProofItem[]>("/profile/proofs")),
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, proofId }: { file: File; proofId: number }) => {
      const uploadResult = await uploadFile(file);
      if (!uploadResult) throw new Error("Upload fehlgeschlagen");
      const result = await api.patch<ProofItem>(`/profile/proofs/${proofId}/upload`, {
        fileName: file.name,
        objectPath: uploadResult.objectPath,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile-proofs"] });
      toast({ title: "Nachweis hochgeladen" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <SectionCard title="Dokumentennachweise" icon={<GraduationCap className={iconSize.sm} />}>
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </SectionCard>
    );
  }

  if (proofs.length === 0) return null;

  const grouped = proofs.reduce<Record<string, ProofItem[]>>((acc, proof) => {
    const key = proof.qualification?.name ?? "Dokumentenpflichten";
    if (!acc[key]) acc[key] = [];
    acc[key].push(proof);
    return acc;
  }, {});

  return (
    <SectionCard title="Dokumentennachweise" icon={<GraduationCap className={iconSize.sm} />}>
      <div className="space-y-4">
        {Object.entries(grouped).map(([qualName, qualProofs]) => (
          <div key={qualName}>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <GraduationCap className="h-3.5 w-3.5 text-primary" />
              {qualName}
            </h4>
            <div className="space-y-2 ml-5">
              {qualProofs.map((proof) => (
                <div key={proof.id} className="flex items-center justify-between p-3 rounded-lg border" data-testid={`proof-${proof.id}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{proof.documentType.name}</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      {proof.status === "approved" && <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
                      {proof.status === "pending" && <Clock className="h-3.5 w-3.5 text-amber-500" />}
                      {proof.status === "uploaded" && <Upload className="h-3.5 w-3.5 text-blue-500" />}
                      {proof.status === "rejected" && <XCircle className="h-3.5 w-3.5 text-red-500" />}
                      <span className="text-xs text-muted-foreground">
                        {proof.status === "approved" && "Freigegeben"}
                        {proof.status === "pending" && "Bitte hochladen"}
                        {proof.status === "uploaded" && "Wird geprüft"}
                        {proof.status === "rejected" && `Abgelehnt${proof.rejectionReason ? `: ${proof.rejectionReason}` : ""}`}
                      </span>
                    </div>
                    {proof.fileName && proof.status !== "rejected" && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{proof.fileName}</p>
                    )}
                  </div>
                  {(proof.status === "pending" || proof.status === "rejected") && (
                    <div className="ml-2 shrink-0">
                      <label className="cursor-pointer">
                        <input
                          type="file"
                          className="hidden"
                          accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              uploadMutation.mutate({ file, proofId: proof.id });
                              e.target.value = "";
                            }
                          }}
                          disabled={isUploading || uploadMutation.isPending}
                          data-testid={`input-upload-proof-${proof.id}`}
                        />
                        <div className="inline-flex items-center justify-center h-9 px-3 rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors">
                          {uploadMutation.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Upload className="h-4 w-4 mr-1" />
                              {proof.status === "rejected" ? "Erneut hochladen" : "Hochladen"}
                            </>
                          )}
                        </div>
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
