import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  ikNummer: string;
  strasse?: string | null;
  hausnummer?: string | null;
  plz?: string | null;
  stadt?: string | null;
  telefon?: string | null;
  email?: string | null;
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
        ? "/admin/insurance-providers?all=true"
        : "/admin/insurance-providers";
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
      queryClient.invalidateQueries({ queryKey: insuranceProviderKeys.all });
      toast({ title: "Erfolg", description: "Pflegekasse wurde angelegt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Pflegekasse konnte nicht angelegt werden", variant: "destructive" });
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
      queryClient.invalidateQueries({ queryKey: insuranceProviderKeys.all });
      toast({ title: "Erfolg", description: "Pflegekasse wurde aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Pflegekasse konnte nicht aktualisiert werden", variant: "destructive" });
    },
  });
}
