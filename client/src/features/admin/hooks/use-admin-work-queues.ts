import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import type { AppointmentWithCustomer } from "@shared/types";

// Single source of truth for the admin "offene Arbeit"-Listen. Sowohl die
// Listenseiten als auch die Zähler-Badges auf dem Admin-Dashboard lesen
// ausschließlich über diese Hooks (gleiche queryKeys/Endpunkte). Damit kann
// kein zweiter, divergierender Zähler neben der jeweiligen Liste entstehen
// (Anti-Dualismus): Der Badge zeigt immer exakt die Länge derselben Liste.

export interface PendingProof {
  id: number;
  employeeId: number;
  qualificationId: number | null;
  documentTypeId: number;
  status: string;
  fileName: string | null;
  objectPath: string | null;
  uploadedAt: string | null;
  documentType: { id: number; name: string };
  qualification: { id: number; name: string } | null;
  employee: { id: number; displayName: string };
}

export function usePendingProofs() {
  return useQuery<PendingProof[]>({
    queryKey: ["admin", "pending-proofs"],
    queryFn: async () => unwrapResult(await api.get<PendingProof[]>("/admin/proofs/pending-review")),
  });
}

export type PlannedConsultationFilter = "overdue" | "upcoming" | "all";

export function usePlannedConsultations(filter: PlannedConsultationFilter) {
  return useQuery<AppointmentWithCustomer[]>({
    queryKey: ["appointments", "planned-consultations", filter],
    queryFn: async () =>
      unwrapResult(
        await api.get<AppointmentWithCustomer[]>(`/appointments/planned-consultations?filter=${filter}`),
      ),
  });
}
