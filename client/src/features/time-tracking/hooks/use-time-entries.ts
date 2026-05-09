/**
 * Time Entry Hooks
 * 
 * React Query hooks for fetching and managing employee time entries.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";
import type {
  TimeEntry,
  CreateTimeEntryRequest,
  UpdateTimeEntryRequest,
  TimeOverviewData,
} from "@/lib/api/types";

const timeEntryKeys = {
  all: ["time-entries"] as const,
  list: (year?: number, month?: number, viewAsEmployeeId?: number | null) => [...timeEntryKeys.all, "list", { year, month, viewAsEmployeeId }] as const,
  detail: (id: number) => [...timeEntryKeys.all, "detail", id] as const,
  byDate: (date: string, viewAsEmployeeId?: number | null) => [...timeEntryKeys.all, "by-date", date, { viewAsEmployeeId }] as const,
  overview: (year: number, month: number) => [...timeEntryKeys.all, "overview", { year, month }] as const,
  openTasks: [...["time-entries"], "open-tasks"] as const,
};

function appendViewAs(endpoint: string, viewAsEmployeeId?: number | null): string {
  if (!viewAsEmployeeId) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}viewAsEmployeeId=${viewAsEmployeeId}`;
}

export interface TimeEntryFilters {
  year?: number;
  month?: number;
  entryType?: string;
}

/**
 * Fetch time entries for the authenticated user
 */
function useTimeEntries(filters?: TimeEntryFilters) {
  const { viewAsEmployeeId } = useViewAsEmployee();
  const queryParams = new URLSearchParams();
  if (filters?.year) queryParams.set("year", filters.year.toString());
  if (filters?.month) queryParams.set("month", filters.month.toString());
  if (filters?.entryType) queryParams.set("entryType", filters.entryType);
  if (viewAsEmployeeId) queryParams.set("viewAsEmployeeId", viewAsEmployeeId.toString());
  
  const queryString = queryParams.toString();
  const endpoint = queryString ? `/time-entries?${queryString}` : "/time-entries";
  
  return useQuery({
    queryKey: timeEntryKeys.list(filters?.year, filters?.month, viewAsEmployeeId),
    queryFn: async ({ signal }) => {
      const result = await api.get<TimeEntry[]>(endpoint, signal);
      return unwrapResult(result);
    },
  });
}

/**
 * Fetch a specific time entry
 */
function useTimeEntry(id: number) {
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
 * Create a new time entry
 */
export function useCreateTimeEntry() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  return useMutation({
    mutationFn: async (data: CreateTimeEntryRequest) => {
      const result = await api.post<TimeEntry>("/time-entries", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "time-entries");
      toast({ title: "Erfolg", description: "Zeiteintrag wurde erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

/**
 * Update a time entry
 */
export function useUpdateTimeEntry() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: UpdateTimeEntryRequest }) => {
      const result = await api.put<TimeEntry>(`/time-entries/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "time-entries");
      toast({ title: "Erfolg", description: "Zeiteintrag wurde aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

/**
 * Delete a time entry
 */
export function useDeleteTimeEntry() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete(`/time-entries/${id}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "time-entries");
      toast({ title: "Erfolg", description: "Zeiteintrag wurde gelöscht" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

/**
 * Fetch complete time overview for a month (appointments + time entries)
 */
function useTimeOverview(year: number, month: number) {
  const { viewAsEmployeeId } = useViewAsEmployee();
  return useQuery({
    queryKey: [...timeEntryKeys.overview(year, month), { viewAsEmployeeId }],
    queryFn: async ({ signal }) => {
      const result = await api.get<TimeOverviewData>(appendViewAs(`/time-entries/overview/${year}/${month}`, viewAsEmployeeId), signal);
      return unwrapResult(result);
    },
    enabled: year >= 2020 && year <= 2100 && month >= 1 && month <= 12,
    staleTime: 30000,
  });
}

/**
 * Fetch time entries for a specific day
 */
export function useDayTimeEntries(date: string) {
  const { viewAsEmployeeId } = useViewAsEmployee();
  return useQuery({
    queryKey: timeEntryKeys.byDate(date, viewAsEmployeeId),
    queryFn: async ({ signal }) => {
      const result = await api.get<TimeEntry[]>(appendViewAs(`/time-entries/by-date/${date}`, viewAsEmployeeId), signal);
      return unwrapResult(result);
    },
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
    staleTime: 30000,
  });
}
