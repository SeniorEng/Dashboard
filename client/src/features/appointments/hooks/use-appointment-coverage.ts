import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";

interface UncoveredCustomer {
  id: number;
  name: string;
  role: "primary" | "backup1" | "backup2";
}

interface MonthCoverage {
  label: string;
  year: number;
  month: number;
  uncoveredCustomers: UncoveredCustomer[];
}

export interface CoverageData {
  currentMonth: MonthCoverage;
  nextMonth: MonthCoverage;
}

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
