import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { QontoStatus, QontoTransaction, Invoice, PaymentAdvice, MatchFilter, QontoHideRule, AdviceSuggestion, AmbiguousAdvice } from "../types";

export function useQontoStatus(enabled: boolean = true) {
  return useQuery<QontoStatus>({
    queryKey: ["qonto", "status"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/status")),
    staleTime: 30000,
    enabled,
  });
}

// Task #1600 — Live-Status, ob gerade ein Voll-Sync läuft (serverseitiger
// Lauf-Lock aus Task #1591). Wird gepollt, damit auch andere Sitzungen/Tabs
// proaktiv „Voll-Sync läuft…" sehen und der Start-Button für alle sperrt.
export function useQontoBackfillStatus(enabled: boolean) {
  return useQuery<{ running: boolean }>({
    queryKey: ["qonto", "backfill-status"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/backfill/status")),
    enabled,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.running ? 2500 : 6000),
    refetchIntervalInBackground: false,
  });
}

export function useQontoTransactions(matchFilter: MatchFilter, configured: boolean) {
  return useQuery<{ transactions: QontoTransaction[]; total: number }>({
    queryKey: ["qonto", "transactions", matchFilter],
    queryFn: async () => unwrapResult(await api.get(`/admin/qonto/transactions?matched=${matchFilter}&limit=100`)),
    enabled: configured,
    staleTime: 15000,
  });
}

export function useMatchableInvoices(enabled: boolean) {
  return useQuery<Invoice[]>({
    queryKey: ["billing", "open-for-match"],
    queryFn: async () => {
      // Task #1710 — nur wirklich offene, noch nicht durch eine Zahlung
      // beanspruchte Rechnungen (serverseitige Doppelzählungs-Ausblendung).
      const result = await api.get<Invoice[]>("/billing/open-for-match");
      return unwrapResult(result);
    },
    enabled,
  });
}

export function useQontoHideRules(enabled: boolean = true) {
  return useQuery<QontoHideRule[]>({
    queryKey: ["qonto", "hide-rules"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/hide-rules")),
    enabled,
    staleTime: 15000,
  });
}

export function useQontoAdvices() {
  return useQuery<PaymentAdvice[]>({
    queryKey: ["qonto", "payment-advices"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/payment-advices")),
  });
}

// Task #1685 — mehrdeutige Sammel-Avis ↔ Sammelzahlung-Zuordnungen, die manuell
// aufgelöst werden müssen (mehrere passende Gutschriften oder geteilte Gutschrift).
export function useAmbiguousAdvices(enabled: boolean = true) {
  return useQuery<{ ambiguous: AmbiguousAdvice[] }>({
    queryKey: ["qonto", "ambiguous-advices"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/transactions/ambiguous-advices")),
    enabled,
    staleTime: 15000,
  });
}

// Task #1672 — rückwirkende Sammel-Avis-Vorschläge für offene Zahlungseingänge.
export function useAdviceSuggestions(enabled: boolean) {
  return useQuery<{ suggestions: AdviceSuggestion[] }>({
    queryKey: ["qonto", "advice-suggestions"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/transactions/advice-suggestions")),
    enabled,
    staleTime: 15000,
  });
}
