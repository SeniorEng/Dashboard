import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { ArrowLeft, Loader2, FileCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import { ErrorState } from "@/components/patterns/error-state";
import type { AppointmentWithCustomer } from "@shared/types";
import {
  getDocumentationAgeBucket,
  DOCUMENTATION_AGE_BUCKET_LABELS,
  DOCUMENTATION_AGE_BUCKET_ORDER,
  daysOverdue,
  type DocumentationAgeBucket,
} from "@shared/domain/appointments";
import { cn } from "@/lib/utils";

type FilterKey = "all" | "overdue" | "today";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "overdue", label: "Hängend (>7 Tage)" },
  { key: "today", label: "Heute fällig" },
];

export default function UndocumentedAppointments() {
  const [filter, setFilter] = useState<FilterKey>("all");

  const { data: appointments, isLoading, error, refetch } = useQuery<AppointmentWithCustomer[]>({
    queryKey: ["appointments", "undocumented"],
    queryFn: async () => {
      const result = await api.get<AppointmentWithCustomer[]>("/appointments/undocumented");
      return unwrapResult(result);
    },
  });

  const groups = useMemo(() => {
    const now = new Date();
    const buckets: Record<DocumentationAgeBucket, AppointmentWithCustomer[]> = {
      "overdue": [],
      "this-week": [],
      "today": [],
    };
    for (const apt of appointments ?? []) {
      const bucket = getDocumentationAgeBucket(apt, now);
      buckets[bucket].push(apt);
    }
    // Within each bucket: oldest first (date asc, then start time asc).
    const sortByOldest = (a: AppointmentWithCustomer, b: AppointmentWithCustomer) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.scheduledStart || "").localeCompare(b.scheduledStart || "");
    };
    for (const key of DOCUMENTATION_AGE_BUCKET_ORDER) {
      buckets[key].sort(sortByOldest);
    }
    return buckets;
  }, [appointments]);

  const visibleBuckets = useMemo<DocumentationAgeBucket[]>(() => {
    if (filter === "overdue") return ["overdue"];
    if (filter === "today") return ["today"];
    return DOCUMENTATION_AGE_BUCKET_ORDER;
  }, [filter]);

  const totalVisible = visibleBuckets.reduce((sum, b) => sum + groups[b].length, 0);

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/">
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="Zurück" data-testid="button-back">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <h1 className={componentStyles.pageTitle}>Offene Dokumentationen</h1>
        </div>

        {!isLoading && !error && (appointments?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => {
              const count =
                f.key === "all"
                  ? appointments?.length ?? 0
                  : groups[f.key === "overdue" ? "overdue" : "today"].length;
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(f.key)}
                  data-testid={`filter-${f.key}`}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-sm border transition-colors",
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-foreground border-input hover:bg-accent",
                  )}
                >
                  {f.label} <span className="opacity-70">({count})</span>
                </button>
              );
            })}
          </div>
        )}

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

        {!isLoading && !error && (appointments?.length ?? 0) === 0 && (
          <div className="text-center py-12" data-testid="empty-undocumented">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 mb-4">
              <FileCheck className={`${iconSize.xl} text-green-600`} />
            </div>
            <p className="text-muted-foreground">Alle Termine sind dokumentiert!</p>
          </div>
        )}

        {!isLoading && !error && (appointments?.length ?? 0) > 0 && totalVisible === 0 && (
          <div className="text-center py-12 text-muted-foreground" data-testid="empty-undocumented-filtered">
            Keine Termine in dieser Auswahl.
          </div>
        )}

        {!isLoading && !error && totalVisible > 0 && (
          <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-700">
            {visibleBuckets.map((bucket) => {
              const items = groups[bucket];
              if (items.length === 0) return null;
              return (
                <section key={bucket} data-testid={`group-${bucket}`}>
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
                    <span>{DOCUMENTATION_AGE_BUCKET_LABELS[bucket]}</span>
                    <span className="text-xs opacity-70">({items.length})</span>
                  </h2>
                  <div className="space-y-4">
                    {items.map((apt) => (
                      <div
                        key={apt.id}
                        data-testid={`undocumented-item-${apt.id}`}
                        data-bucket={bucket}
                        data-days-overdue={daysOverdue(apt)}
                      >
                        <AppointmentCard appointment={apt} showDate />
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}
