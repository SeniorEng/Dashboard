import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { invalidateRelated } from "@/lib/query-invalidation";
import type { PaymentAdvice } from "../types";

export function useSyncMutation() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => unwrapResult(await api.post<{ synced: number }>("/admin/qonto/sync", {})),
    onSuccess: (data) => {
      toast({ title: `${data.synced} Transaktionen synchronisiert` });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useTransactionMutations({ onMatchSuccess }: { onMatchSuccess: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const matchMutation = useMutation({
    mutationFn: async ({ txId, invoiceId }: { txId: number; invoiceId: number }) =>
      unwrapResult(await api.post(`/admin/qonto/transactions/${txId}/match`, { invoiceId })),
    onSuccess: () => {
      toast({ title: "Zuordnung gespeichert" });
      onMatchSuccess();
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const unmatchMutation = useMutation({
    mutationFn: async (txId: number) =>
      unwrapResult(await api.delete(`/admin/qonto/transactions/${txId}/match`)),
    onSuccess: () => {
      toast({ title: "Zuordnung aufgehoben" });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const autoMatchMutation = useMutation({
    mutationFn: async () => unwrapResult(await api.post<{ matched: number; skipped: number }>("/admin/qonto/auto-match", {})),
    onSuccess: (data) => {
      toast({ title: `Auto-Abgleich: ${data.matched} zugeordnet, ${data.skipped} ohne Treffer` });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const csvImportMutation = useMutation({
    mutationFn: async (csvContent: string) =>
      unwrapResult(await api.post<{ imported: number; updated: number; skipped: number }>("/admin/qonto/transactions/import-csv", { csvContent })),
    onSuccess: (data) => {
      const parts: string[] = [];
      if (data.imported > 0) parts.push(`${data.imported} importiert`);
      if (data.updated > 0) parts.push(`${data.updated} aktualisiert`);
      if (data.skipped > 0) parts.push(`${data.skipped} übersprungen`);
      toast({ title: `CSV-Import: ${parts.join(", ")}` });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler beim CSV-Import", description: error.message, variant: "destructive" });
    },
  });

  return { matchMutation, unmatchMutation, autoMatchMutation, csvImportMutation };
}

export function useAdviceMutations({ onCreateSuccess }: { onCreateSuccess: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) =>
      unwrapResult(await api.post<{ advice: PaymentAdvice; matched: number }>("/admin/qonto/payment-advices", data)),
    onSuccess: (result) => {
      const msg = result.matched > 0
        ? `Avis gespeichert — ${result.matched} Rechnungen zugeordnet`
        : "Zahlungsavis gespeichert";
      toast({ title: msg });
      invalidateRelated(queryClient, "qonto");
      onCreateSuccess();
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) =>
      unwrapResult(await api.delete(`/admin/qonto/payment-advices/${id}`)),
    onSuccess: () => {
      toast({ title: "Zahlungsavis gelöscht" });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return { createMutation, deleteMutation };
}
