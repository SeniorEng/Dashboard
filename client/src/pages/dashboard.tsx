import { useState, useMemo, useCallback } from "react";
import { Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments } from "@/features/appointments";
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
import {
  formatDateISO,
  formatGermanDate,
  parseLocalDate,
  isWeekend,
} from "@shared/utils/datetime";
import { Plus, Loader2 } from "lucide-react";
import { getHolidayMap } from "@shared/utils/holidays";
import { iconSize } from "@/design-system";
import { useDayTimeEntries, useCreateTimeEntry, useUpdateTimeEntry, useDeleteTimeEntry } from "@/features/time-tracking/hooks/use-time-entries";
import { useTimeEntryForm } from "@/features/time-tracking/hooks/use-time-entry-form";
import { useTimeEntryConflict } from "@/features/time-tracking/hooks/use-time-entry-conflict";
import { TimeEntryDialog } from "@/features/time-tracking/components/time-entry-dialog";
import { TIME_ENTRY_TYPE_CONFIG } from "@/features/time-tracking/constants";
import { useMonthClosingStatus } from "@/features/time-tracking/hooks/use-month-closing";
import { useAuth } from "@/hooks/use-auth";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";
import { ErrorState } from "@/components/patterns/error-state";
import type { TimeEntry, TimeEntryType } from "@/lib/api/types";
import { useAppointmentCoverage } from "@/features/appointments/hooks/use-appointment-coverage";
import { FULL_DAY_TYPES, type TimelineItem, CoverageBanner, TimeEntryCard, WeekStrip } from "@/features/dashboard";
import { entrySupportsFullDayToggle } from "@shared/domain/time-entries";

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
  const dateString = formatDateISO(selectedDate);

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
  const createMutation = useCreateTimeEntry();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const createForm = useTimeEntryForm();
  const createValidation = useTimeEntryConflict(
    showCreateDialog ? createForm.formState : null,
    showCreateDialog
  );

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

  const handleOpenCreate = useCallback((entryType: TimeEntryType) => {
    const isFullDayType = FULL_DAY_TYPES.includes(entryType) || entrySupportsFullDayToggle(entryType);
    let startTime: string | undefined;
    let endTime: string | undefined;
    if (!isFullDayType) {
      const now = new Date();
      const roundedMin = Math.floor(now.getMinutes() / 5) * 5;
      const sh = String(now.getHours()).padStart(2, "0");
      const sm = String(roundedMin).padStart(2, "0");
      const eh = String(Math.min(now.getHours() + 1, 23)).padStart(2, "0");
      startTime = `${sh}:${sm}`;
      endTime = `${eh}:${sm}`;
    }
    const effectiveTargetUserId = isAdmin && viewAsEmployeeId ? viewAsEmployeeId : null;
    createForm.reset({
      entryType,
      entryDate: dateString,
      isFullDay: isFullDayType,
      startTime,
      endTime,
      targetUserId: effectiveTargetUserId,
    });
    setShowCreateDialog(true);
  }, [createForm, dateString, isAdmin, viewAsEmployeeId]);

  const handleCreate = useCallback(() => {
    const data = createForm.toCreateRequest();
    createMutation.mutate(data, {
      onSuccess: () => setShowCreateDialog(false),
    });
  }, [createForm, createMutation]);

  const today = useMemo(() => new Date(), []);
  const todayString = formatDateISO(today);
  const isToday = todayString === dateString;

  const selectedHoliday = useMemo(
    () => getHolidayMap(selectedDate.getFullYear()).get(dateString),
    [selectedDate, dateString]
  );

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
  const isSelectedWeekend = isWeekend(dateString);
  const canCreateOnSelectedDate = !isSelectedWeekend;

  return (
    <Layout>
      <WeekStrip selectedDate={selectedDate} setSelectedDate={setSelectedDate} />

      {coverageData && (coverageData.currentMonth.uncoveredCustomers.length > 0 || coverageData.nextMonth.uncoveredCustomers.length > 0) && (
        <div className="mb-4" data-testid="coverage-banners">
          <CoverageBanner data={coverageData} />
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground/90" data-testid="text-date">
              {isToday ? (
                <>
                  <span className="sm:hidden">Heute, {formatGermanDate(selectedDate, "d. MMMM")}</span>
                  <span className="hidden sm:inline">Heute, {formatGermanDate(selectedDate, "EEEE, d. MMMM")}</span>
                </>
              ) : (
                <>
                  <span className="sm:hidden">{formatGermanDate(selectedDate, "EEEEEE, d. MMMM")}</span>
                  <span className="hidden sm:inline">{formatGermanDate(selectedDate, "EEEE, d. MMMM")}</span>
                </>
              )}
            </h2>
            {selectedHoliday && (
              <p className="text-sm font-medium text-red-600" data-testid="text-holiday">
                {selectedHoliday}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canCreateOnSelectedDate && (
              <Link href={`/new-appointment?date=${dateString}&from=dashboard`}>
                <Button
                  size="sm"
                  className="shadow-lg shadow-primary/20"
                  data-testid="button-new-entry"
                >
                  <Plus className={`${iconSize.sm} mr-1`} /> Neuer Eintrag
                </Button>
              </Link>
            )}
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
          <div className="text-center py-8 min-h-[200px] text-muted-foreground space-y-4" data-testid="empty-day">
            <p>Keine Termine oder Einträge für diesen Tag.</p>
            {!isMonthClosed && canCreateOnSelectedDate && (
              <div className="flex flex-col sm:flex-row gap-2 justify-center items-stretch sm:items-center max-w-md mx-auto px-4">
                <Link href={`/new-appointment?date=${dateString}&from=dashboard`} className="w-full sm:w-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto min-h-[44px]"
                    data-testid="button-empty-create-appointment"
                  >
                    <Plus className={`${iconSize.sm} mr-1`} /> Termin
                  </Button>
                </Link>
                {(["verfuegbar", "pause"] as const).map((type) => {
                  const cfg = TIME_ENTRY_TYPE_CONFIG[type];
                  const Icon = cfg.icon;
                  return (
                    <Button
                      key={type}
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto min-h-[44px]"
                      onClick={() => handleOpenCreate(type)}
                      data-testid={`button-empty-create-${type}`}
                    >
                      <Icon className={`${iconSize.sm} mr-1`} /> {cfg.label}
                    </Button>
                  );
                })}
              </div>
            )}
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
        supportsFullDayToggle={editForm.supportsFullDayToggle}
        submitLabel="Speichern"
        testIdPrefix="dashboard-edit"
      />

      <TimeEntryDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        title="Neuer Eintrag"
        formState={createForm.formState}
        onFieldChange={createForm.updateField}
        validation={createValidation}
        onSubmit={handleCreate}
        isSubmitting={createMutation.isPending}
        isFullDayType={createForm.isFullDayType}
        supportsDateRange={createForm.supportsDateRange}
        supportsFullDayToggle={createForm.supportsFullDayToggle}
        submitLabel="Speichern"
        testIdPrefix="dashboard-create"
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
