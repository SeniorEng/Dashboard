import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { ArrowLeft, Loader2, FileCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import { ErrorState } from "@/components/patterns/error-state";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";
import type { AppointmentWithCustomer } from "@shared/types";
import type { Customer } from "@shared/schema";

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export default function CustomerUndocumentedAppointmentsPage() {
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const customerIdRaw = searchParams.get("customerId");
  const yearRaw = searchParams.get("year");
  const monthRaw = searchParams.get("month");

  const customerId = customerIdRaw ? parseInt(customerIdRaw, 10) : null;
  const year = yearRaw ? parseInt(yearRaw, 10) : new Date().getFullYear();
  const month = monthRaw ? parseInt(monthRaw, 10) : new Date().getMonth() + 1;

  const { viewAsEmployeeId } = useViewAsEmployee();
  const backToServiceRecords = `/service-records?customerId=${customerId ?? ""}&year=${year}&month=${month}`;
  const fromQuery = encodeURIComponent(
    `/service-records/open?customerId=${customerId ?? ""}&year=${year}&month=${month}`,
  );

  const { data: customer } = useQuery<Customer>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const result = await api.get<Customer>(`/customers/${customerId}`);
      return unwrapResult(result);
    },
    enabled: !!customerId,
  });

  const { data: appointments, isLoading, error, refetch } = useQuery<AppointmentWithCustomer[]>({
    queryKey: ["appointments", "undocumented-by-customer", customerId, year, month, { viewAsEmployeeId }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("customerId", String(customerId));
      params.set("year", String(year));
      params.set("month", String(month));
      if (viewAsEmployeeId) params.set("viewAsEmployeeId", String(viewAsEmployeeId));
      const result = await api.get<AppointmentWithCustomer[]>(`/appointments/undocumented/by-customer?${params.toString()}`);
      return unwrapResult(result);
    },
    enabled: !!customerId,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });

  const monthAppointments = useMemo(() => {
    if (!appointments) return [];
    return [...appointments].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.scheduledStart || "").localeCompare(b.scheduledStart || "");
    });
  }, [appointments]);

  if (!customerId) {
    return (
      <Layout>
        <div className="py-12 text-center text-muted-foreground" data-testid="error-no-customer">
          Kein Kunde gewählt.
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-4">
          <Link href={backToServiceRecords}>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label="Zurück zum Leistungsnachweis"
              data-testid="button-back"
            >
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className={componentStyles.pageTitle} data-testid="text-title">
              Offene Termine
            </h1>
            <p className="text-sm text-muted-foreground" data-testid="text-subtitle">
              {customer?.name ? `${customer.name} · ` : ""}
              {MONTH_NAMES[month - 1]} {year}
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12" data-testid="loading-customer-undocumented">
            <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
          </div>
        )}

        {error && (
          <div data-testid="error-customer-undocumented">
            <ErrorState
              title="Offene Termine konnten nicht geladen werden"
              description={error instanceof Error ? error.message : "Bitte versuchen Sie es erneut."}
              onRetry={() => refetch()}
            />
          </div>
        )}

        {!isLoading && !error && monthAppointments.length === 0 && (
          <div className="text-center py-12" data-testid="empty-customer-undocumented">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 mb-4">
              <FileCheck className={`${iconSize.xl} text-green-600`} />
            </div>
            <p className="text-muted-foreground mb-4">
              Keine offenen Termine mehr in diesem Monat.
            </p>
            <Link href={backToServiceRecords}>
              <Button variant="outline" data-testid="button-to-service-record">
                Zum Leistungsnachweis
              </Button>
            </Link>
          </div>
        )}

        {!isLoading && !error && monthAppointments.length > 0 && (
          <div className="space-y-3 animate-in slide-in-from-bottom-4 duration-700">
            <p className="text-sm text-muted-foreground" data-testid="text-count">
              {monthAppointments.length} {monthAppointments.length === 1 ? "Termin" : "Termine"} offen — bitte dokumentieren.
            </p>
            {monthAppointments.map((apt) => (
              <div key={apt.id} data-testid={`item-appointment-${apt.id}`}>
                <AppointmentCard
                  appointment={apt}
                  showDate
                  linkQuery={`from=${fromQuery}`}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
