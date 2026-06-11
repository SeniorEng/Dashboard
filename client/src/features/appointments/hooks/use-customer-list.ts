import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { Customer } from "@shared/schema";

export type CustomerWithAccess = Customer & {
  isCurrentlyAssigned?: boolean;
  // Aktuelle Versichertennummer (Task #403): Backend liefert die Nummer
  // aus customer_insurance_history mit validTo IS NULL, damit der mobile
  // Filter clientseitig auch nach VNR suchen kann.
  versichertennummer?: string | null;
  // Task #1194 — Vertragsende + Kündigungs-Status des jüngsten Vertrags für
  // die Lebenszyklus-Klassifikation (laufend vs. gekündigt) aktiver Kunden.
  contractEnd?: string | null;
  contractTerminated?: boolean;
};

export function useCustomerList(status?: string) {
  const queryStatus = status ?? "aktiv";
  return useQuery<CustomerWithAccess[]>({
    queryKey: ["customers", { status: queryStatus }],
    queryFn: async () => {
      const endpoint = queryStatus ? `/customers?status=${queryStatus}` : "/customers";
      const result = await api.get<CustomerWithAccess[]>(endpoint);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });
}
