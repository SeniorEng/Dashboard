import { memo, useMemo } from "react";
import { Loader2 } from "lucide-react";
import type { AppointmentWithCustomer } from "@shared/types";
import { AppointmentCard } from "./appointment-card";
import { sortAppointmentsByPriority } from "../utils";

interface AppointmentListProps {
  appointments: AppointmentWithCustomer[] | undefined;
  isLoading: boolean;
  error: Error | null;
}

function AppointmentListComponent({ appointments, isLoading, error }: AppointmentListProps) {
  const sortedAppointments = useMemo(() => {
    if (!appointments) return [];
    return sortAppointmentsByPriority(appointments);
  }, [appointments]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="loading-appointments">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 text-destructive" data-testid="error-appointments">
        <p>Termine konnten nicht geladen werden. Bitte versuchen Sie es erneut.</p>
      </div>
    );
  }

  if (sortedAppointments.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground" data-testid="empty-appointments">
        <p>Keine Termine für heute geplant.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in slide-in-from-bottom-4 duration-700 fade-in fill-mode-backwards">
      {sortedAppointments.map((apt) => (
        <AppointmentCard key={apt.id} appointment={apt} />
      ))}
    </div>
  );
}

export const AppointmentList = memo(AppointmentListComponent);
