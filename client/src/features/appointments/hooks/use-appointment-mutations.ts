import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";

const QUERY_KEY = "appointments";

interface TravelSuggestion {
  suggestedOrigin: "home" | "appointment";
  previousAppointmentId: number | null;
  previousCustomerName: string | null;
}

export function useCreateKundentermin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.post("/appointments/kundentermin", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useCreateErstberatung() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.post("/appointments/erstberatung", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useDocumentAppointment(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.post(`/appointments/${id}/document`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY, id] });
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}/services`] });
      queryClient.invalidateQueries({ queryKey: ["time-entries"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useTravelSuggestion(appointmentId: number) {
  return useQuery<TravelSuggestion>({
    queryKey: [QUERY_KEY, appointmentId, "travel-suggestion"],
    queryFn: async () => {
      const result = await api.get<TravelSuggestion>(`/appointments/${appointmentId}/travel-suggestion`);
      return unwrapResult(result);
    },
    enabled: appointmentId > 0,
  });
}
