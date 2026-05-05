import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";

export interface EmployeeWorkload {
  primaryCount: number;
  backupCount: number;
  backup2Count: number;
  avgMonthlyHwMinutes: number;
  avgMonthlyAllMinutes: number;
  monthsConsidered: number;
}

export type EmployeeWorkloadMap = Record<number, EmployeeWorkload>;

export const employeeWorkloadKeys = {
  all: ["admin", "employees", "workload"] as const,
};

export function useEmployeeWorkload() {
  return useQuery<EmployeeWorkloadMap>({
    queryKey: employeeWorkloadKeys.all,
    queryFn: async ({ signal }) => {
      const result = await api.get<EmployeeWorkloadMap>("/admin/employees/workload", signal);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
}
