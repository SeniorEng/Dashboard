import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";

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
  scheduledStart: string;
  status: string;
  customerName: string;
}

export interface MonthClosingReadiness {
  ready: boolean;
  openAppointments: OpenAppointment[];
  hasTimeEntries: boolean;
  timeEntryCount: number;
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

export function useCloseMonth() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ year, month }: { year: number; month: number }) => {
      const result = await api.post<{ message: string; autoBreaksInserted: number }>(
        "/time-entries/close-month",
        { year, month }
      );
      return unwrapResult(result);
    },
    onSuccess: (_, { year, month }) => {
      queryClient.invalidateQueries({ queryKey: ["month-closing", year, month] });
      queryClient.invalidateQueries({ queryKey: ["month-closing-readiness", year, month] });
      queryClient.invalidateQueries({ queryKey: ["time-overview"] });
      queryClient.invalidateQueries({ queryKey: ["open-tasks"] });
    },
  });
}
