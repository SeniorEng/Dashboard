import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";

export type EmploymentType = "minijobber" | "sozialversicherungspflichtig";

export interface EmployeeWorkload {
  primaryCount: number;
  backupCount: number;
  backup2Count: number;
  avgMonthlyHwMinutes: number;
  avgMonthlyAllMinutes: number;
  monthsConsidered: number;
  monthlyWorkHours: number | null;
  employmentType: EmploymentType;
}

export type EmployeeWorkloadMap = Record<number, EmployeeWorkload>;

export interface EmployeeWorkloadResponse {
  workload: EmployeeWorkloadMap;
  globalAvgHoursPerCustomerPerMonth: number;
}

export const employeeWorkloadKeys = {
  all: ["admin", "employees", "workload"] as const,
};

export function useEmployeeWorkload() {
  return useQuery<EmployeeWorkloadResponse>({
    queryKey: employeeWorkloadKeys.all,
    queryFn: async ({ signal }) => {
      const result = await api.get<EmployeeWorkloadResponse>("/admin/employees/workload", signal);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
}
