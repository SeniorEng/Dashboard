import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSearch, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";
import { api, unwrapResult } from "@/lib/api";
import {
  useDeleteTimeEntry,
  useUpdateTimeEntry,
  useTimeEntryConflict,
  useTimeEntryForm,
  useMonthClosingStatus,
  TimeEntryDialog,
  MissingBreaksBanner,
  TimeOverviewSummary,
  CalendarGrid,
  DayDetailPanel,
  MonthClosingSection,
  MONTH_NAMES,
  type DayTimeEntry,
} from "@/features/time-tracking";
import type { TimeEntryType, TimesPageData } from "@/lib/api/types";
import { todayISO } from "@shared/utils/datetime";
import { iconSize, componentStyles } from "@/design-system";

export default function MyTimes() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const todayStr = useMemo(() => todayISO(), []);
  const dayDetailRef = useRef<HTMLDivElement>(null);
  const missingBreaksRef = useRef<HTMLDivElement>(null);

  const [selectedYear, setSelectedYear] = useState(() => {
    const params = new URLSearchParams(searchString);
    const y = parseInt(params.get("year") || "");
    return y >= 2020 && y <= 2100 ? y : new Date().getFullYear();
  });
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const params = new URLSearchParams(searchString);
    const m = parseInt(params.get("month") || "");
    return m >= 1 && m <= 12 ? m : new Date().getMonth() + 1;
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const y = parseInt(params.get("year") || "");
    const m = parseInt(params.get("month") || "");
    if (y >= 2020 && y <= 2100) setSelectedYear(y);
    if (m >= 1 && m <= 12) setSelectedMonth(m);
  }, [searchString]);

  const [showEditDialog, setShowEditDialog] = useState(false);

  const { viewAsEmployeeId } = useViewAsEmployee();
  const { data: pageData, isLoading } = useQuery({
    queryKey: ["time-entries", "page-data", { year: selectedYear, month: selectedMonth, viewAsEmployeeId }] as const,
    queryFn: async ({ signal }) => {
      const base = `/time-entries/page-data/${selectedYear}/${selectedMonth}`;
      const endpoint = viewAsEmployeeId ? `${base}?viewAsEmployeeId=${viewAsEmployeeId}` : base;
      const result = await api.get<TimesPageData>(endpoint, signal);
      return unwrapResult(result);
    },
    enabled: selectedYear >= 2020 && selectedYear <= 2100 && selectedMonth >= 1 && selectedMonth <= 12,
    staleTime: 30000,
  });
  const { data: closingData } = useMonthClosingStatus(selectedYear, selectedMonth);
  const timeOverview = pageData?.overview;
  const vacationSummary = pageData?.vacationSummary;
  const isMonthLocked = !!(closingData?.closing && !closingData.closing.reopenedAt) && !user?.isAdmin;
  const deleteMutation = useDeleteTimeEntry();
  const updateMutation = useUpdateTimeEntry();

  const editForm = useTimeEntryForm();

  const editValidation = useTimeEntryConflict(
    showEditDialog && editForm.formState.id ? {
      entryDate: editForm.formState.entryDate,
      entryType: editForm.formState.entryType,
      startTime: editForm.formState.startTime,
      endTime: editForm.formState.endTime,
      isFullDay: editForm.formState.isFullDay,
      excludeEntryId: editForm.formState.id,
    } : null,
    showEditDialog
  );

  const daysWithMissingBreaks = pageData?.openTasks?.daysWithMissingBreaks || [];
  const missingBreakDates = useMemo(
    () => new Set(daysWithMissingBreaks.map(d => d.date)),
    [daysWithMissingBreaks]
  );

  const entriesByDate = timeOverview?.otherEntries ?? {};
  const appointmentsByDate = timeOverview?.appointments ?? {};

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);
  }, []);

  const handleDayClick = useCallback((date: string) => {
    setSelectedDate(date);
  }, []);

  const navigateToNewEntry = useCallback((date?: string, entryType?: TimeEntryType) => {
    if (isMonthLocked) return;
    const params = new URLSearchParams();
    params.set("date", date || selectedDate || todayStr);
    params.set("tab", "eintrag");
    params.set("from", "my-times");
    if (entryType) params.set("entryType", entryType);
    setLocation(`/new-appointment?${params.toString()}`);
  }, [setLocation, selectedDate, todayStr, isMonthLocked]);

  const handleOpenNewEntry = useCallback(() => {
    navigateToNewEntry();
  }, [navigateToNewEntry]);

  const handleAddBreak = useCallback((date: string) => {
    navigateToNewEntry(date, "pause");
  }, [navigateToNewEntry]);

  const handleEditEntry = useCallback((entry: DayTimeEntry) => {
    if (isMonthLocked) return;
    editForm.setForEdit(entry);
    setShowEditDialog(true);
  }, [editForm, isMonthLocked]);

  const handleUpdate = useCallback(() => {
    if (!editForm.formState.id || isMonthLocked) return;
    updateMutation.mutate({
      id: editForm.formState.id,
      data: editForm.toUpdateRequest(),
    }, {
      onSuccess: () => {
        toast({ title: "Eintrag aktualisiert" });
        setShowEditDialog(false);
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });
  }, [editForm, updateMutation, toast, isMonthLocked]);

  const handleDeleteEntry = useCallback((id: number) => {
    if (isMonthLocked) return;
    deleteMutation.mutate(id, {
      onSuccess: () => toast({ title: "Eintrag gelöscht" }),
      onError: (error: Error) => toast({ title: "Fehler", description: error.message, variant: "destructive" }),
    });
  }, [deleteMutation, toast, isMonthLocked]);

  useEffect(() => {
    if (window.location.hash === "#missing-breaks" && daysWithMissingBreaks.length > 0) {
      requestAnimationFrame(() => {
        missingBreaksRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      history.replaceState(null, "", window.location.pathname);
    }
  }, [daysWithMissingBreaks]);

  const handleSelectMissingBreakDate = useCallback((date: string, year: number, month: number) => {
    setSelectedYear(year);
    setSelectedMonth(month);
    setSelectedDate(date);
    requestAnimationFrame(() => {
      dayDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const selectedDayEntries = selectedDate ? entriesByDate[selectedDate] || [] : [];
  const selectedDayAppointments = selectedDate ? appointmentsByDate[selectedDate] || [] : [];

  return (
    <Layout variant="wide">
          <div ref={missingBreaksRef}>
            <MissingBreaksBanner
              daysWithMissingBreaks={daysWithMissingBreaks}
              onSelectDate={handleSelectMissingBreakDate}
              onAddBreak={handleAddBreak}
            />
          </div>

          <div className={componentStyles.pageHeader}>
            <div className={componentStyles.pageHeaderTop}>
              <h1 className={componentStyles.pageTitle} data-testid="text-page-title">Meine Zeiten</h1>
            </div>
            <div className={componentStyles.pageHeaderActions}>
              <Button
                size="sm"
                className={componentStyles.pageHeaderActionBtn}
                onClick={handleOpenNewEntry}
                disabled={isMonthLocked}
                title={isMonthLocked ? "Monat ist abgeschlossen" : undefined}
                data-testid="button-new-entry"
              >
                <Plus className={`${iconSize.sm} mr-1`} />
                Neuer Eintrag
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-3 mb-6" data-testid="month-selector">
            <Select value={selectedYear.toString()} onValueChange={(v) => setSelectedYear(parseInt(v))}>
              <SelectTrigger className="w-[100px]" data-testid="select-year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedMonth.toString()} onValueChange={(v) => setSelectedMonth(parseInt(v))}>
              <SelectTrigger className="flex-1" data-testid="select-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((name, idx) => (
                  <SelectItem key={idx + 1} value={(idx + 1).toString()}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <TimeEntryDialog
            open={showEditDialog}
            onOpenChange={(open) => {
              if (open && isMonthLocked) return;
              setShowEditDialog(open);
            }}
            title="Zeiteintrag bearbeiten"
            formState={editForm.formState}
            onFieldChange={editForm.updateField}
            validation={editValidation}
            onSubmit={handleUpdate}
            isSubmitting={updateMutation.isPending}
            isFullDayType={editForm.isFullDayType}
            supportsDateRange={editForm.supportsDateRange}
            testIdPrefix="edit"
          />

          <TimeOverviewSummary
            timeOverview={timeOverview}
            vacationSummary={vacationSummary}
            selectedMonth={selectedMonth}
            selectedYear={selectedYear}
            isEuRentner={!!user?.isEuRentner}
          />

          {isMonthLocked && (
            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 mb-4" data-testid="banner-month-locked">
              <Lock className="h-4 w-4 text-amber-600 shrink-0" />
              <p className="text-sm text-amber-800">
                Dieser Monat ist abgeschlossen. Zeiteinträge können nicht mehr hinzugefügt, bearbeitet oder gelöscht werden. Bei Bedarf kann ein Admin den Monat wieder öffnen.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            <CalendarGrid
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
              selectedDate={selectedDate}
              entriesByDate={entriesByDate}
              appointmentsByDate={appointmentsByDate}
              missingBreakDates={missingBreakDates}
              isLoading={isLoading}
              onDayClick={handleDayClick}
            />

            <div ref={dayDetailRef}>
              <DayDetailPanel
                selectedDate={selectedDate}
                entries={selectedDayEntries as DayTimeEntry[]}
                appointments={selectedDayAppointments}
                onEditEntry={handleEditEntry}
                onDeleteEntry={handleDeleteEntry}
                onAddEntry={handleOpenNewEntry}
                isAdmin={!!user?.isAdmin}
                isDeleting={deleteMutation.isPending}
                isMonthLocked={isMonthLocked}
                isEuRentner={!!user?.isEuRentner}
              />
            </div>
          </div>

          <MonthClosingSection year={selectedYear} month={selectedMonth} />
    </Layout>
  );
}
