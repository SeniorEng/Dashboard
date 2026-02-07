import { memo, useMemo } from "react";
import { Loader2 } from "lucide-react";
import type { AppointmentWithCustomer } from "@shared/types";
import { AppointmentCard } from "./appointment-card";
import { sortAppointmentsByPriority } from "../utils";
import { ErrorState } from "@/components/patterns/error-state";

interface AppointmentListProps {
  appointments: AppointmentWithCustomer[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onRetry?: () => void;
}

function AppointmentListComponent({ appointments, isLoading, error, onRetry }: AppointmentListProps) {
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
      <div data-testid="error-appointments">
        <ErrorState
          title="Termine konnten nicht geladen werden"
          description={error.message || "Bitte versuchen Sie es erneut."}
          onRetry={onRetry}
        />
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
    <div className="flex flex-col gap-4 animate-in slide-in-from-bottom-4 duration-700 fade-in fill-mode-backwards">
      {sortedAppointments.map((apt) => (
        <AppointmentCard key={apt.id} appointment={apt} />
      ))}
    </div>
  );
}

export const AppointmentList = memo(AppointmentListComponent);
