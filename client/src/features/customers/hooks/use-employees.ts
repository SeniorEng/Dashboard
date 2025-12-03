/**
 * Employee Hooks
 * 
 * React Query hooks for employee data fetching.
 */

import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { EmployeeListItem } from "@/lib/api/types";

export const employeeKeys = {
  all: ["employees"] as const,
  list: () => [...employeeKeys.all, "list"] as const,
};

/**
 * Fetch all employees (for dropdowns, assignments, etc.)
 */
export function useEmployees() {
  return useQuery({
    queryKey: employeeKeys.list(),
    queryFn: async ({ signal }) => {
      const result = await api.get<EmployeeListItem[]>("/admin/employees", signal);
      return unwrapResult(result);
    },
    staleTime: 60000, // Employees don't change often
  });
}
