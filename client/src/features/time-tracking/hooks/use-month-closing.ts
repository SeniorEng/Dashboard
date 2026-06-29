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

export interface OpenAppointment {
  id: number;
  date: string;
  scheduledStart: string | null;
  status: string;
  customerName: string;
}

export interface MonthClosingReadiness {
  ready: boolean;
  openAppointments: OpenAppointment[];
  unsignedAppointments: OpenAppointment[];
  hasTimeEntries: boolean;
  timeEntryCount: number;
}

export interface AdminEmployeeReadiness extends MonthClosingReadiness {
  userId: number;
  displayName: string;
  isClosed: boolean;
  closingId: number | null;
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

export function useAdminMonthClosingReadiness(year: number, month: number) {
  return useQuery<{ employees: AdminEmployeeReadiness[] }>({
    queryKey: ["admin-month-closing-readiness", year, month],
    queryFn: async () => {
      const result = await api.get<{ employees: AdminEmployeeReadiness[] }>(
        `/time-entries/month-closings/admin/${year}/${month}/readiness`
      );
      return unwrapResult(result);
    },
    staleTime: 30000,
  });
}

// Task #1496: useAdminCloseMonth / useAdminReopenMonth / useAdminBatchCloseMonth
// wurden entfernt — der Monatsabschluss läuft ausschließlich automatisch am Cutoff
// (kein manueller Einzel-/Batch-Abschluss, kein Wieder-Öffnen mehr). Diese Datei
// stellt nur noch lesende Status-/Readiness-Queries bereit.
