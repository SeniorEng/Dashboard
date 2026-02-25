import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";
import type { Prospect, ProspectNote, InsertProspect, UpdateProspect, InsertProspectNote } from "@shared/schema";

type ProspectWithNotes = Prospect & { notes: ProspectNote[] };

export function useProspects(filters?: { status?: string; search?: string }) {
  return useQuery<Prospect[]>({
    queryKey: ["prospects", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.status) params.set("status", filters.status);
      if (filters?.search) params.set("search", filters.search);
      const result = await api.get<Prospect[]>(`/admin/prospects?${params}`);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });
}

export function useProspect(id: number | null) {
  return useQuery<ProspectWithNotes>({
    queryKey: ["prospect", id],
    queryFn: async () => {
      const result = await api.get<ProspectWithNotes>(`/admin/prospects/${id}`);
      return unwrapResult(result);
    },
    enabled: !!id,
  });
}

export function useProspectStats() {
  return useQuery<Record<string, number>>({
    queryKey: ["prospect-stats"],
    queryFn: async () => {
      const result = await api.get<Record<string, number>>("/admin/prospects/stats");
      return unwrapResult(result);
    },
    staleTime: 30000,
  });
}

export function useCreateProspect() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: InsertProspect) => {
      const result = await api.post<Prospect>("/admin/prospects", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prospects"] });
      queryClient.invalidateQueries({ queryKey: ["prospect-stats"] });
      toast({ title: "Interessent erstellt", description: "Der Interessent wurde erfolgreich angelegt." });
    },
    onError: () => {
      toast({ title: "Fehler", description: "Der Interessent konnte nicht erstellt werden.", variant: "destructive" });
    },
  });
}

export function useUpdateProspect() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: UpdateProspect }) => {
      const result = await api.patch<Prospect>(`/admin/prospects/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prospects"] });
      queryClient.invalidateQueries({ queryKey: ["prospect-stats"] });
      toast({ title: "Gespeichert", description: "Die Änderungen wurden gespeichert." });
    },
    onError: () => {
      toast({ title: "Fehler", description: "Die Änderungen konnten nicht gespeichert werden.", variant: "destructive" });
    },
  });
}

export function useAddProspectNote() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ prospectId, data }: { prospectId: number; data: Omit<InsertProspectNote, "prospectId"> }) => {
      const result = await api.post<ProspectNote>(`/admin/prospects/${prospectId}/notes`, data);
      return unwrapResult(result);
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["prospect", vars.prospectId] });
      toast({ title: "Notiz hinzugefügt" });
    },
    onError: () => {
      toast({ title: "Fehler", description: "Die Notiz konnte nicht gespeichert werden.", variant: "destructive" });
    },
  });
}

export function useReparseProspect() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.post<ProspectWithNotes>(`/admin/prospects/${id}/reparse`, {});
      return unwrapResult(result);
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["prospect", id] });
      queryClient.invalidateQueries({ queryKey: ["prospects"] });
      toast({ title: "Neu geparst", description: "Die Daten wurden aus der E-Mail aktualisiert." });
    },
    onError: () => {
      toast({ title: "Fehler", description: "Die E-Mail konnte nicht neu geparst werden.", variant: "destructive" });
    },
  });
}

export function useDeleteProspect() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete<{ success: boolean }>(`/admin/prospects/${id}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prospects"] });
      queryClient.invalidateQueries({ queryKey: ["prospect-stats"] });
      toast({ title: "Gelöscht", description: "Der Interessent wurde entfernt." });
    },
    onError: () => {
      toast({ title: "Fehler", description: "Der Interessent konnte nicht gelöscht werden.", variant: "destructive" });
    },
  });
}
