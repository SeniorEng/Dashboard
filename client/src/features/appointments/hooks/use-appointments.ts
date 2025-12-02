import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppointmentWithCustomer, UpdateAppointmentPayload } from "@shared/types";
import type { Appointment } from "@shared/schema";

const QUERY_KEY = "appointments";

async function fetchAppointments(): Promise<AppointmentWithCustomer[]> {
  const response = await fetch("/api/appointments");
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
  const response = await fetch(`/api/appointments/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error("Failed to update appointment");
  }
  return response.json();
}

export function useAppointments() {
  return useQuery({
    queryKey: [QUERY_KEY],
    queryFn: fetchAppointments,
    staleTime: 30000, // Consider data fresh for 30 seconds
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
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: [QUERY_KEY] });
      await queryClient.cancelQueries({ queryKey: [QUERY_KEY, id] });
      
      // Snapshot the previous value
      const previousAppointment = queryClient.getQueryData<AppointmentWithCustomer>([QUERY_KEY, id]);
      const previousAppointments = queryClient.getQueryData<AppointmentWithCustomer[]>([QUERY_KEY]);
      
      // Optimistically update single appointment
      if (previousAppointment) {
        queryClient.setQueryData<AppointmentWithCustomer>([QUERY_KEY, id], {
          ...previousAppointment,
          ...data,
        });
      }
      
      // Optimistically update list
      if (previousAppointments) {
        queryClient.setQueryData<AppointmentWithCustomer[]>([QUERY_KEY], 
          previousAppointments.map(apt => 
            apt.id === id ? { ...apt, ...data } : apt
          )
        );
      }
      
      return { previousAppointment, previousAppointments };
    },
    onError: (err, { id }, context) => {
      // Rollback on error
      if (context?.previousAppointment) {
        queryClient.setQueryData([QUERY_KEY, id], context.previousAppointment);
      }
      if (context?.previousAppointments) {
        queryClient.setQueryData([QUERY_KEY], context.previousAppointments);
      }
    },
    onSettled: (_, __, { id }) => {
      // Always refetch after error or success
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY, id] });
    },
  });
}
