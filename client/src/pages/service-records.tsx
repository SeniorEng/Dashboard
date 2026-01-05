import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SignaturePad, SignatureDisplay } from "@/components/ui/signature-pad";
import { EmptyState } from "@/components/patterns/empty-state";
import { ErrorState } from "@/components/patterns/error-state";
import { 
  FileSignature, Loader2, Calendar, User, Clock, MapPin, 
  ChevronRight, Check, AlertCircle, FileText, ArrowLeft, Plus
} from "lucide-react";
import { iconSize } from "@/design-system";
import { formatDateForDisplay } from "@shared/utils/date";
import { Link, useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { apiRequest } from "@/lib/api/client";
import { useAuth } from "@/hooks/use-auth";
import type { MonthlyServiceRecord, Customer, Appointment } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";

interface PeriodCheckResponse {
  existingRecord: MonthlyServiceRecord | null;
  documentedAppointments: Appointment[];
  undocumentedAppointments: Appointment[];
  canCreateRecord: boolean;
}

interface CustomerOverviewItem {
  customerId: number;
  customerName: string;
  existingRecord: MonthlyServiceRecord | null;
  documentedCount: number;
  undocumentedCount: number;
  totalAppointments: number;
  status: "undocumented" | "ready" | "pending" | "employee_signed" | "completed";
  canCreateRecord: boolean;
}

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

function getStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Warte auf Unterschrift</Badge>;
    case "employee_signed":
      return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Warte auf Kundenunterschrift</Badge>;
    case "completed":
      return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Abgeschlossen</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function ServiceRecordsPage() {
  const currentDate = new Date();
  const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(currentDate.getMonth() + 1);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const customerId = searchParams.get("customerId") ? parseInt(searchParams.get("customerId")!) : null;
  const { user } = useAuth();

  const { data: selectedCustomer } = useQuery<Customer>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const response = await fetch(`/api/customers/${customerId}`);
      if (!response.ok) throw new Error("Kunde konnte nicht geladen werden");
      return response.json();
    },
    enabled: !!customerId,
  });

  const { data: records, isLoading, error, refetch } = useQuery<MonthlyServiceRecord[]>({
    queryKey: ["/api/service-records", selectedYear, selectedMonth, customerId],
    queryFn: async () => {
      let url = `/api/service-records?year=${selectedYear}&month=${selectedMonth}`;
      if (customerId) url += `&customerId=${customerId}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Leistungsnachweise konnten nicht geladen werden");
      return response.json();
    },
  });

  const { data: pendingRecords } = useQuery<MonthlyServiceRecord[]>({
    queryKey: ["/api/service-records/pending"],
    queryFn: async () => {
      const response = await fetch(`/api/service-records/pending`);
      if (!response.ok) throw new Error("Ausstehende Leistungsnachweise konnten nicht geladen werden");
      return response.json();
    },
  });

  // Overview of all customers with their service record status
  const { data: overview, isLoading: isOverviewLoading } = useQuery<CustomerOverviewItem[]>({
    queryKey: ["/api/service-records/overview", selectedYear, selectedMonth],
    queryFn: async () => {
      const response = await fetch(
        `/api/service-records/overview?year=${selectedYear}&month=${selectedMonth}`
      );
      if (!response.ok) throw new Error("Übersicht konnte nicht geladen werden");
      return response.json();
    },
    enabled: !customerId,
  });

  // Check if we can create a service record for the selected period
  const { data: periodCheck, isLoading: isPeriodCheckLoading } = useQuery<PeriodCheckResponse>({
    queryKey: ["/api/service-records/check-period", customerId, selectedYear, selectedMonth],
    queryFn: async () => {
      const response = await fetch(
        `/api/service-records/check-period?customerId=${customerId}&year=${selectedYear}&month=${selectedMonth}`
      );
      if (!response.ok) throw new Error("Periodenprüfung fehlgeschlagen");
      return response.json();
    },
    enabled: !!customerId,
  });

  // Mutation to create a new service record
  const createRecordMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) {
        throw new Error("Nicht angemeldet");
      }
      const result = await apiRequest<MonthlyServiceRecord>("/service-records", {
        method: "POST",
        body: {
          customerId,
          employeeId: user.id,
          year: selectedYear,
          month: selectedMonth,
        },
      });
      if (!result.success) {
        throw new Error(result.error.message || "Fehler beim Erstellen");
      }
      return result.data;
    },
    onSuccess: (newRecord) => {
      toast.success("Leistungsnachweis erstellt");
      queryClient.invalidateQueries({ queryKey: ["/api/service-records"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-records/check-period"] });
      navigate(`/service-records/${newRecord.id}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Fehler beim Erstellen des Leistungsnachweises");
    },
  });

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear - 1, currentYear, currentYear + 1];
  }, []);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <ErrorState
            title="Leistungsnachweise konnten nicht geladen werden"
            description={error instanceof Error ? error.message : "Bitte versuchen Sie es erneut."}
            onRetry={() => refetch()}
          />
        </div>
      </Layout>
    );
  }

  const pendingCount = pendingRecords?.length || 0;

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-1">
          {customerId && (
            <Link href={`/customer/${customerId}`}>
              <Button variant="ghost" size="icon" className="shrink-0" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
          )}
          {!customerId && <FileSignature className={`${iconSize.lg} text-primary`} />}
          <h1 className="text-2xl font-bold text-foreground tracking-tight" data-testid="text-title">
            {customerId && selectedCustomer 
              ? `Leistungsnachweise: ${selectedCustomer.vorname} ${selectedCustomer.nachname}`
              : "Leistungsnachweise"
            }
          </h1>
        </div>
        <p className="text-muted-foreground text-sm ml-10">
          Monatliche Unterschriften für dokumentierte Termine
        </p>
      </div>

      {pendingCount > 0 && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg" data-testid="banner-pending">
          <div className="flex items-center gap-2 text-amber-800">
            <AlertCircle className={iconSize.sm} />
            <span className="text-sm font-medium">
              {pendingCount} {pendingCount === 1 ? "Leistungsnachweis benötigt" : "Leistungsnachweise benötigen"} noch Unterschriften
            </span>
          </div>
        </div>
      )}

      <div className="flex gap-3 mb-6">
        <Select
          value={selectedYear.toString()}
          onValueChange={(val) => setSelectedYear(parseInt(val))}
        >
          <SelectTrigger className="w-32" data-testid="select-year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((year) => (
              <SelectItem key={year} value={year.toString()}>
                {year}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={selectedMonth.toString()}
          onValueChange={(val) => setSelectedMonth(parseInt(val))}
        >
          <SelectTrigger className="w-40" data-testid="select-month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_NAMES.map((name, index) => (
              <SelectItem key={index + 1} value={(index + 1).toString()}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Show overview when no customer is selected */}
      {!customerId && (
        <>
          {isOverviewLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
            </div>
          ) : !overview || overview.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-10">
                <EmptyState
                  icon={<FileText className={`${iconSize["2xl"]} text-muted-foreground/40`} />}
                  title={`Keine Termine für ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
                  description="In diesem Zeitraum wurden keine Termine für Ihre Kunden geplant."
                />
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {overview.map((item) => (
                <CustomerOverviewCard key={item.customerId} item={item} selectedYear={selectedYear} selectedMonth={selectedMonth} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Customer detail view - simplified: ONE state per month */}
      {customerId && periodCheck && (
        <>
          {/* Case 1: Record already exists - show it (check both sources for robustness) */}
          {(records && records.length > 0) || periodCheck.existingRecord ? (
            <div className="space-y-4">
              {records && records.length > 0 ? (
                records.map((record) => (
                  <ServiceRecordCard key={record.id} record={record} />
                ))
              ) : periodCheck.existingRecord ? (
                <ServiceRecordCard key={periodCheck.existingRecord.id} record={periodCheck.existingRecord} />
              ) : null}
            </div>
          ) : periodCheck.canCreateRecord ? (
            /* Case 2: Ready to create - show create button */
            <Card>
              <CardContent className="py-6">
                <div className="text-center space-y-4">
                  <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                    <Check className={`${iconSize.lg} text-green-600`} />
                  </div>
                  <div>
                    <p className="font-medium text-green-700">
                      Alle {periodCheck.documentedAppointments.length} Termine dokumentiert
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Sie können jetzt den Leistungsnachweis für {MONTH_NAMES[selectedMonth - 1]} {selectedYear} erstellen.
                    </p>
                  </div>
                  <Button
                    onClick={() => createRecordMutation.mutate()}
                    disabled={createRecordMutation.isPending}
                    size="lg"
                    className="w-full sm:w-auto"
                    data-testid="button-create-record"
                  >
                    {createRecordMutation.isPending ? (
                      <Loader2 className={`${iconSize.sm} animate-spin mr-2`} />
                    ) : (
                      <Plus className={`${iconSize.sm} mr-2`} />
                    )}
                    Leistungsnachweis erstellen
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : periodCheck.undocumentedAppointments.length > 0 ? (
            /* Case 3: Appointments still open - show warning */
            <Card className="border-amber-200 bg-amber-50/50">
              <CardContent className="py-6">
                <div className="text-center space-y-4">
                  <div className="mx-auto w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
                    <AlertCircle className={`${iconSize.lg} text-amber-600`} />
                  </div>
                  <div>
                    <p className="font-medium text-amber-700">
                      {periodCheck.undocumentedAppointments.length} {periodCheck.undocumentedAppointments.length === 1 ? "Termin" : "Termine"} noch offen
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Dokumentieren Sie alle Termine, um den Leistungsnachweis zu erstellen.
                    </p>
                  </div>
                  <Link href={`/customer/${customerId}?filter=undocumented`}>
                    <Button variant="outline" className="w-full sm:w-auto" data-testid="button-to-appointments">
                      Offene Termine anzeigen
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ) : (
            /* Case 4: No appointments at all */
            <Card className="border-dashed">
              <CardContent className="py-10">
                <EmptyState
                  icon={<FileText className={`${iconSize["2xl"]} text-muted-foreground/40`} />}
                  title={`Keine Termine für ${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
                  description="Es wurden keine Termine für diesen Kunden in diesem Monat geplant."
                />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </Layout>
  );
}

interface ServiceRecordCardProps {
  record: MonthlyServiceRecord;
}

function ServiceRecordCard({ record }: ServiceRecordCardProps) {
  const [, navigate] = useLocation();

  const { data: customer } = useQuery<Customer>({
    queryKey: ["customer", record.customerId],
    queryFn: async () => {
      const response = await fetch(`/api/customers/${record.customerId}`);
      if (!response.ok) throw new Error("Kunde konnte nicht geladen werden");
      return response.json();
    },
  });

  return (
    <Link href={`/service-records/${record.id}`}>
      <Card className="hover:bg-muted/50 transition-colors cursor-pointer" data-testid={`card-record-${record.id}`}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <User className={`${iconSize.sm} text-muted-foreground`} />
                <span className="font-medium" data-testid={`text-customer-${record.id}`}>
                  {customer ? `${customer.vorname} ${customer.nachname}` : "Kunde laden..."}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className={iconSize.xs} />
                <span>{MONTH_NAMES[record.month - 1]} {record.year}</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {getStatusBadge(record.status)}
              <ChevronRight className={`${iconSize.sm} text-muted-foreground`} />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

interface CustomerOverviewCardProps {
  item: CustomerOverviewItem;
  selectedYear: number;
  selectedMonth: number;
}

function getOverviewStatusBadge(status: CustomerOverviewItem["status"]) {
  switch (status) {
    case "undocumented":
      return <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">Termine offen</Badge>;
    case "ready":
      return <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">Bereit</Badge>;
    case "pending":
      return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Warte auf Unterschrift</Badge>;
    case "employee_signed":
      return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Warte auf Kunde</Badge>;
    case "completed":
      return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Abgeschlossen</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function CustomerOverviewCard({ item, selectedYear, selectedMonth }: CustomerOverviewCardProps) {
  const href = item.existingRecord 
    ? `/service-records/${item.existingRecord.id}`
    : `/service-records?customerId=${item.customerId}`;
  
  return (
    <Link href={href}>
      <Card className="hover:bg-muted/50 transition-colors cursor-pointer" data-testid={`card-overview-${item.customerId}`}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <User className={`${iconSize.sm} text-muted-foreground`} />
                <span className="font-medium" data-testid={`text-customer-${item.customerId}`}>
                  {item.customerName}
                </span>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>{item.totalAppointments} {item.totalAppointments === 1 ? "Termin" : "Termine"}</span>
                {item.undocumentedCount > 0 && (
                  <span className="text-red-600">{item.undocumentedCount} offen</span>
                )}
                {item.documentedCount > 0 && item.undocumentedCount === 0 && !item.existingRecord && (
                  <span className="text-emerald-600">{item.documentedCount} dokumentiert</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {getOverviewStatusBadge(item.status)}
              <ChevronRight className={`${iconSize.sm} text-muted-foreground`} />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
