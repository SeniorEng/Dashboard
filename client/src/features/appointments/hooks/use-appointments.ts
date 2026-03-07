import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppointmentWithCustomer } from "@shared/types";
import { api, unwrapResult } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";

const QUERY_KEY = "appointments";

async function fetchAppointments(date?: string): Promise<AppointmentWithCustomer[]> {
  const endpoint = date ? `/appointments?date=${date}` : "/appointments";
  const result = await api.get<AppointmentWithCustomer[]>(endpoint);
  return unwrapResult(result);
}

async function fetchAppointment(id: number): Promise<AppointmentWithCustomer> {
  const result = await api.get<AppointmentWithCustomer>(`/appointments/${id}`);
  return unwrapResult(result);
}

async function deleteAppointment(id: number): Promise<void> {
  const result = await api.delete(`/appointments/${id}`);
  unwrapResult(result);
}

export function useAppointments(date?: string) {
  return useQuery({
    queryKey: date ? [QUERY_KEY, { date }] : [QUERY_KEY],
    queryFn: () => fetchAppointments(date),
    staleTime: 30000,
  });
}

async function fetchAppointmentCounts(dates: string[]): Promise<Record<string, number>> {
  const result = await api.get<Record<string, number>>(`/appointments/counts?dates=${dates.join(",")}`);
  return unwrapResult(result);
}

export function useWeekAppointmentCounts(dates: string[]) {
  return useQuery({
    queryKey: [QUERY_KEY, "week-counts", dates.join(",")],
    queryFn: () => fetchAppointmentCounts(dates),
    staleTime: 30000,
    enabled: dates.length > 0,
  });
}

export function useAppointment(id: number) {
  return useQuery({
    queryKey: [QUERY_KEY, id],
    queryFn: () => fetchAppointment(id),
    enabled: id > 0,
    staleTime: 30000,
  });
}

export function useDeleteAppointment() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  return useMutation({
    mutationFn: (id: number) => deleteAppointment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      toast({ title: "Erfolg", description: "Termin wurde gelöscht" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}
