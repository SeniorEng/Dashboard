import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import type { QontoStatus, QontoTransaction, Invoice, PaymentAdvice, MatchFilter } from "../types";

export function useQontoStatus(enabled: boolean = true) {
  return useQuery<QontoStatus>({
    queryKey: ["qonto", "status"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/status")),
    staleTime: 30000,
    enabled,
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
      const result = await api.get<Invoice[]>("/billing?status=versendet");
      return unwrapResult(result);
    },
    enabled,
  });
}

export function useQontoAdvices() {
  return useQuery<PaymentAdvice[]>({
    queryKey: ["qonto", "payment-advices"],
    queryFn: async () => unwrapResult(await api.get("/admin/qonto/payment-advices")),
  });
}
