import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type { InsuranceProviderItem } from "@/lib/api/types";

export const insuranceProviderKeys = {
  all: ["insurance-providers"] as const,
  list: (includeInactive?: boolean) => [...insuranceProviderKeys.all, "list", { includeInactive }] as const,
  detail: (id: number) => [...insuranceProviderKeys.all, "detail", id] as const,
};

export interface InsuranceProviderFormData {
  name: string;
  empfaenger?: string | null;
  empfaengerZeile2?: string | null;
  isPrivate?: boolean;
  ikNummer: string;
  strasse?: string | null;
  hausnummer?: string | null;
  plz?: string | null;
  stadt?: string | null;
  telefon?: string | null;
  fax?: string | null;
  email?: string | null;
  emailVerhinderungspflege?: string | null;
  kimAdresse?: string | null;
  ansprechpartner?: string | null;
  datenannahmeIk?: string | null;
  emailInvoiceEnabled?: boolean;
  zahlungsbedingungen?: string;
  zahlungsart?: string;
  isActive?: boolean;
}

export function useInsuranceProviders(includeInactive = false) {
  return useQuery({
    queryKey: insuranceProviderKeys.list(includeInactive),
    queryFn: async ({ signal }) => {
      const url = includeInactive
        ? "/insurance-providers?all=true"
        : "/insurance-providers";
      const result = await api.get<InsuranceProviderItem[]>(url, signal);
      return unwrapResult(result);
    },
    staleTime: 60000 * 5,
  });
}

export function useCreateInsuranceProvider() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  return useMutation({
    mutationFn: async (data: InsuranceProviderFormData) => {
      const result = await api.post<InsuranceProviderItem>(
        "/admin/insurance-providers",
        data
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "insurance-providers");
      toast({ title: "Erfolg", description: "Pflegekasse wurde angelegt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export interface UnusedInsuranceProviderCount {
  total: number;
  private: number;
  statutory: number;
  cleanupEnabled: boolean;
}

export interface CleanupUnusedInsuranceProvidersResult {
  deleted: number;
  deletedPrivate: number;
  deletedStatutory: number;
  message: string;
}

export function useUnusedInsuranceProviderCount(enabled = true) {
  return useQuery({
    queryKey: [...insuranceProviderKeys.all, "unused-count"] as const,
    queryFn: async ({ signal }) => {
      const result = await api.get<UnusedInsuranceProviderCount>(
        "/admin/insurance-providers/cleanup/unused-count",
        signal,
      );
      return unwrapResult(result);
    },
    enabled,
    staleTime: 0,
  });
}

export function useCleanupUnusedInsuranceProviders() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async () => {
      const result = await api.post<CleanupUnusedInsuranceProvidersResult>(
        "/admin/insurance-providers/cleanup/unused",
        {},
      );
      return unwrapResult(result);
    },
    onSuccess: (result) => {
      invalidateRelated(queryClient, "insurance-providers");
      toast({ title: "Aufräumen abgeschlossen", description: result.message });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useDeleteInsuranceProvider() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete<{ deleted: boolean }>(
        `/admin/insurance-providers/${id}`,
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "insurance-providers");
      toast({ title: "Erfolg", description: "Pflegekasse wurde gelöscht" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useUpdateInsuranceProvider() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsuranceProviderFormData> }) => {
      const result = await api.put<InsuranceProviderItem>(
        `/admin/insurance-providers/${id}`,
        data
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "insurance-providers");
      toast({ title: "Erfolg", description: "Pflegekasse wurde aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}
