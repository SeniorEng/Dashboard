import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Appointment, UpdateAppointment } from "@shared/schema";

type AppointmentWithCustomer = Appointment & {
  customer: {
    id: number;
    name: string;
    address: string;
    avatar: string;
    needs: string[];
  } | null;
};

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

async function updateAppointment(id: number, data: UpdateAppointment): Promise<Appointment> {
  const response = await fetch(`/api/appointments/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error("Failed to update appointment");
  }
  return response.json();
}

export function useAppointments() {
  return useQuery({
    queryKey: ["appointments"],
    queryFn: fetchAppointments,
  });
}

export function useAppointment(id: number) {
  return useQuery({
    queryKey: ["appointments", id],
    queryFn: () => fetchAppointment(id),
    enabled: !!id,
  });
}

export function useUpdateAppointment() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateAppointment }) =>
      updateAppointment(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      queryClient.invalidateQueries({ queryKey: ["appointments", variables.id] });
    },
  });
}
