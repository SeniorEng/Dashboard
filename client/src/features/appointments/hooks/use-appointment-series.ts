import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";
import { invalidateRelated } from "@/lib/query-invalidation";
import type { AppointmentSeries, Weekday, SeriesFrequency } from "@shared/schema/appointments";

const SERIES_QUERY_KEY = "appointment-series";

export interface SeriesWithDetails extends AppointmentSeries {
  customerName?: string;
  employeeName?: string;
  remainingCount?: number;
  totalCount?: number;
}

export interface SeriesDetailResponse {
  series: AppointmentSeries & { customerName: string };
  appointments: Array<{
    id: number;
    date: string;
    status: string;
    isSeriesException: boolean;
  }>;
  counts: {
    total: number;
    future: number;
    completed: number;
  };
}

export function useAppointmentSeriesList(customerId?: number) {
  return useQuery<SeriesWithDetails[]>({
    queryKey: [SERIES_QUERY_KEY, "list", customerId],
    queryFn: async () => {
      const params = customerId ? `?customerId=${customerId}` : "";
      const result = await api.get<SeriesWithDetails[]>(`/appointment-series${params}`);
      return unwrapResult(result);
    },
    staleTime: 30_000,
  });
}

export function useAppointmentSeriesDetail(id: number) {
  return useQuery<SeriesDetailResponse>({
    queryKey: [SERIES_QUERY_KEY, "detail", id],
    queryFn: async () => {
      const result = await api.get<SeriesDetailResponse>(`/appointment-series/${id}`);
      return unwrapResult(result);
    },
    enabled: id > 0,
    staleTime: 30_000,
  });
}

export interface SeriesCreateInput {
  customerId: number;
  assignedEmployeeId: number;
  frequency: SeriesFrequency;
  weekdays: Weekday[];
  scheduledStart: string;
  durationMinutes: number;
  services: Array<{ serviceId: number; durationMinutes: number }>;
  startDate: string;
  endDate: string;
  notes?: string;
}

interface SeriesPreviewResponse {
  valid: boolean;
  totalDates: number;
  validDates: number;
  skippedDates: Array<{ date: string; skipped: boolean; reason?: string }>;
  conflicts: Array<{ date: string; reason: string }>;
  error: string | null;
}

interface SeriesCreateResponse {
  series: { id: number };
  createdAppointments: number;
  skippedDates?: Array<{ date: string; skipped: boolean; reason?: string }>;
  conflicts?: Array<{ date: string; reason: string }>;
  _budgetWarning?: string;
}

export function usePreviewAppointmentSeries() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: SeriesCreateInput): Promise<SeriesPreviewResponse> => {
      const result = await api.post<SeriesPreviewResponse>("/appointment-series/preview", data);
      return unwrapResult(result);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Serienvorschau konnte nicht geladen werden", variant: "destructive" });
    },
  });
}

export function useCreateAppointmentSeries() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: SeriesCreateInput): Promise<SeriesCreateResponse> => {
      const result = await api.post<SeriesCreateResponse>("/appointment-series", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "appointment-series");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Terminserie konnte nicht erstellt werden", variant: "destructive" });
    },
  });
}

export function useUpdateSeriesAppointment(seriesId: number) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: {
      appointmentId: number;
      mode: "single" | "this_and_future" | "all_future";
      date?: string;
      scheduledStart?: string;
      assignedEmployeeId?: number;
      notes?: string;
    }) => {
      const { appointmentId, ...body } = data;
      const result = await api.post(`/appointment-series/${seriesId}/appointments/${appointmentId}/update`, body);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "appointment-series");
      toast({ title: "Erfolg", description: "Serientermine wurden aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useDeleteSeriesAppointment(seriesId: number) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: {
      appointmentId: number;
      mode: "single" | "this_and_future" | "all_future";
    }) => {
      const { appointmentId, ...body } = data;
      const result = await api.post(`/appointment-series/${seriesId}/appointments/${appointmentId}/cancel`, body);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "appointment-series");
      toast({ title: "Erfolg", description: "Serientermine wurden abgesagt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useExtendSeries() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ id, newEndDate }: { id: number; newEndDate: string }) => {
      const result = await api.post(`/appointment-series/${id}/extend`, { newEndDate });
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "appointment-series");
      toast({ title: "Erfolg", description: "Serie wurde verlängert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useShortenSeries() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ id, newEndDate }: { id: number; newEndDate: string }) => {
      const result = await api.post(`/appointment-series/${id}/shorten`, { newEndDate });
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "appointment-series");
      toast({ title: "Erfolg", description: "Serie wurde verkürzt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useEndSeries() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete(`/appointment-series/${id}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "appointment-series");
      toast({ title: "Erfolg", description: "Serie wurde beendet" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export const WEEKDAY_LABELS: Record<string, string> = {
  mo: "Mo",
  di: "Di",
  mi: "Mi",
  do: "Do",
  fr: "Fr",
};

export const WEEKDAY_FULL_LABELS: Record<string, string> = {
  mo: "Montag",
  di: "Dienstag",
  mi: "Mittwoch",
  do: "Donnerstag",
  fr: "Freitag",
};

export function formatWeekdays(weekdays: string[]): string {
  return weekdays.map(d => WEEKDAY_LABELS[d] || d).join(" & ");
}

export function formatSeriesInfo(series: { weekdays: string[]; frequency: string; endDate: string }): string {
  const days = formatWeekdays(series.weekdays);
  const freq = series.frequency === "biweekly" ? "alle 2 Wochen" : "wöchentlich";
  const endFormatted = new Date(series.endDate + "T00:00:00").toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return `${days} · ${freq} · bis ${endFormatted}`;
}
