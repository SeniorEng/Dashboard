import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";

const QUERY_KEY = "appointments";

interface TravelSuggestion {
  suggestedOrigin: "home" | "appointment";
  previousAppointmentId: number | null;
  previousCustomerName: string | null;
  suggestedKilometers: number | null;
  suggestedMinutes: number | null;
}

interface RouteCalculationResult {
  suggestedKilometers: number | null;
  suggestedMinutes: number | null;
}

export function useCreateKundentermin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.post("/appointments/kundentermin", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      queryClient.invalidateQueries({ queryKey: ["budget-overview"] });
      queryClient.invalidateQueries({ queryKey: ["budget-summary"] });
      toast({ title: "Erfolg", description: "Termin wurde erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useCreateErstberatung() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.post("/appointments/erstberatung", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      toast({ title: "Erfolg", description: "Erstberatung wurde erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useDocumentAppointment(id: number) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
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
      toast({ title: "Erfolg", description: "Termin wurde dokumentiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
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

export function useRouteCalculation(
  appointmentId: number,
  originType: "home" | "appointment",
  fromAppointmentId: number | null,
  enabled: boolean
) {
  return useQuery<RouteCalculationResult>({
    queryKey: [QUERY_KEY, appointmentId, "route-calculation", originType, fromAppointmentId],
    queryFn: async () => {
      const params = new URLSearchParams({ originType });
      if (fromAppointmentId) params.set("fromAppointmentId", fromAppointmentId.toString());
      const result = await api.get<RouteCalculationResult>(`/appointments/${appointmentId}/route-calculation?${params}`);
      return unwrapResult(result);
    },
    enabled: enabled && appointmentId > 0,
    staleTime: 5 * 60 * 1000,
  });
}
