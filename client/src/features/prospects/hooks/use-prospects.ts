import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
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
    mutationFn: async (data: InsertProspect & { _initialNote?: string }) => {
      const result = await api.post<Prospect>("/admin/prospects", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "prospects");
      toast({ title: "Interessent erstellt", description: "Der Interessent wurde erfolgreich angelegt." });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useUpdateProspect({ adminEndpoint = false }: { adminEndpoint?: boolean } = {}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: UpdateProspect }) => {
      const endpoint = adminEndpoint ? `/admin/prospects/${id}` : `/prospects/${id}`;
      const result = await api.patch<Prospect>(endpoint, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "prospects");
      toast({ title: "Gespeichert", description: "Die Änderungen wurden gespeichert." });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
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
    onSuccess: () => {
      invalidateRelated(queryClient, "prospects");
      toast({ title: "Notiz hinzugefügt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
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
    onSuccess: () => {
      invalidateRelated(queryClient, "prospects");
      toast({ title: "Neu geparst", description: "Die Daten wurden aus der E-Mail aktualisiert." });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
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
      invalidateRelated(queryClient, "prospects");
      toast({ title: "Gelöscht", description: "Der Interessent wurde entfernt." });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useQualifyProspect() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ id, action, disqualificationReason }: { id: number; action: "qualify" | "disqualify"; disqualificationReason?: string }) => {
      const result = await api.patch<Prospect>(`/admin/prospects/${id}/qualify`, { action, disqualificationReason });
      return unwrapResult(result);
    },
    onSuccess: (_, vars) => {
      invalidateRelated(queryClient, "prospects");
      toast({ title: vars.action === "qualify" ? "Qualifiziert" : "Disqualifiziert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

interface ProspectOfferData {
  id: number;
  wizardData: Record<string, unknown>;
  status: string;
  createdAt: string;
  expiresAt: string | null;
}

export function useProspectOffer(prospectId: number | null) {
  return useQuery<ProspectOfferData | null>({
    queryKey: ["prospect-offer", prospectId],
    queryFn: async () => {
      const result = await api.get<ProspectOfferData>(`/admin/prospects/${prospectId}/offer`);
      return unwrapResult(result);
    },
    enabled: !!prospectId,
    staleTime: 30_000,
  });
}

