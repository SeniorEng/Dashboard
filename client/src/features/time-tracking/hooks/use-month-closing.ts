import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";

export interface MonthClosingStatus {
  id: number;
  userId: number;
  year: number;
  month: number;
  closedAt: string;
  closedByUserId: number;
  reopenedAt: string | null;
  reopenedByUserId: number | null;
}

export function useMonthClosingStatus(year: number, month: number) {
  return useQuery<{ closing: MonthClosingStatus | null }>({
    queryKey: ["month-closing", year, month],
    queryFn: async () => {
      const result = await api.get<{ closing: MonthClosingStatus | null }>(`/time-entries/month-closing/${year}/${month}`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });
}

// Task #1496: useAdminCloseMonth / useAdminReopenMonth / useAdminBatchCloseMonth
// wurden entfernt — der Monatsabschluss läuft ausschließlich automatisch am Cutoff
// (kein manueller Einzel-/Batch-Abschluss, kein Wieder-Öffnen mehr).
// Task #1504: Die admin-seitige Readiness-Query (useAdminMonthClosingReadiness)
// wurde mit der read-only Monatsabschluss-Seite entfernt. Diese Datei stellt nur
// noch den lesenden Mitarbeiter-Status (useMonthClosingStatus) bereit.
