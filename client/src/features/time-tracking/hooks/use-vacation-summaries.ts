import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { VacationSummary } from "@/lib/api/types";

export type VacationSummaryMap = Record<number, VacationSummary>;

export function useAllVacationSummaries(year?: number) {
  const currentYear = year ?? new Date().getFullYear();
  return useQuery<VacationSummaryMap>({
    queryKey: ["admin", "vacation-summaries", currentYear],
    queryFn: async ({ signal }) => {
      const result = await api.get<VacationSummaryMap>(
        `/admin/employees/vacation-summaries/${currentYear}`,
        signal
      );
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
}
