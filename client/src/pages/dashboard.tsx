import { useState, useMemo, useCallback } from "react";
import { Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments, useWeekAppointmentCounts } from "@/features/appointments";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { sortAppointmentsByPriority } from "@/features/appointments/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { format, addDays, startOfWeek, subWeeks, isSameDay } from "date-fns";
import { de } from "date-fns/locale";
import { Plus, ChevronsLeft, ChevronsRight, CalendarCheck, Pencil, Trash2, Loader2, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { parseLocalDate } from "@shared/utils/datetime";
import { getHolidayMap } from "@shared/utils/holidays";
import { iconSize } from "@/design-system";
import { useDayTimeEntries, useUpdateTimeEntry, useDeleteTimeEntry } from "@/features/time-tracking/hooks/use-time-entries";
import { useTimeEntryForm } from "@/features/time-tracking/hooks/use-time-entry-form";
import { useTimeEntryConflict } from "@/features/time-tracking/hooks/use-time-entry-conflict";
import { TimeEntryDialog } from "@/features/time-tracking/components/time-entry-dialog";
import { TIME_ENTRY_TYPE_CONFIG } from "@/features/time-tracking/constants";
import { useMonthClosingStatus } from "@/features/time-tracking/hooks/use-month-closing";
import { useAuth } from "@/hooks/use-auth";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";
import { ErrorState } from "@/components/patterns/error-state";
import type { TimeEntry, TimeEntryType } from "@/lib/api/types";
import type { AppointmentWithCustomer } from "@shared/types";
import { useAppointmentCoverage, type CoverageData } from "@/features/appointments/hooks/use-appointment-coverage";

const WEEKDAY_NAMES_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

const FULL_DAY_TYPES: string[] = ["urlaub", "krankheit"];

interface DayButtonProps {
  dayStr: string;
  day: Date;
  index: number;
  isSelected: boolean;
  isDayToday: boolean;
  appointmentCount: number;
  holidayName?: string;
  isWeekend: boolean;
  onSelect: (day: Date) => void;
}

function DayButton({ dayStr, day, index, isSelected, isDayToday, appointmentCount, holidayName, isWeekend, onSelect }: DayButtonProps) {
  const hasAppointments = appointmentCount > 0;

  let bgClass: string;
  if (isSelected) {
    bgClass = holidayName
      ? "bg-red-600 text-white shadow-md"
      : "bg-primary text-primary-foreground shadow-md";
  } else if (holidayName) {
    bgClass = "bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100";
  } else if (isDayToday) {
    bgClass = hasAppointments ? "bg-primary/15 text-primary ring-1 ring-primary/30" : "bg-primary/10 text-primary hover:bg-primary/20";
  } else if (hasAppointments) {
    bgClass = "bg-primary/8 ring-1 ring-primary/20 hover:bg-primary/15";
  } else if (isWeekend) {
    bgClass = "bg-muted/40 text-muted-foreground/50 hover:bg-muted/60";
  } else {
    bgClass = "bg-background hover:bg-muted";
  }

  return (
    <button
      onClick={() => onSelect(day)}
      className={`relative flex flex-col items-center justify-center flex-1 h-14 rounded-lg transition-all ${isWeekend && !isSelected ? "max-w-[32px]" : "max-w-[44px]"} ${bgClass}`}
      data-testid={`weekday-${dayStr}`}
      title={holidayName || undefined}
    >
      <span className={`text-[10px] font-medium uppercase tracking-wide ${isWeekend && !isSelected ? "opacity-40" : "opacity-70"}`}>
        {WEEKDAY_NAMES_SHORT[index]}
      </span>
      <span className={`font-semibold ${isWeekend && !isSelected ? "text-sm text-muted-foreground/50" : "text-base"} ${isDayToday && !isSelected && !holidayName ? "text-primary" : ""}`}>
        {format(day, "d")}
      </span>
      <span className={`text-[9px] font-semibold leading-none h-[10px] flex items-center justify-center ${
        hasAppointments
          ? isSelected ? "text-white/80" : holidayName ? "text-red-600" : "text-primary"
          : holidayName
            ? isSelected ? "text-white/70" : "text-red-400"
            : "opacity-0"
      }`} aria-hidden={!hasAppointments && !holidayName}>
        {hasAppointments ? appointmentCount : holidayName ? "●" : "\u00A0"}
      </span>
    </button>
  );
}

type TimelineItem =
  | { type: "appointment"; sortTime: string; data: AppointmentWithCustomer }
  | { type: "entry"; sortTime: string; data: TimeEntry };

function TimeEntryCard({
  entry,
  onEdit,
  onDelete,
  isMonthClosed,
}: {
  entry: TimeEntry;
  onEdit: (entry: TimeEntry) => void;
  onDelete: (entry: TimeEntry) => void;
  isMonthClosed: boolean;
}) {
  const config = TIME_ENTRY_TYPE_CONFIG[entry.entryType as TimeEntryType];
  if (!config) return null;
  const Icon = config.icon;
  const isAutoGenerated = entry.isAutoGenerated;
  const canModify = !isMonthClosed && !isAutoGenerated;

  return (
    <div
      className={`p-3 rounded-xl ${config.bgColor} flex items-center justify-between group`}
      data-testid={`time-entry-card-${entry.id}`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${config.bgColor} shrink-0`}>
          <Icon className={`${iconSize.md} ${config.color}`} />
        </div>
        <div className="min-w-0">
          <div className={`font-medium text-sm ${config.color} flex items-center gap-2`}>
            {config.label}
            {isAutoGenerated && (
              <span className="text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">Auto</span>
            )}
          </div>
          {entry.startTime && entry.endTime && (
            <div className="text-xs text-gray-500">
              {entry.startTime.slice(0, 5)} – {entry.endTime.slice(0, 5)}
            </div>
          )}
          {!entry.startTime && !entry.isFullDay && entry.durationMinutes && (
            <div className="text-xs text-gray-500">{entry.durationMinutes} Min.</div>
          )}
          {entry.isFullDay && !entry.startTime && (
            <div className="text-xs text-gray-500">Ganztägig</div>
          )}
          {entry.notes && (
            <div className="text-xs text-gray-500 truncate mt-0.5">{entry.notes}</div>
          )}
        </div>
      </div>
      {canModify && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onEdit(entry)}
            aria-label="Bearbeiten"
            data-testid={`button-edit-entry-${entry.id}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
            onClick={() => onDelete(entry)}
            aria-label="Löschen"
            data-testid={`button-delete-entry-${entry.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  primary: "Hauptverantw.",
  backup1: "1. Vertretung",
  backup2: "2. Vertretung",
};

function getDefaultDateForMonth(year: number, month: number): string {
  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  if (year === todayYear && month === todayMonth) {
    return format(today, "yyyy-MM-dd");
  }
  const firstOfMonth = new Date(year, month - 1, 1);
  const dayOfWeek = firstOfMonth.getDay();
  const offset = dayOfWeek === 0 ? 1 : dayOfWeek === 6 ? 2 : 0;
  const targetDate = addDays(firstOfMonth, offset);
  return format(targetDate, "yyyy-MM-dd");
}

function CoverageBanner({ data }: { data: CoverageData }) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"current" | "next">("current");

  const currentCount = data.currentMonth.uncoveredCustomers.length;
  const nextCount = data.nextMonth.uncoveredCustomers.length;
  const totalCount = currentCount + nextCount;

  if (totalCount === 0) return null;

  const activeData = activeTab === "current" ? data.currentMonth : data.nextMonth;
  const activeCount = activeTab === "current" ? currentCount : nextCount;
  const prefillDate = getDefaultDateForMonth(activeData.year, activeData.month);

  const currentMonthShort = data.currentMonth.label.split(" ")[0];
  const nextMonthShort = data.nextMonth.label.split(" ")[0];

  return (
    <div className="rounded-lg border bg-amber-50 border-amber-200 overflow-hidden" data-testid="coverage-banner">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-amber-700"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        data-testid="button-toggle-coverage"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="text-sm font-medium flex-1">
          Ohne Termin: {currentMonthShort} {currentCount} · {nextMonthShort} {nextCount}
        </span>
        {expanded ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2" data-testid="coverage-list">
          <div className="flex gap-1 mb-2" data-testid="coverage-tabs">
            <button
              className={`flex-1 text-xs font-medium py-1.5 px-2 rounded-md transition-colors ${
                activeTab === "current"
                  ? "bg-amber-200/70 text-amber-800"
                  : "text-amber-600 hover:bg-amber-100"
              }`}
              onClick={() => setActiveTab("current")}
              data-testid="button-coverage-current"
            >
              {currentMonthShort} ({currentCount})
            </button>
            <button
              className={`flex-1 text-xs font-medium py-1.5 px-2 rounded-md transition-colors ${
                activeTab === "next"
                  ? "bg-amber-200/70 text-amber-800"
                  : "text-amber-600 hover:bg-amber-100"
              }`}
              onClick={() => setActiveTab("next")}
              data-testid="button-coverage-next"
            >
              {nextMonthShort} ({nextCount})
            </button>
          </div>
          {activeCount === 0 ? (
            <p className="text-xs text-amber-600 text-center py-2" data-testid="text-coverage-empty">
              Alle Kunden haben Termine im {activeTab === "current" ? currentMonthShort : nextMonthShort}
            </p>
          ) : (
            <div className="space-y-1">
              {[...activeData.uncoveredCustomers].sort((a, b) => {
                const order = { primary: 0, backup1: 1, backup2: 2 };
                const roleDiff = (order[a.role] ?? 3) - (order[b.role] ?? 3);
                if (roleDiff !== 0) return roleDiff;
                const hvA = a.primaryEmployeeName ?? "";
                const hvB = b.primaryEmployeeName ?? "";
                return hvA.localeCompare(hvB, "de");
              }).map((customer) => (
                <div
                  key={customer.id}
                  className="flex items-center justify-between py-1.5 px-2 rounded-md bg-white/60"
                  data-testid={`coverage-customer-${customer.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-gray-800 block truncate">{customer.name}</span>
                    <span className="text-[11px] text-gray-500">
                      {ROLE_LABELS[customer.role] || customer.role}
                      {customer.role !== "primary" && customer.primaryEmployeeName && (
                        <> · HV: {customer.primaryEmployeeName}</>
                      )}
                    </span>
                  </div>
                  <Link href={`/new-appointment?date=${prefillDate}&customerId=${customer.id}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-[44px] min-w-[44px] px-2 text-xs shrink-0"
                      data-testid={`button-create-appointment-${customer.id}`}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Termin
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const isAdmin = user?.isAdmin ?? false;
  const { viewAsEmployeeId } = useViewAsEmployee();
  const searchString = useSearch();
  const [selectedDate, setSelectedDate] = useState(() => {
    const params = new URLSearchParams(searchString);
    const dateParam = params.get("date");
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      const parsed = parseLocalDate(dateParam);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  });
  const dateString = format(selectedDate, "yyyy-MM-dd");

  const { data: appointments, isLoading, error, refetch } = useAppointments(dateString);
  const { data: dayTimeEntries } = useDayTimeEntries(dateString);
  const { data: coverageData } = useAppointmentCoverage();

  const selectedYear = selectedDate.getFullYear();
  const selectedMonth = selectedDate.getMonth() + 1;
  const { data: monthClosingData } = useMonthClosingStatus(selectedYear, selectedMonth);
  const isMonthClosed = !!(monthClosingData?.closing && !monthClosingData.closing.reopenedAt);

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TimeEntry | null>(null);

  const editForm = useTimeEntryForm();
  const editValidation = useTimeEntryConflict(
    showEditDialog && editingEntry ? { ...editForm.formState, excludeEntryId: editingEntry.id } : null,
    showEditDialog
  );

  const updateMutation = useUpdateTimeEntry();
  const deleteMutation = useDeleteTimeEntry();

  const handleOpenEdit = useCallback((entry: TimeEntry) => {
    setEditingEntry(entry);
    editForm.setForEdit({
      id: entry.id,
      entryType: entry.entryType,
      entryDate: entry.entryDate,
      startTime: entry.startTime,
      endTime: entry.endTime,
      isFullDay: entry.isFullDay,
      kilometers: entry.kilometers,
      notes: entry.notes,
    });
    setShowEditDialog(true);
  }, [editForm]);

  const handleUpdate = useCallback(() => {
    if (!editingEntry) return;
    const data = editForm.toUpdateRequest();
    updateMutation.mutate({ id: editingEntry.id, data }, {
      onSuccess: () => {
        setShowEditDialog(false);
        setEditingEntry(null);
      },
    });
  }, [editForm, editingEntry, updateMutation]);

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }, [deleteTarget, deleteMutation]);

  const today = useMemo(() => new Date(), []);
  const todayString = format(today, "yyyy-MM-dd");
  const isToday = todayString === dateString;

  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [selectedDate]);

  const weekDateStrings = useMemo(() =>
    weekDays.map(d => format(d, "yyyy-MM-dd")),
    [weekDays]
  );

  const { data: weekAppointmentCounts } = useWeekAppointmentCounts(weekDateStrings);

  const holidayMap = useMemo(() => {
    const years = new Set(weekDays.map(d => d.getFullYear()));
    const map = new Map<string, string>();
    for (const year of Array.from(years)) {
      const yearMap = getHolidayMap(year);
      yearMap.forEach((v, k) => map.set(k, v));
    }
    return map;
  }, [weekDays]);

  const selectedHoliday = holidayMap.get(dateString);

  const goToPreviousWeek = () => setSelectedDate(prev => subWeeks(prev, 1));
  const goToNextWeek = () => setSelectedDate(prev => {
    const weekStart = startOfWeek(prev, { weekStartsOn: 1 });
    return addDays(weekStart, 7);
  });

  const goToToday = () => setSelectedDate(new Date());
  const monthLabel = format(selectedDate, "MMMM yyyy", { locale: de });

  const { fullDayEntries, timelineEntries } = useMemo(() => {
    const fullDay: TimeEntry[] = [];
    const timed: TimeEntry[] = [];

    if (dayTimeEntries) {
      for (const entry of dayTimeEntries) {
        if (FULL_DAY_TYPES.includes(entry.entryType) || entry.isFullDay) {
          fullDay.push(entry);
        } else {
          timed.push(entry);
        }
      }
    }

    return { fullDayEntries: fullDay, timelineEntries: timed };
  }, [dayTimeEntries]);

  const sortedTimeline = useMemo(() => {
    const items: TimelineItem[] = [];

    const sortedAppointments = appointments ? sortAppointmentsByPriority(appointments) : [];
    for (const appt of sortedAppointments) {
      items.push({
        type: "appointment",
        sortTime: appt.actualStart || appt.scheduledStart || "00:00",
        data: appt,
      });
    }

    for (const entry of timelineEntries) {
      items.push({
        type: "entry",
        sortTime: entry.startTime?.slice(0, 5) || "99:99",
        data: entry,
      });
    }

    items.sort((a, b) => a.sortTime.localeCompare(b.sortTime));
    return items;
  }, [appointments, timelineEntries]);

  const hasAnyContent = sortedTimeline.length > 0 || fullDayEntries.length > 0;

  return (
    <Layout>
      <div className="mb-6 animate-in fade-in duration-300">
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-sm font-medium text-muted-foreground capitalize" data-testid="text-month-label">
            {monthLabel}
          </span>
          <Button
            variant={isToday ? "ghost" : "outline"}
            size="sm"
            className={`h-7 text-xs px-3 ${isToday ? "text-muted-foreground/50 cursor-default" : "border-primary/30 text-primary font-medium"}`}
            onClick={goToToday}
            disabled={isToday}
            data-testid="button-go-today"
          >
            <CalendarCheck className="h-3.5 w-3.5 mr-1" />
            Heute
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={goToPreviousWeek}
            data-testid="button-prev-week"
            title="Vorherige Woche"
            aria-label="Vorherige Woche"
          >
            <ChevronsLeft className={iconSize.sm} />
          </Button>

          <div className="flex gap-1 justify-center flex-1">
            {weekDays.map((day, index) => {
              const dayStr = format(day, "yyyy-MM-dd");
              const isSelected = dayStr === dateString;
              const isDayToday = isSameDay(day, today);
              const appointmentCount = weekAppointmentCounts?.[dayStr] || 0;
              const holidayName = holidayMap.get(dayStr);

              return (
                <DayButton
                  key={dayStr}
                  dayStr={dayStr}
                  day={day}
                  index={index}
                  isSelected={isSelected}
                  isDayToday={isDayToday}
                  appointmentCount={appointmentCount}
                  holidayName={holidayName}
                  isWeekend={index >= 5}
                  onSelect={setSelectedDate}
                />
              );
            })}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={goToNextWeek}
            data-testid="button-next-week"
            title="Nächste Woche"
            aria-label="Nächste Woche"
          >
            <ChevronsRight className={iconSize.sm} />
          </Button>
        </div>
      </div>

      {coverageData && (coverageData.currentMonth.uncoveredCustomers.length > 0 || coverageData.nextMonth.uncoveredCustomers.length > 0) && (
        <div className="mb-4" data-testid="coverage-banners">
          <CoverageBanner data={coverageData} />
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground/90" data-testid="text-date">
              {isToday
                ? `Heute, ${format(selectedDate, "d. MMMM", { locale: de })}`
                : format(selectedDate, "EEEE, d. MMMM", { locale: de })}
            </h2>
            {selectedHoliday && (
              <p className="text-sm font-medium text-red-600" data-testid="text-holiday">
                {selectedHoliday}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Link href={`/new-appointment?date=${dateString}&from=dashboard`}>
              <Button
                size="sm"
                className="shadow-lg shadow-primary/20"
                data-testid="button-new-entry"
              >
                <Plus className={`${iconSize.sm} mr-1`} /> Neuer Eintrag
              </Button>
            </Link>
          </div>
        </div>

        {fullDayEntries.map((entry) => (
          <TimeEntryCard
            key={`fullday-${entry.id}`}
            entry={entry}
            onEdit={handleOpenEdit}
            onDelete={setDeleteTarget}
            isMonthClosed={isMonthClosed}
          />
        ))}

        {isLoading ? (
          <div className="min-h-[200px] space-y-3 p-2" data-testid="loading-appointments">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="animate-pulse flex items-center gap-3 p-4 rounded-xl border border-border/40">
                <div className="h-10 w-10 rounded-full bg-muted shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 bg-muted rounded" />
                  <div className="h-3 w-1/2 bg-muted rounded" />
                </div>
                <div className="h-6 w-16 bg-muted rounded-full" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="min-h-[200px]" data-testid="error-appointments">
            <ErrorState
              title="Daten konnten nicht geladen werden"
              description={error.message}
              onRetry={() => refetch()}
            />
          </div>
        ) : !hasAnyContent ? (
          <div className="text-center py-12 min-h-[200px] text-muted-foreground" data-testid="empty-day">
            <p>Keine Termine oder Einträge für diesen Tag.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 animate-in fade-in duration-300">
            {sortedTimeline.map((item) => {
              if (item.type === "appointment") {
                const effectiveEmployeeId = viewAsEmployeeId ?? user?.id;
                const isSub = !!effectiveEmployeeId && item.data.assignedEmployeeId !== effectiveEmployeeId && (!isAdmin || !!viewAsEmployeeId);
                return <AppointmentCard key={`appt-${item.data.id}`} appointment={item.data} isSubstitute={isSub} />;
              }
              return (
                <TimeEntryCard
                  key={`entry-${item.data.id}`}
                  entry={item.data}
                  onEdit={handleOpenEdit}
                  onDelete={setDeleteTarget}
                  isMonthClosed={isMonthClosed}
                />
              );
            })}
          </div>
        )}
      </div>

      <TimeEntryDialog
        open={showEditDialog}
        onOpenChange={(open) => {
          setShowEditDialog(open);
          if (!open) setEditingEntry(null);
        }}
        title="Eintrag bearbeiten"
        formState={editForm.formState}
        onFieldChange={editForm.updateField}
        validation={editValidation}
        onSubmit={handleUpdate}
        isSubmitting={updateMutation.isPending}
        isFullDayType={editForm.isFullDayType}
        supportsDateRange={false}
        submitLabel="Speichern"
        testIdPrefix="dashboard-edit"
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eintrag löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Möchten Sie den Eintrag "{deleteTarget ? TIME_ENTRY_TYPE_CONFIG[deleteTarget.entryType as TimeEntryType]?.label : ""}" wirklich löschen?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={handleConfirmDelete}
              data-testid="button-confirm-delete-entry"
            >
              {deleteMutation.isPending ? (
                <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Löschen...</>
              ) : "Löschen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
