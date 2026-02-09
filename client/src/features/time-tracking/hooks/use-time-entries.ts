/**
 * Time Entry Hooks
 * 
 * React Query hooks for fetching and managing employee time entries.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { 
  TimeEntry, 
  CreateTimeEntryRequest, 
  UpdateTimeEntryRequest,
  VacationSummary,
  TimeOverviewData,
  TimesPageData 
} from "@/lib/api/types";

export const timeEntryKeys = {
  all: ["time-entries"] as const,
  list: (year?: number, month?: number) => [...timeEntryKeys.all, "list", { year, month }] as const,
  detail: (id: number) => [...timeEntryKeys.all, "detail", id] as const,
  vacationSummary: (year: number) => [...timeEntryKeys.all, "vacation-summary", year] as const,
  overview: (year: number, month: number) => [...timeEntryKeys.all, "overview", { year, month }] as const,
  openTasks: [...["time-entries"], "open-tasks"] as const,
};

export interface TimeEntryFilters {
  year?: number;
  month?: number;
  entryType?: string;
}

/**
 * Fetch time entries for the authenticated user
 */
export function useTimeEntries(filters?: TimeEntryFilters) {
  const queryParams = new URLSearchParams();
  if (filters?.year) queryParams.set("year", filters.year.toString());
  if (filters?.month) queryParams.set("month", filters.month.toString());
  if (filters?.entryType) queryParams.set("entryType", filters.entryType);
  
  const queryString = queryParams.toString();
  const endpoint = queryString ? `/time-entries?${queryString}` : "/time-entries";
  
  return useQuery({
    queryKey: timeEntryKeys.list(filters?.year, filters?.month),
    queryFn: async ({ signal }) => {
      const result = await api.get<TimeEntry[]>(endpoint, signal);
      return unwrapResult(result);
    },
  });
}

/**
 * Fetch a specific time entry
 */
export function useTimeEntry(id: number) {
  return useQuery({
    queryKey: timeEntryKeys.detail(id),
    queryFn: async ({ signal }) => {
      const result = await api.get<TimeEntry>(`/time-entries/${id}`, signal);
      return unwrapResult(result);
    },
    enabled: id > 0,
  });
}

/**
 * Fetch vacation summary for a year
 */
export function useVacationSummary(year: number) {
  return useQuery({
    queryKey: timeEntryKeys.vacationSummary(year),
    queryFn: async ({ signal }) => {
      const result = await api.get<VacationSummary>(`/time-entries/vacation-summary/${year}`, signal);
      return unwrapResult(result);
    },
    enabled: year >= 2020 && year <= 2100,
    staleTime: 60000,
  });
}

/**
 * Create a new time entry
 */
export function useCreateTimeEntry() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: CreateTimeEntryRequest) => {
      const result = await api.post<TimeEntry>("/time-entries", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: timeEntryKeys.all });
      queryClient.invalidateQueries({ queryKey: timeEntryKeys.openTasks, refetchType: "all" });
    },
  });
}

/**
 * Update a time entry
 */
export function useUpdateTimeEntry() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: UpdateTimeEntryRequest }) => {
      const result = await api.put<TimeEntry>(`/time-entries/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: timeEntryKeys.all });
    },
  });
}

/**
 * Delete a time entry
 */
export function useDeleteTimeEntry() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete(`/time-entries/${id}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: timeEntryKeys.all });
      queryClient.invalidateQueries({ queryKey: timeEntryKeys.openTasks, refetchType: "all" });
    },
  });
}

/**
 * Fetch complete time overview for a month (appointments + time entries)
 */
export function useTimeOverview(year: number, month: number) {
  return useQuery({
    queryKey: timeEntryKeys.overview(year, month),
    queryFn: async ({ signal }) => {
      const result = await api.get<TimeOverviewData>(`/time-entries/overview/${year}/${month}`, signal);
      return unwrapResult(result);
    },
    enabled: year >= 2020 && year <= 2100 && month >= 1 && month <= 12,
    staleTime: 30000,
  });
}

/**
 * Fetch all page data for My Times in a single API call
 * Combines: overview + vacation-summary + open-tasks
 */
export function useTimesPageData(year: number, month: number) {
  return useQuery({
    queryKey: [...timeEntryKeys.all, "page-data", { year, month }] as const,
    queryFn: async ({ signal }) => {
      const result = await api.get<TimesPageData>(`/time-entries/page-data/${year}/${month}`, signal);
      return unwrapResult(result);
    },
    enabled: year >= 2020 && year <= 2100 && month >= 1 && month <= 12,
    staleTime: 30000,
  });
}
