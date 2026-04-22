import { useMemo } from "react";
import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { ArrowLeft, Loader2, CalendarCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import { ErrorState } from "@/components/patterns/error-state";
import { cn } from "@/lib/utils";
import type { AppointmentWithCustomer } from "@shared/types";

type FilterValue = "overdue" | "upcoming" | "all";

const FILTER_OPTIONS: Array<{ value: FilterValue; label: string; testId: string }> = [
  { value: "overdue", label: "Überfällig", testId: "filter-overdue" },
  { value: "upcoming", label: "Geplant", testId: "filter-upcoming" },
  { value: "all", label: "Alle", testId: "filter-all" },
];

const TITLE_BY_FILTER: Record<FilterValue, string> = {
  overdue: "Überfällige Erstberatungen",
  upcoming: "Geplante Erstberatungen",
  all: "Erstberatungen (geplant & überfällig)",
};

const EMPTY_BY_FILTER: Record<FilterValue, string> = {
  overdue: "Keine überfälligen Erstberatungen.",
  upcoming: "Keine geplanten Erstberatungen.",
  all: "Keine geplanten Erstberatungen.",
};

export default function PlannedConsultations() {
  const search = useSearch();
  const filter: FilterValue = useMemo(() => {
    const params = new URLSearchParams(search);
    const value = params.get("filter");
    if (value === "overdue" || value === "upcoming" || value === "all") return value;
    return "overdue";
  }, [search]);

  const { data: appointments, isLoading, error, refetch } = useQuery<AppointmentWithCustomer[]>({
    queryKey: ["appointments", "planned-consultations", filter],
    queryFn: async () => {
      const result = await api.get<AppointmentWithCustomer[]>(`/appointments/planned-consultations?filter=${filter}`);
      return unwrapResult(result);
    },
  });

  const list = appointments ?? [];

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/admin/statistics">
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="Zurück" data-testid="button-back">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <h1 className={componentStyles.pageTitle} data-testid="text-page-title">{TITLE_BY_FILTER[filter]}</h1>
        </div>

        <div className="flex flex-wrap gap-2 mb-4" data-testid="filter-tabs">
          {FILTER_OPTIONS.map((opt) => {
            const isActive = opt.value === filter;
            return (
              <Link key={opt.value} href={`/admin/planned-consultations?filter=${opt.value}`}>
                <Button
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  data-testid={opt.testId}
                  className={cn(isActive && opt.value === "overdue" && "bg-red-600 hover:bg-red-700")}
                >
                  {opt.label}
                </Button>
              </Link>
            );
          })}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12" data-testid="loading-planned-consultations">
            <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
          </div>
        )}

        {error && (
          <div data-testid="error-planned-consultations">
            <ErrorState
              title="Erstberatungen konnten nicht geladen werden"
              description={error instanceof Error ? error.message : "Bitte versuchen Sie es erneut."}
              onRetry={() => refetch()}
            />
          </div>
        )}

        {!isLoading && !error && list.length === 0 && (
          <div className="text-center py-12" data-testid="empty-planned-consultations">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-orange-100 mb-4">
              <CalendarCheck className={`${iconSize.xl} text-orange-600`} />
            </div>
            <p className="text-muted-foreground">{EMPTY_BY_FILTER[filter]}</p>
          </div>
        )}

        {!isLoading && !error && list.length > 0 && (
          <div className="space-y-4 animate-in slide-in-from-bottom-4 duration-700" data-testid="list-planned-consultations">
            {list.map((apt) => (
              <AppointmentCard key={apt.id} appointment={apt} showDate />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
