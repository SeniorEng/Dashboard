import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";
import { invalidateRelated } from "@/lib/query-invalidation";
import { submitWithRetry, type RetryAttempt } from "@/features/appointments/lib/submit-with-retry";

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

function extractCustomerId(data: unknown, fallback?: unknown): number | undefined {
  const fromData = (data as { customerId?: unknown })?.customerId;
  const id = typeof fromData === "number" ? fromData : Number(fromData);
  if (Number.isFinite(id) && id > 0) return id;
  const fallbackId = typeof fallback === "number" ? fallback : Number(fallback);
  return Number.isFinite(fallbackId) && fallbackId > 0 ? fallbackId : undefined;
}

export function useCreateKundentermin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.post("/appointments/kundentermin", data);
      return unwrapResult(result);
    },
    onSuccess: async (data, variables) => {
      const customerId = extractCustomerId(data, variables?.customerId);
      if (customerId !== undefined) {
        await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      }
      invalidateRelated(queryClient, "appointments", ...(customerId !== undefined ? [{ customerId }] : []));
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
      const result = await api.post("/appointments/prospect-erstberatung", data);
      return unwrapResult(result);
    },
    onSuccess: async (data) => {
      const customerId = extractCustomerId(data);
      if (customerId !== undefined) {
        await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      }
      invalidateRelated(queryClient, "appointments", ...(customerId !== undefined ? [{ customerId }] : []));
      invalidateRelated(queryClient, "prospects");
      toast({ title: "Erfolg", description: "Erstberatung wurde erstellt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export interface DocumentAppointmentOptions {
  /**
   * Wird bei jedem automatischen Retry aufgerufen — z.B. um Telemetrie/Audit
   * über transient gescheiterte Submits auf Mobilfunk zu erfassen.
   */
  onRetry?: (info: RetryAttempt) => void;
}

export function useDocumentAppointment(id: number, options: DocumentAppointmentOptions = {}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { onRetry } = options;
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      // Mobile-Doku (#490): Bei flackernder LTE-Verbindung darf der finale
      // Submit nicht lautlos verloren gehen. `submitWithRetry` versucht bei
      // Netzwerk-/5xx-Fehlern bis zu 2× erneut (Gesamt 3 Versuche). Fachliche
      // 4xx-Fehler werden NIE retried (ALREADY_COMPLETED, SIGNATURE_LOCKED,
      // Validation), damit die Server-Antwort sauber beim Aufrufer ankommt.
      const { data: response } = await submitWithRetry(
        (attempt) =>
          api.post(`/appointments/${id}/document`, data, {
            headers: { "X-Submit-Attempt": String(attempt) },
          }),
        { onRetry },
      );
      return response;
    },
    onSuccess: async (data) => {
      const customerId = extractCustomerId(data);
      if (customerId !== undefined) {
        await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      }
      invalidateRelated(queryClient, "appointments", ...(customerId !== undefined ? [{ customerId }] : []));
      // invalidate-direct-allowed: appointment-scoped services key not covered by a domain
      // eslint-disable-next-line no-restricted-syntax
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}/services`] });
      toast({ title: "Erfolg", description: "Termin wurde dokumentiert" });
    },
    onError: (error: Error) => {
      // Toast bleibt als zusätzliches Signal — der persistente Fehler-Banner
      // im Formular ist die primäre Anzeige (siehe `useDocumentationForm`).
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

/**
 * Task #485 — Customer-No-Show Mutation: schreibt den Termin auf Status
 * `customer_no_show`, ohne §45b-Budget zu verbrauchen. Antwort enthält
 * `noShowCharge` (Vorschau, was dem Kunden privat berechnet wird).
 */
export function useDocumentNoShow(id: number) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.post(`/appointments/${id}/document-no-show`, data);
      return unwrapResult(result);
    },
    onSuccess: async (data) => {
      const customerId = extractCustomerId(data);
      if (customerId !== undefined) {
        await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      }
      invalidateRelated(queryClient, "appointments", ...(customerId !== undefined ? [{ customerId }] : []));
      // invalidate-direct-allowed: appointment-scoped services key not covered by a domain
      // eslint-disable-next-line no-restricted-syntax
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}/services`] });
      toast({ title: "Gespeichert", description: "Vergebliche Anfahrt wurde dokumentiert." });
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
