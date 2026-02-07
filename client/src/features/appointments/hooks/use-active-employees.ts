import { useQuery } from "@tanstack/react-query";
import type { User as UserType } from "@shared/schema";

export function useActiveEmployees(options?: { enabled?: boolean }) {
  return useQuery<{ id: number; displayName: string }[]>({
    queryKey: ["active-employees"],
    queryFn: async () => {
      const res = await fetch("/api/appointments/active-employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
    enabled: options?.enabled ?? true,
  });
}

export function useAdminEmployees(options?: { enabled?: boolean }) {
  return useQuery<UserType[]>({
    queryKey: ["admin", "employees"],
    queryFn: async () => {
      const res = await fetch("/api/admin/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
    enabled: options?.enabled ?? true,
  });
}
