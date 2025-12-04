/**
 * Insurance Provider Hooks
 * 
 * React Query hooks for fetching and managing insurance provider data.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { InsuranceProviderItem } from "@/lib/api/types";

export const insuranceProviderKeys = {
  all: ["insurance-providers"] as const,
  list: () => [...insuranceProviderKeys.all, "list"] as const,
};

export interface CreateInsuranceProviderData {
  name: string;
  ikNummer: string;
  strasse?: string;
  hausnummer?: string;
  plz?: string;
  stadt?: string;
  telefon?: string;
  email?: string;
}

/**
 * Fetch all insurance providers
 */
export function useInsuranceProviders() {
  return useQuery({
    queryKey: insuranceProviderKeys.list(),
    queryFn: async ({ signal }) => {
      const result = await api.get<InsuranceProviderItem[]>(
        "/admin/insurance-providers",
        signal
      );
      return unwrapResult(result);
    },
    staleTime: 60000 * 5, // 5 minutes cache
  });
}

/**
 * Create a new insurance provider
 */
export function useCreateInsuranceProvider() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: CreateInsuranceProviderData) => {
      const result = await api.post<InsuranceProviderItem>(
        "/admin/insurance-providers",
        data
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: insuranceProviderKeys.all });
    },
  });
}
