import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SignaturePad, SignatureDisplay } from "@/components/ui/signature-pad";
import { EmptyState } from "@/components/patterns/empty-state";
import { ErrorState } from "@/components/patterns/error-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import {
  Loader2, Calendar, User, Clock, MapPin,
  ChevronRight, Check, AlertCircle, FileText, ArrowLeft, Plus
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { Link, useLocation, useSearch } from "wouter";
import {
  OverviewSections,
  type CustomerOverviewItem,
} from "@/features/service-records/components/overview-sections";
import {
  DeadlineHint,
  computeDeadlineInfo,
} from "@/features/service-records/components/deadline-hint";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { useAuth } from "@/hooks/use-auth";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";
import { invalidateRelated } from "@/lib/query-invalidation";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { MonthlyServiceRecord, Customer, Appointment } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";

interface PeriodCheckResponse {
  existingRecord: MonthlyServiceRecord | null;
  documentedCount: number;
  undocumentedCount: number;
  coveredBySingleCount: number;
  coveredByMonthlyCount: number;
  uncoveredDocumentedCount: number;
  canCreateRecord: boolean;
}

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];


export default function ServiceRecordsPage() {
  const { toast } = useToast();
  const currentDate = new Date();
  const initialSearch = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const initialYearRaw = initialSearch.get("year");
  const initialMonthRaw = initialSearch.get("month");
  const initialYear = initialYearRaw ? parseInt(initialYearRaw, 10) : currentDate.getFullYear();
  const initialMonth = initialMonthRaw ? parseInt(initialMonthRaw, 10) : currentDate.getMonth() + 1;
  const [selectedYear, setSelectedYear] = useState(Number.isFinite(initialYear) ? initialYear : currentDate.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(
    Number.isFinite(initialMonth) && initialMonth >= 1 && initialMonth <= 12 ? initialMonth : currentDate.getMonth() + 1,
  );
  const [pendingSheetOpen, setPendingSheetOpen] = useState(false);
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const customerId = searchParams.get("customerId") ? parseInt(searchParams.get("customerId")!) : null;
  const { user } = useAuth();
  const { viewAsEmployeeId } = useViewAsEmployee();

  const { data: selectedCustomer } = useQuery<Customer>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const result = await api.get<Customer>(`/customers/${customerId}`);
      return unwrapResult(result);
    },
    enabled: !!customerId,
  });

  const { data: records, isLoading, error, refetch } = useQuery<MonthlyServiceRecord[]>({
    queryKey: ["/api/service-records", selectedYear, selectedMonth, customerId, viewAsEmployeeId],
    queryFn: async () => {
      let url = `/service-records?year=${selectedYear}&month=${selectedMonth}`;
      if (customerId) url += `&customerId=${customerId}`;
      if (viewAsEmployeeId) url += `&viewAsEmployeeId=${viewAsEmployeeId}`;
      const result = await api.get<MonthlyServiceRecord[]>(url);
      return unwrapResult(result);
    },
  });

  const { data: pendingRecords } = useQuery<MonthlyServiceRecord[]>({
    queryKey: ["/api/service-records/pending", viewAsEmployeeId],
    queryFn: async () => {
      let url = "/service-records/pending";
      if (viewAsEmployeeId) url += `?viewAsEmployeeId=${viewAsEmployeeId}`;
      const result = await api.get<MonthlyServiceRecord[]>(url);
      return unwrapResult(result);
    },
    enabled: !customerId,
  });

  const { data: overview, isLoading: isOverviewLoading } = useQuery<CustomerOverviewItem[]>({
    queryKey: ["/api/service-records/overview", selectedYear, selectedMonth, viewAsEmployeeId],
    queryFn: async () => {
      let url = `/service-records/overview?year=${selectedYear}&month=${selectedMonth}`;
      if (viewAsEmployeeId) url += `&viewAsEmployeeId=${viewAsEmployeeId}`;
      const result = await api.get<CustomerOverviewItem[]>(url);
      return unwrapResult(result);
    },
    enabled: !customerId,
  });

  const { data: periodCheck, isLoading: isPeriodCheckLoading } = useQuery<PeriodCheckResponse>({
    queryKey: ["/api/service-records/check-period", customerId, selectedYear, selectedMonth, viewAsEmployeeId],
    queryFn: async () => {
      let url = `/service-records/check-period?customerId=${customerId}&year=${selectedYear}&month=${selectedMonth}`;
      if (viewAsEmployeeId) url += `&viewAsEmployeeId=${viewAsEmployeeId}`;
      const result = await api.get<PeriodCheckResponse>(url);
      return unwrapResult(result);
    },
    enabled: !!customerId,
  });

  // Mutation to create a new service record
  const createRecordMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) {
        throw new Error("Nicht angemeldet");
      }
      const result = await api.post<MonthlyServiceRecord>("/service-records", {
        customerId,
        employeeId: viewAsEmployeeId || user.id,
        year: selectedYear,
        month: selectedMonth,
      });
      return unwrapResult(result);
    },
    onSuccess: (newRecord) => {
      toast({ title: "Leistungsnachweis erstellt" });
      invalidateRelated(queryClient, "service-records");
      navigate(`/service-records/${newRecord.id}`);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
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

  const visiblePendingRecords = (pendingRecords ?? []).filter(
    (r) => !(r.year === selectedYear && r.month === selectedMonth),
  );
  const showPendingBanner = visiblePendingRecords.length > 0;
  const singlePendingRecord = visiblePendingRecords.length === 1 ? visiblePendingRecords[0] : null;

  const handleBannerClick = () => {
    if (singlePendingRecord) {
      setSelectedYear(singlePendingRecord.year);
      setSelectedMonth(singlePendingRecord.month);
      navigate(`/service-records/${singlePendingRecord.id}`);
    } else {
      setPendingSheetOpen(true);
    }
  };

  return (
    <Layout>
      <div className={componentStyles.pageHeader}>
        <div className={componentStyles.pageHeaderTop}>
          {customerId && (
            <Link href={`/customer/${customerId}`}>
              <Button variant="ghost" size="icon" className="shrink-0" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
          )}
          <h1 className={componentStyles.pageTitle} data-testid="text-title">
            {customerId && selectedCustomer 
              ? `Leistungsnachweise: ${selectedCustomer.vorname} ${selectedCustomer.nachname}`
              : "Leistungsnachweise"
            }
          </h1>
        </div>
      </div>

      {showPendingBanner && (
        <div
          className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer hover:bg-amber-100 transition-colors"
          data-testid="banner-pending"
          onClick={handleBannerClick}
        >
          <div className="flex items-center gap-2 text-amber-800">
            <AlertCircle className={iconSize.sm} />
            <span className="text-sm font-medium flex-1">
              {singlePendingRecord ? (
                <>
                  1 Leistungsnachweis offen –{" "}
                  <PendingBannerLabel record={singlePendingRecord} />
                </>
              ) : (
                <>
                  {visiblePendingRecords.length} Leistungsnachweise benötigen noch Unterschriften
                </>
              )}
            </span>
            <ChevronRight className={`${iconSize.sm} ml-auto`} />
          </div>
        </div>
      )}

      <Sheet open={pendingSheetOpen} onOpenChange={setPendingSheetOpen}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto" data-testid="sheet-pending-list">
          <SheetHeader>
            <SheetTitle>Offene Leistungsnachweise</SheetTitle>
          </SheetHeader>
          <div className="mt-4 flex flex-col gap-2">
            {visiblePendingRecords.map((record) => (
              <PendingListItem
                key={record.id}
                record={record}
                onSelect={() => {
                  setSelectedYear(record.year);
                  setSelectedMonth(record.month);
                  setPendingSheetOpen(false);
                  navigate(`/service-records/${record.id}`);
                }}
              />
            ))}
          </div>
        </SheetContent>
      </Sheet>

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
            <OverviewSections
              overview={overview}
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
              monthLabel={`${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
            />
          )}
        </>
      )}

      {/* Customer detail view */}
      {customerId && periodCheck && (
        <CustomerDetailView
          periodCheck={periodCheck}
          records={records ?? []}
          customerId={customerId}
          selectedYear={selectedYear}
          selectedMonth={selectedMonth}
          onCreateRecord={() => createRecordMutation.mutate()}
          isCreating={createRecordMutation.isPending}
        />
      )}
    </Layout>
  );
}

function PendingBannerLabel({ record }: { record: MonthlyServiceRecord }) {
  const { data: customer } = useQuery<Customer>({
    queryKey: ["customer", record.customerId],
    queryFn: async () => {
      const result = await api.get<Customer>(`/customers/${record.customerId}`);
      return unwrapResult(result);
    },
  });
  const customerName = customer ? `${customer.vorname} ${customer.nachname}` : "Kunde";
  return (
    <span data-testid="banner-pending-label">
      {customerName}, {MONTH_NAMES[record.month - 1]} {record.year}
    </span>
  );
}

function PendingListItem({ record, onSelect }: { record: MonthlyServiceRecord; onSelect: () => void }) {
  const { data: customer } = useQuery<Customer>({
    queryKey: ["customer", record.customerId],
    queryFn: async () => {
      const result = await api.get<Customer>(`/customers/${record.customerId}`);
      return unwrapResult(result);
    },
  });
  const customerName = customer ? `${customer.vorname} ${customer.nachname}` : "Kunde laden...";

  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left"
      data-testid={`item-pending-${record.id}`}
    >
      <Card className="hover:bg-muted/50 transition-colors">
        <CardContent className="p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2">
                <User className={`${iconSize.sm} text-muted-foreground`} />
                <span className="font-medium truncate">{customerName}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className={iconSize.xs} />
                <span>{MONTH_NAMES[record.month - 1]} {record.year}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StatusBadge type="record" value={record.status} />
              <ChevronRight className={`${iconSize.sm} text-muted-foreground`} />
            </div>
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

interface CustomerDetailViewProps {
  periodCheck: PeriodCheckResponse;
  records: MonthlyServiceRecord[];
  customerId: number;
  selectedYear: number;
  selectedMonth: number;
  onCreateRecord: () => void;
  isCreating: boolean;
}

function CustomerDetailView({
  periodCheck,
  records,
  customerId,
  selectedYear,
  selectedMonth,
  onCreateRecord,
  isCreating,
}: CustomerDetailViewProps) {
  const completedRecordsCount = records.filter((r) => r.status === "completed").length;
  const coveredAppointments = periodCheck.coveredBySingleCount + periodCheck.coveredByMonthlyCount;
  const readyCount = periodCheck.uncoveredDocumentedCount;
  const undocumentedCount = periodCheck.undocumentedCount;
  const hasRecords = records.length > 0;
  const hasAnyAppointments = periodCheck.documentedCount > 0 || undocumentedCount > 0;
  const showEmptyState = !hasRecords && !hasAnyAppointments;

  const deadline = computeDeadlineInfo(selectedYear, selectedMonth);
  const showStatusHeader = completedRecordsCount > 0 || readyCount > 0 || undocumentedCount > 0;

  return (
    <div className="flex flex-col gap-4">
      {showStatusHeader && (
        <Card data-testid="card-status-header">
          <CardContent className="p-4 sm:p-5">
            <div className="flex flex-col divide-y divide-border">
              {completedRecordsCount > 0 && (
                <div
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  data-testid="status-completed"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5 shrink-0 w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                      <Check className={`${iconSize.sm} text-green-600`} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-green-700" data-testid="text-completed-label">
                        {completedRecordsCount} {completedRecordsCount === 1 ? "Leistungsnachweis" : "Leistungsnachweise"} abgeschlossen
                      </p>
                      {coveredAppointments > 0 && (
                        <p className="text-sm text-muted-foreground">
                          {coveredAppointments} {coveredAppointments === 1 ? "Termin" : "Termine"} abgedeckt
                          {(periodCheck.coveredBySingleCount > 0 || periodCheck.coveredByMonthlyCount > 0) && " ("}
                          {periodCheck.coveredBySingleCount > 0 && `${periodCheck.coveredBySingleCount} Einzel`}
                          {periodCheck.coveredBySingleCount > 0 && periodCheck.coveredByMonthlyCount > 0 && ", "}
                          {periodCheck.coveredByMonthlyCount > 0 && `${periodCheck.coveredByMonthlyCount} monatlich`}
                          {(periodCheck.coveredBySingleCount > 0 || periodCheck.coveredByMonthlyCount > 0) && ")"}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {readyCount > 0 && (
                <div
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  data-testid="status-ready"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5 shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <FileText className={`${iconSize.sm} text-primary`} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium" data-testid="text-ready-label">
                        {readyCount} {readyCount === 1 ? "Termin" : "Termine"} bereit für Leistungsnachweis
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Monatlichen Leistungsnachweis für {readyCount === 1 ? "diesen Termin" : `diese ${readyCount} Termine`} erstellen.
                      </p>
                      {deadline && (
                        <div className="mt-1">
                          <DeadlineHint info={deadline} />
                        </div>
                      )}
                    </div>
                  </div>
                  {periodCheck.canCreateRecord && (
                    <Button
                      onClick={onCreateRecord}
                      disabled={isCreating}
                      className="w-full sm:w-auto shrink-0"
                      data-testid="button-create-record"
                    >
                      {isCreating ? (
                        <Loader2 className={`${iconSize.sm} animate-spin mr-2`} />
                      ) : (
                        <Plus className={`${iconSize.sm} mr-2`} />
                      )}
                      Monatlichen Leistungsnachweis erstellen
                    </Button>
                  )}
                </div>
              )}

              {undocumentedCount > 0 && (
                <div
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  data-testid="status-undocumented"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5 shrink-0 w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
                      <AlertCircle className={`${iconSize.sm} text-amber-600`} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-amber-700" data-testid="text-undocumented-label">
                        {undocumentedCount} {undocumentedCount === 1 ? "Termin" : "Termine"} noch nicht dokumentiert
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Termine dokumentieren, damit der Leistungsnachweis erstellt werden kann.
                      </p>
                      {deadline && (
                        <div className="mt-1">
                          <DeadlineHint info={deadline} />
                        </div>
                      )}
                    </div>
                  </div>
                  <Link
                    href={`/service-records/open?customerId=${customerId}&year=${selectedYear}&month=${selectedMonth}`}
                    className="w-full sm:w-auto shrink-0"
                  >
                    <Button variant="outline" className="w-full sm:w-auto" data-testid="button-to-appointments">
                      Offene Termine anzeigen
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {hasRecords && (
        <div className="flex flex-col gap-2" data-testid="section-existing-records">
          <h2 className="text-sm font-medium text-muted-foreground px-1">
            Bereits erstellte Leistungsnachweise
          </h2>
          <div className="flex flex-col gap-2">
            {records.map((record) => (
              <ServiceRecordCard key={record.id} record={record} />
            ))}
          </div>
        </div>
      )}

      {showEmptyState && (
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
    </div>
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
      const result = await api.get<Customer>(`/customers/${record.customerId}`);
      return unwrapResult(result);
    },
  });

  return (
    <Link href={`/service-records/${record.id}`}>
      <Card data-testid={`card-record-${record.id}`}>
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
              <StatusBadge type="record" value={record.status} />
              <ChevronRight className={`${iconSize.sm} text-muted-foreground`} />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

