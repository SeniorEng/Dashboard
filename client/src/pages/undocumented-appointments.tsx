import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { ArrowLeft, Loader2, FileCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { iconSize } from "@/design-system";
import { ErrorState } from "@/components/patterns/error-state";
import type { AppointmentWithCustomer } from "@shared/types";

export default function UndocumentedAppointments() {
  const { data: appointments, isLoading, error, refetch } = useQuery<AppointmentWithCustomer[]>({
    queryKey: ["appointments", "undocumented"],
    queryFn: async () => {
      const response = await fetch(`/api/appointments/undocumented`);
      if (!response.ok) {
        throw new Error("Failed to fetch undocumented appointments");
      }
      return response.json();
    },
  });

  const sortedAppointments = appointments?.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.scheduledStart || "").localeCompare(b.scheduledStart || "");
  }) || [];

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/">
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="Zurück" data-testid="button-back">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <h1 className="text-xl font-semibold text-foreground">Offene Dokumentationen</h1>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12" data-testid="loading-undocumented">
            <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
          </div>
        )}

        {error && (
          <div data-testid="error-undocumented">
            <ErrorState
              title="Offene Dokumentationen konnten nicht geladen werden"
              description={error instanceof Error ? error.message : "Bitte versuchen Sie es erneut."}
              onRetry={() => refetch()}
            />
          </div>
        )}

        {!isLoading && !error && sortedAppointments.length === 0 && (
          <div className="text-center py-12" data-testid="empty-undocumented">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 mb-4">
              <FileCheck className={`${iconSize.xl} text-green-600`} />
            </div>
            <p className="text-muted-foreground">Alle Termine sind dokumentiert!</p>
          </div>
        )}

        {!isLoading && !error && sortedAppointments.length > 0 && (
          <div className="space-y-4 animate-in slide-in-from-bottom-4 duration-700">
            {sortedAppointments.map((apt) => (
              <AppointmentCard key={apt.id} appointment={apt} showDate />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
