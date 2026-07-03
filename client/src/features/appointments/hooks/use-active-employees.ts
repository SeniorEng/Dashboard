import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { UserWithRoles as UserType } from "@shared/schema";

export interface ActiveEmployeeListItem {
  id: number;
  displayName: string;
  isTeamLead: boolean;
  roles: string[];
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

export interface EmployeeNameItem {
  id: number;
  displayName: string;
}

/**
 * Löst Anzeigenamen für konkrete Mitarbeiter-IDs auf – auch für deaktivierte
 * Mitarbeiter, die nicht mehr in der Aktiv-Liste enthalten sind. Liefert nur
 * id + displayName.
 */
export function useEmployeeNames(ids: number[], options?: { enabled?: boolean }) {
  const uniqueSorted = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0))).sort((a, b) => a - b);
  return useQuery<EmployeeNameItem[]>({
    queryKey: ["employee-names", uniqueSorted],
    queryFn: async () => {
      const result = await api.get<EmployeeNameItem[]>(`/appointments/employee-names?ids=${uniqueSorted.join(",")}`);
      return unwrapResult(result);
    },
    enabled: (options?.enabled ?? true) && uniqueSorted.length > 0,
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
