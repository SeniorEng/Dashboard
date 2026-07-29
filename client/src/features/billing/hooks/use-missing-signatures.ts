import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { MissingSignatureItem } from "../types";

/**
 * Task #1889 — „Fehlende Unterschriften nach Abschluss" pro Kunde gruppiert.
 *
 * Ersetzt die separate obere Box (`MissingSignaturesCard`): die termingenaue Info
 * (Datum/Zeit/verantwortlicher Mitarbeiter/Link) wird direkt unter dem jeweiligen
 * Kunden in der Abrechnungsliste angezeigt. Datenquelle ist DIESELBE Server-SSoT
 * (`getMissingSignaturesInClosedMonths` → `completedButUnsignedSqlRaw`, #1586):
 * completed, keine Direktunterschrift, NICHT unter einem signierten LN, Monat
 * abgeschlossen, Erstberatung ausgenommen. Query-Key unverändert, damit die
 * zentrale Invalidierung weiter greift; auf den gewählten Monat/Jahr gefiltert.
 */
export function useMissingSignaturesByCustomer(
  selectedYear: number,
  selectedMonth: number,
): Map<number, MissingSignatureItem[]> {
  const { data } = useQuery<{ items: MissingSignatureItem[] }>({
    queryKey: ["month-closing-missing-signatures"],
    queryFn: async () =>
      unwrapResult(
        await api.get<{ items: MissingSignatureItem[] }>(
          "/time-entries/month-closing/missing-signatures",
        ),
      ),
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(() => {
    const map = new Map<number, MissingSignatureItem[]>();
    for (const item of data?.items ?? []) {
      if (item.year !== selectedYear || item.month !== selectedMonth) continue;
      const list = map.get(item.customerId) ?? [];
      list.push(item);
      map.set(item.customerId, list);
    }
    return map;
  }, [data, selectedYear, selectedMonth]);
}
