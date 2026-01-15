/**
 * Open Tasks Hook
 * 
 * Fetches open tasks like missing break documentation.
 */

import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { timeEntryKeys } from "./use-time-entries";

export interface MissingBreakDay {
  date: string;
  totalWorkMinutes: number;
  requiredBreakMinutes: number;
  documentedBreakMinutes: number;
}

export interface OpenTasksData {
  daysWithMissingBreaks: MissingBreakDay[];
}

export function useOpenTasks() {
  return useQuery({
    queryKey: timeEntryKeys.openTasks,
    queryFn: async ({ signal }) => {
      const result = await api.get<OpenTasksData>("/time-entries/open-tasks", signal);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
}
