import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { Service } from "@shared/schema";
import type { CostEstimate } from "../components/cost-estimate-preview";

export interface AppointmentServiceEntry {
  serviceId: number;
  plannedDurationMinutes: number;
  serviceName: string;
  serviceCode: string | null;
}

export function useAppointmentServiceEntries(id: number) {
  return useQuery<AppointmentServiceEntry[]>({
    queryKey: [`/api/appointments/${id}/services`],
    queryFn: async () => {
      const result = await api.get<AppointmentServiceEntry[]>(`/appointments/${id}/services`);
      return unwrapResult(result);
    },
    enabled: id > 0,
  });
}

export function useCatalogServices() {
  return useQuery<Service[]>({
    queryKey: ["/api/services"],
    staleTime: 60_000,
  });
}

export function useCostEstimate(customerId: number | null | undefined, budgetEstimateParams: string | null) {
  return useQuery<CostEstimate>({
    queryKey: ["budget-cost-estimate", customerId, budgetEstimateParams],
    queryFn: async () => {
      const result = await api.get<CostEstimate>(`/budget/${customerId!}/cost-estimate?${budgetEstimateParams}`);
      if (!result.success) return { totalCents: 0, warning: null };
      return result.data;
    },
    enabled: !!customerId && !!budgetEstimateParams,
    staleTime: 30_000,
  });
}
