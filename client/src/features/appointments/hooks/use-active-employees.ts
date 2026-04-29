import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { UserWithRoles as UserType } from "@shared/schema";

export interface ActiveEmployeeListItem {
  id: number;
  displayName: string;
  isTeamLead: boolean;
}

export function useActiveEmployees(options?: { enabled?: boolean }) {
  return useQuery<ActiveEmployeeListItem[]>({
    queryKey: ["active-employees"],
    queryFn: async () => {
      const result = await api.get<ActiveEmployeeListItem[]>("/appointments/active-employees");
      return unwrapResult(result);
    },
    enabled: options?.enabled ?? true,
  });
}

export function useAdminEmployees(options?: { enabled?: boolean }) {
  return useQuery<UserType[]>({
    queryKey: ["admin", "employees"],
    queryFn: async () => {
      const result = await api.get<UserType[]>("/admin/employees");
      return unwrapResult(result);
    },
    enabled: options?.enabled ?? true,
  });
}
