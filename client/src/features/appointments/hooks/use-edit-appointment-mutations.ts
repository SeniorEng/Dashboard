import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppointmentWithCustomer } from "@shared/types";
import { api, unwrapResult } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";
import { invalidateRelated } from "@/lib/query-invalidation";

interface UseEditAppointmentMutationsArgs {
  id: number;
  appointment: AppointmentWithCustomer | undefined;
  setLocation: (path: string) => void;
  setShowSeriesEditDialog: (open: boolean) => void;
}

export function useEditAppointmentMutations({
  id,
  appointment,
  setLocation,
  setShowSeriesEditDialog,
}: UseEditAppointmentMutationsArgs) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.patch(`/appointments/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: async () => {
      const customerId = appointment?.customerId;
      if (typeof customerId === "number" && customerId > 0) {
        await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      }
      invalidateRelated(
        queryClient,
        "appointments",
        ...(typeof customerId === "number" && customerId > 0 ? [{ customerId }] : []),
      );
      toast({ title: "Termin aktualisiert", description: "Die Änderungen wurden gespeichert." });
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const updateProspectMutation = useMutation({
    mutationFn: async ({ prospectId, data }: { prospectId: number; data: Record<string, unknown> }) => {
      // Bewusst der nicht-Admin-Endpunkt: Teamleitungen mit Erstberatungs-
      // Rolle dürfen Stammdaten aktualisieren, der Admin-Endpunkt würde sie
      // mit 403 abweisen und damit auch das nachgelagerte Termin-Update
      // blockieren.
      const result = await api.patch(`/prospects/${prospectId}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "prospects");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Interessentendaten konnten nicht aktualisiert werden", variant: "destructive" });
    },
  });

  const seriesUpdateMutation = useMutation({
    mutationFn: async (data: { mode: "single" | "this_and_future" | "all_future"; updateFields: Record<string, unknown> }) => {
      const seriesId = appointment?.seriesId;
      if (!seriesId) throw new Error("Kein Serien-ID");
      const result = await api.post(`/appointment-series/${seriesId}/appointments/${id}/update`, {
        mode: data.mode,
        ...data.updateFields,
      });
      return unwrapResult(result);
    },
    onSuccess: async () => {
      const customerId = appointment?.customerId;
      if (typeof customerId === "number" && customerId > 0) {
        await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      }
      invalidateRelated(
        queryClient,
        "appointments",
        "appointment-series",
        ...(typeof customerId === "number" && customerId > 0 ? [{ customerId }] : []),
      );
      toast({ title: "Serientermine aktualisiert" });
      setShowSeriesEditDialog(false);
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  return { updateMutation, updateProspectMutation, seriesUpdateMutation };
}
