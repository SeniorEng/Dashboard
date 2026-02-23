import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { User as UserType } from "@shared/schema";

export function useActiveEmployees(options?: { enabled?: boolean }) {
  return useQuery<{ id: number; displayName: string }[]>({
    queryKey: ["active-employees"],
    queryFn: async () => {
      const result = await api.get<{ id: number; displayName: string }[]>("/appointments/active-employees");
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
