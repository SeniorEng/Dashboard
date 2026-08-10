import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";
import type { CoverageCheckResponse } from "@shared/api";

/**
 * Die Form kommt aus dem Response-Schema (`@shared/api`) statt aus einer lokalen
 * Kopie — die Kopie hier war ein Zweitbegriff derselben Frage und wäre beim
 * Zähler-Split still veraltet.
 */
export type CoverageData = CoverageCheckResponse;
export type { CoverageUncoveredCustomer, CoverageMonthData } from "@shared/api";

async function fetchCoverage(employeeId?: number | null): Promise<CoverageData> {
  const params = new URLSearchParams();
  if (employeeId) params.set("employeeId", employeeId.toString());
  const qs = params.toString();
  const endpoint = qs ? `/appointments/coverage-check?${qs}` : "/appointments/coverage-check";
  const result = await api.get<CoverageData>(endpoint);
  return unwrapResult(result);
}

export function useAppointmentCoverage() {
  const { viewAsEmployeeId } = useViewAsEmployee();
  return useQuery({
    queryKey: ["appointment-coverage", { viewAsEmployeeId }],
    queryFn: () => fetchCoverage(viewAsEmployeeId),
    staleTime: 5 * 60 * 1000,
  });
}
