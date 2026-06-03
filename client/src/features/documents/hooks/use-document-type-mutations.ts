import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import type { DocumentTypeData, TriggerData } from "../types";
import { toPayload } from "../utils";

interface UseDocumentTypeMutationsArgs {
  triggers: TriggerData[];
  onCreateSuccess: () => void;
  onUpdateSuccess: () => void;
}

export function useDocumentTypeMutations({
  triggers,
  onCreateSuccess,
  onUpdateSuccess,
}: UseDocumentTypeMutationsArgs) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createMutation = useMutation({
    mutationFn: async (data: ReturnType<typeof toPayload>) => {
      const result = await api.post<DocumentTypeData>("/admin/document-types", data);
      return unwrapResult(result);
    },
    onSuccess: async (newDocType) => {
      if (triggers.length > 0 && newDocType && typeof newDocType === 'object' && 'id' in newDocType) {
        const dt = newDocType as DocumentTypeData;
        await api.put(`/admin/document-types/${dt.id}/triggers`, {
          triggers: triggers.map((t, i) => ({ ...t, sortOrder: i })),
        });
      }
      invalidateRelated(queryClient, "document-types");
      onCreateSuccess();
      toast({ title: "Dokumententyp erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: ReturnType<typeof toPayload> & { id: number }) => {
      const [docResult] = await Promise.all([
        api.patch(`/admin/document-types/${id}`, data),
        api.put(`/admin/document-types/${id}/triggers`, {
          triggers: triggers.map((t, i) => ({ ...t, sortOrder: i })),
        }),
      ]);
      return unwrapResult(docResult);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "document-types");
      onUpdateSuccess();
      toast({ title: "Dokumententyp aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return { createMutation, updateMutation };
}
