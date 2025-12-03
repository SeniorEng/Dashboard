/**
 * Insurance Provider Hooks
 * 
 * React Query hooks for fetching insurance provider data.
 */

import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { InsuranceProviderItem } from "@/lib/api/types";

export const insuranceProviderKeys = {
  all: ["insurance-providers"] as const,
  list: () => [...insuranceProviderKeys.all, "list"] as const,
};

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
