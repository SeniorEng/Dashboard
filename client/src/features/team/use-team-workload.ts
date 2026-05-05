import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";

export interface TeamWorkloadEmployee {
  id: number;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  telefon: string | null;
  roles: string[];
  isActive: boolean;
  isTeamLead: boolean;
}

export interface TeamWorkloadEntry {
  primaryCount: number;
  backupCount: number;
  backup2Count: number;
  avgMonthlyHwMinutes: number;
  avgMonthlyAllMinutes: number;
}

export interface TeamWorkloadResponse {
  employees: TeamWorkloadEmployee[];
  workload: Record<number, TeamWorkloadEntry>;
}

export function useTeamWorkload(options?: { enabled?: boolean }) {
  return useQuery<TeamWorkloadResponse>({
    queryKey: ["team", "workload"],
    queryFn: async ({ signal }) => {
      const result = await api.get<TeamWorkloadResponse>("/team/workload", signal);
      return unwrapResult(result);
    },
    staleTime: 60000,
    enabled: options?.enabled ?? true,
  });
}
