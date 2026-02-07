import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppointmentWithCustomer, UpdateAppointmentPayload } from "@shared/types";
import type { Appointment } from "@shared/schema";
import { api, unwrapResult } from "@/lib/api/client";

const QUERY_KEY = "appointments";

async function fetchAppointments(date?: string): Promise<AppointmentWithCustomer[]> {
  const url = date ? `/api/appointments?date=${date}` : "/api/appointments";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Failed to fetch appointments");
  }
  return response.json();
}

async function fetchAppointment(id: number): Promise<AppointmentWithCustomer> {
  const response = await fetch(`/api/appointments/${id}`);
  if (!response.ok) {
    throw new Error("Failed to fetch appointment");
  }
  return response.json();
}

async function updateAppointment(id: number, data: UpdateAppointmentPayload): Promise<Appointment> {
  const result = await api.patch<Appointment>(`/appointments/${id}`, data);
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
  const response = await fetch(`/api/appointments/counts?dates=${dates.join(",")}`);
  if (!response.ok) {
    const counts: Record<string, number> = {};
    for (const d of dates) counts[d] = 0;
    return counts;
  }
  return response.json();
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

export function useUpdateAppointment() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateAppointmentPayload }) =>
      updateAppointment(id, data),
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: [QUERY_KEY] });
      await queryClient.cancelQueries({ queryKey: [QUERY_KEY, id] });
      
      const previousAppointment = queryClient.getQueryData<AppointmentWithCustomer>([QUERY_KEY, id]);
      
      if (previousAppointment) {
        queryClient.setQueryData<AppointmentWithCustomer>([QUERY_KEY, id], {
          ...previousAppointment,
          ...data,
        });
      }
      
      return { previousAppointment };
    },
    onError: (err, { id }, context) => {
      if (context?.previousAppointment) {
        queryClient.setQueryData([QUERY_KEY, id], context.previousAppointment);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
  });
}

export function useDeleteAppointment() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (id: number) => deleteAppointment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
  });
}
