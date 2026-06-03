import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { DocumentTypeData, TriggerData } from "../types";

export function useDocumentTypes() {
  return useQuery<DocumentTypeData[]>({
    queryKey: ["admin", "document-types"],
    queryFn: async () => {
      const result = await api.get<DocumentTypeData[]>("/admin/document-types?includeInactive=true");
      return unwrapResult(result);
    },
  });
}

export function useDocumentTypeTriggers(editingType: DocumentTypeData | null) {
  return useQuery<TriggerData[]>({
    queryKey: ["admin", "document-type-triggers", editingType?.id],
    queryFn: async () => {
      if (!editingType) return [];
      const result = await api.get<TriggerData[]>(`/admin/document-types/${editingType.id}/triggers`);
      return unwrapResult(result);
    },
    enabled: !!editingType,
  });
}
