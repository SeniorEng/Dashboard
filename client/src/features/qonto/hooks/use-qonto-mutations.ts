import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult, ApiError } from "@/lib/api";
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

export function useBackfillMutation() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      vars: { startDate: string; acknowledgeExtendedLookback?: boolean },
    ) =>
      unwrapResult(
        await api.post<{ synced: number; total: number; accounts: number; autoHidden: number }>(
          "/admin/qonto/backfill",
          {
            startDate: vars.startDate,
            acknowledgeExtendedLookback: vars.acknowledgeExtendedLookback,
          },
        ),
      ),
    onSuccess: (data) => {
      const hidden = data.autoHidden > 0 ? `, ${data.autoHidden} automatisch ausgeblendet` : "";
      toast({
        title: `Abruf: ${data.synced} Transaktionen von ${data.accounts} Konto(en) geladen${hidden}`,
      });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      // Task #1591 — Läuft bereits ein Voll-Sync (serverseitiger Lauf-Lock),
      // antwortet die Route mit 409; der spezifische Code "QONTO_BACKFILL_RUNNING"
      // landet nach parseErrorResponse in details.errorCode. Dann eine ruhige,
      // verständliche Meldung statt eines generischen Fehlers zeigen.
      if (error instanceof ApiError && error.details?.errorCode === "QONTO_BACKFILL_RUNNING") {
        toast({ title: "Ein Voll-Sync läuft bereits", description: error.message });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
}

export function useHideRuleMutations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createRuleMutation = useMutation({
    mutationFn: async (data: { ruleType: "counterparty" | "iban"; value: string }) =>
      unwrapResult(await api.post<{ rule: unknown; autoHidden: number }>("/admin/qonto/hide-rules", data)),
    onSuccess: (result) => {
      const hidden = result.autoHidden > 0
        ? `Regel angelegt — ${result.autoHidden} Transaktion(en) ausgeblendet`
        : "Regel angelegt";
      toast({ title: hidden });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: number) => unwrapResult(await api.delete(`/admin/qonto/hide-rules/${id}`)),
    onSuccess: () => {
      toast({ title: "Regel gelöscht" });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return { createRuleMutation, deleteRuleMutation };
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

  // Task #1710 — manuelle Mehrfach-Zuordnung: 2+ offene Rechnungen mit EINER
  // Qonto-Zahlung verknüpfen (ad-hoc Sammel-Avis serverseitig).
  const bulkMatchMutation = useMutation({
    mutationFn: async ({ txId, invoiceIds }: { txId: number; invoiceIds: number[] }) =>
      unwrapResult(await api.post(`/admin/qonto/transactions/${txId}/bulk-match`, { invoiceIds })),
    onSuccess: () => {
      toast({ title: "Mehrfach-Zuordnung gespeichert, Rechnungen als bezahlt markiert" });
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

  const ignoreMutation = useMutation({
    mutationFn: async (txId: number) =>
      unwrapResult(await api.post(`/admin/qonto/transactions/${txId}/ignore`, {})),
    onSuccess: () => {
      toast({ title: "Als nicht abrechnungsrelevant markiert" });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const unignoreMutation = useMutation({
    mutationFn: async (txId: number) =>
      unwrapResult(await api.delete(`/admin/qonto/transactions/${txId}/ignore`)),
    onSuccess: () => {
      toast({ title: "Markierung aufgehoben" });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  // Task #1672 — rückwirkenden Sammel-Avis-Vorschlag bestätigen (bucht die
  // Zuordnung; Triple-Equality bleibt serverseitig erzwungen).
  const confirmAdviceMutation = useMutation({
    mutationFn: async ({ txId, adviceId }: { txId: number; adviceId: number }) =>
      unwrapResult(await api.post(`/admin/qonto/transactions/${txId}/confirm-advice`, { adviceId })),
    onSuccess: () => {
      toast({ title: "Sammel-Avis zugeordnet, offene Rechnungen als bezahlt markiert" });
      onMatchSuccess();
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  // Task #1672 — Vorschlag ablehnen (wird nach dem nächsten Sync nicht erneut angeboten).
  const dismissAdviceSuggestionMutation = useMutation({
    mutationFn: async (txId: number) =>
      unwrapResult(await api.post(`/admin/qonto/transactions/${txId}/dismiss-advice-suggestion`, {})),
    onSuccess: () => {
      toast({ title: "Vorschlag abgelehnt" });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return { matchMutation, bulkMatchMutation, unmatchMutation, autoMatchMutation, csvImportMutation, ignoreMutation, unignoreMutation, confirmAdviceMutation, dismissAdviceSuggestionMutation };
}

// Task #1685 — mehrdeutige Sammel-Avis-Zuordnung manuell auflösen: der Operator
// wählt für ein Avis genau eine der konkurrierenden Gutschriften. Verknüpft
// serverseitig über den geteilten, geguardeten & auditierten Backfill-Linker.
export function useResolveAmbiguousAdviceMutation() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ adviceId, txId }: { adviceId: number; txId: number }) =>
      unwrapResult(await api.post(`/admin/qonto/transactions/ambiguous-advices/${adviceId}/resolve`, { txId })),
    onSuccess: () => {
      toast({ title: "Zuordnung aufgelöst — Avis mit gewählter Gutschrift verknüpft" });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
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

  const markPaidMutation = useMutation({
    mutationFn: async (id: number) =>
      unwrapResult(await api.post<{ paid: number }>(`/admin/qonto/payment-advices/${id}/mark-paid`, {})),
    onSuccess: (data) => {
      toast({ title: `${data.paid} Rechnung(en) als bezahlt markiert` });
      invalidateRelated(queryClient, "qonto");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return { createMutation, deleteMutation, markPaidMutation };
}
