import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";

export interface MonthClosingStatus {
  id: number;
  userId: number;
  year: number;
  month: number;
  closedAt: string;
  closedByUserId: number;
  reopenedAt: string | null;
  reopenedByUserId: number | null;
}

export interface AutoBreakPreview {
  date: string;
  totalWorkMinutes: number;
  existingBreakMinutes: number;
  requiredBreakMinutes: number;
  autoBreakMinutes: number;
}

export interface OpenAppointment {
  id: number;
  date: string;
  scheduledStart: string | null;
  status: string;
  customerName: string;
}

export interface MonthClosingReadiness {
  ready: boolean;
  openAppointments: OpenAppointment[];
  unsignedAppointments: OpenAppointment[];
  hasTimeEntries: boolean;
  timeEntryCount: number;
}

export interface AdminEmployeeReadiness extends MonthClosingReadiness {
  userId: number;
  displayName: string;
  isClosed: boolean;
  closingId: number | null;
}

export function useMonthClosingStatus(year: number, month: number) {
  return useQuery<{ closing: MonthClosingStatus | null }>({
    queryKey: ["month-closing", year, month],
    queryFn: async () => {
      const result = await api.get<{ closing: MonthClosingStatus | null }>(`/time-entries/month-closing/${year}/${month}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
}

export function useMonthClosingReadiness(year: number, month: number, enabled: boolean) {
  return useQuery<MonthClosingReadiness>({
    queryKey: ["month-closing-readiness", year, month],
    queryFn: async () => {
      const result = await api.get<MonthClosingReadiness>(`/time-entries/month-closing/${year}/${month}/readiness`);
      return unwrapResult(result);
    },
    enabled,
    staleTime: 30000,
  });
}

export function useMonthClosingPreview(year: number, month: number, enabled: boolean) {
  return useQuery<{ autoBreaks: AutoBreakPreview[] }>({
    queryKey: ["month-closing-preview", year, month],
    queryFn: async () => {
      const result = await api.get<{ autoBreaks: AutoBreakPreview[] }>(`/time-entries/month-closing/${year}/${month}/preview`);
      return unwrapResult(result);
    },
    enabled,
    staleTime: 30000,
  });
}

export function useAdminMonthClosingReadiness(year: number, month: number) {
  return useQuery<{ employees: AdminEmployeeReadiness[] }>({
    queryKey: ["admin-month-closing-readiness", year, month],
    queryFn: async () => {
      const result = await api.get<{ employees: AdminEmployeeReadiness[] }>(
        `/time-entries/month-closings/admin/${year}/${month}/readiness`
      );
      return unwrapResult(result);
    },
    staleTime: 30000,
  });
}

export function useAdminCloseMonth() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, year, month }: { userId: number; year: number; month: number }) => {
      const result = await api.post<{ message: string; autoBreaksInserted: number }>(
        "/time-entries/admin/close-month",
        { userId, year, month }
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "time-entries");
      queryClient.invalidateQueries({ queryKey: ["admin-month-closing-readiness"] });
    },
    onError: (error: Error) => {
      console.error("[MonthClosing] Abschluss fehlgeschlagen:", error.message);
    },
  });
}

export function useAdminReopenMonth() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, year, month }: { userId: number; year: number; month: number }) => {
      const result = await api.post<{ message: string }>(
        "/time-entries/reopen-month",
        { userId, year, month }
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "time-entries");
      queryClient.invalidateQueries({ queryKey: ["admin-month-closing-readiness"] });
    },
    onError: (error: Error) => {
      console.error("[MonthClosing] Wiedereröffnung fehlgeschlagen:", error.message);
    },
  });
}

export function useAdminBatchCloseMonth() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ year, month }: { year: number; month: number }) => {
      const result = await api.post<{ message: string; closedCount: number; results: Array<{ userId: number; displayName: string; autoBreaksInserted: number }> }>(
        "/time-entries/admin/batch-close-month",
        { year, month }
      );
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "time-entries");
      queryClient.invalidateQueries({ queryKey: ["admin-month-closing-readiness"] });
    },
    onError: (error: Error) => {
      console.error("[MonthClosing] Batch-Abschluss fehlgeschlagen:", error.message);
    },
  });
}
