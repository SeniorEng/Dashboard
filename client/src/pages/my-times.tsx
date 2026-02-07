import { useState, useMemo, useCallback } from "react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  useTimeOverview,
  useVacationSummary,
  useCreateTimeEntry,
  useDeleteTimeEntry,
  useUpdateTimeEntry,
  useTimeEntryConflict,
  useTimeEntryForm,
  useOpenTasks,
  TimeEntryDialog,
  MissingBreaksBanner,
  TimeOverviewSummary,
  CalendarGrid,
  DayDetailPanel,
  type DayTimeEntry,
} from "@/features/time-tracking";
import type { TimeEntryType } from "@/lib/api/types";
import { todayISO } from "@shared/utils/datetime";
import { iconSize } from "@/design-system";

export default function MyTimes() {
  const { toast } = useToast();
  const { user } = useAuth();
  const todayStr = useMemo(() => todayISO(), []);

  const [selectedYear, setSelectedYear] = useState(() => new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const { data: timeOverview, isLoading } = useTimeOverview(selectedYear, selectedMonth);
  const { data: vacationSummary } = useVacationSummary(selectedYear);
  const createMutation = useCreateTimeEntry();
  const deleteMutation = useDeleteTimeEntry();
  const updateMutation = useUpdateTimeEntry();

  const createForm = useTimeEntryForm({ entryDate: selectedDate || todayStr });
  const editForm = useTimeEntryForm();

  const createValidation = useTimeEntryConflict(
    showCreateDialog ? {
      entryDate: createForm.formState.entryDate,
      entryType: createForm.formState.entryType,
      startTime: createForm.formState.startTime,
      endTime: createForm.formState.endTime,
      isFullDay: createForm.formState.isFullDay,
    } : null,
    showCreateDialog
  );

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

  const { data: openTasks } = useOpenTasks();
  const daysWithMissingBreaks = openTasks?.daysWithMissingBreaks || [];
  const missingBreakDates = useMemo(
    () => new Set(daysWithMissingBreaks.map(d => d.date)),
    [daysWithMissingBreaks]
  );

  const entries = timeOverview?.otherEntries;
  const appointments = timeOverview?.appointments;

  const entriesByDate = useMemo(() => {
    if (!entries) return {};
    return entries.reduce((acc, entry) => {
      if (!acc[entry.entryDate]) acc[entry.entryDate] = [];
      acc[entry.entryDate].push(entry);
      return acc;
    }, {} as Record<string, typeof entries>);
  }, [entries]);

  const appointmentsByDate = useMemo(() => {
    if (!appointments) return {};
    return appointments.reduce((acc, appt) => {
      if (!acc[appt.date]) acc[appt.date] = [];
      acc[appt.date].push(appt);
      return acc;
    }, {} as Record<string, typeof appointments>);
  }, [appointments]);

  const handlePrevMonth = useCallback(() => {
    setSelectedMonth(m => {
      if (m === 1) {
        setSelectedYear(y => y - 1);
        return 12;
      }
      return m - 1;
    });
  }, []);

  const handleNextMonth = useCallback(() => {
    setSelectedMonth(m => {
      if (m === 12) {
        setSelectedYear(y => y + 1);
        return 1;
      }
      return m + 1;
    });
  }, []);

  const handleDayClick = useCallback((date: string) => {
    setSelectedDate(date);
  }, []);

  const handleOpenCreateDialog = useCallback(() => {
    createForm.reset({ entryDate: selectedDate || todayStr });
    setShowCreateDialog(true);
  }, [createForm, selectedDate, todayStr]);

  const handleCreateDialogChange = useCallback((open: boolean) => {
    setShowCreateDialog(open);
    if (open) {
      createForm.reset({ entryDate: selectedDate || todayStr });
    }
  }, [createForm, selectedDate, todayStr]);

  const handleCreate = useCallback(() => {
    const req = createForm.toCreateRequest();
    if ((req.entryType === "urlaub" || req.entryType === "krankheit") && req.endDate) {
      if (req.endDate < req.entryDate) {
        toast({ title: "Fehler", description: "Enddatum muss nach Startdatum liegen", variant: "destructive" });
        return;
      }
    }
    createMutation.mutate(req, {
      onSuccess: (data: unknown) => {
        const result = data as { _multiDay?: { count: number; message: string } };
        if (result._multiDay && result._multiDay.count > 1) {
          toast({ title: `${result._multiDay.count} Einträge erstellt` });
        } else {
          toast({ title: "Eintrag erstellt" });
        }
        setShowCreateDialog(false);
      },
      onError: (error: Error) => {
        toast({ title: "Fehler", description: error.message, variant: "destructive" });
      },
    });
  }, [createForm, createMutation, toast]);

  const handleEditEntry = useCallback((entry: DayTimeEntry) => {
    editForm.setForEdit(entry);
    setShowEditDialog(true);
  }, [editForm]);

  const handleUpdate = useCallback(() => {
    if (!editForm.formState.id) return;
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
  }, [editForm, updateMutation, toast]);

  const handleDeleteEntry = useCallback((id: number) => {
    deleteMutation.mutate(id, {
      onSuccess: () => toast({ title: "Eintrag gelöscht" }),
      onError: (error: Error) => toast({ title: "Fehler", description: error.message, variant: "destructive" }),
    });
  }, [deleteMutation, toast]);

  const handleSelectMissingBreakDate = useCallback((date: string, year: number, month: number) => {
    setSelectedYear(year);
    setSelectedMonth(month);
    setSelectedDate(date);
  }, []);

  const selectedDayEntries = selectedDate ? entriesByDate[selectedDate] || [] : [];
  const selectedDayAppointments = selectedDate ? appointmentsByDate[selectedDate] || [] : [];

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-6xl">
          <MissingBreaksBanner
            daysWithMissingBreaks={daysWithMissingBreaks}
            onSelectDate={handleSelectMissingBreakDate}
          />

          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900" data-testid="text-page-title">Meine Zeiten</h1>
              <p className="text-gray-600">Kundentermine, Urlaub und Abwesenheiten</p>
            </div>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              onClick={handleOpenCreateDialog}
              data-testid="button-new-entry"
            >
              <Plus className={`${iconSize.sm} mr-2`} />
              Neuer Eintrag
            </Button>
          </div>

          <TimeEntryDialog
            open={showCreateDialog}
            onOpenChange={handleCreateDialogChange}
            title="Neuen Zeiteintrag erstellen"
            formState={createForm.formState}
            onFieldChange={createForm.updateField}
            validation={createValidation}
            onSubmit={handleCreate}
            isSubmitting={createMutation.isPending}
            isFullDayType={createForm.isFullDayType}
            supportsDateRange={createForm.supportsDateRange}
            testIdPrefix=""
          />

          <TimeEntryDialog
            open={showEditDialog}
            onOpenChange={(open) => {
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
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <CalendarGrid
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
              selectedDate={selectedDate}
              entriesByDate={entriesByDate}
              appointmentsByDate={appointmentsByDate}
              missingBreakDates={missingBreakDates}
              isLoading={isLoading}
              onDayClick={handleDayClick}
              onPrevMonth={handlePrevMonth}
              onNextMonth={handleNextMonth}
            />

            <DayDetailPanel
              selectedDate={selectedDate}
              entries={selectedDayEntries as DayTimeEntry[]}
              appointments={selectedDayAppointments}
              onEditEntry={handleEditEntry}
              onDeleteEntry={handleDeleteEntry}
              onAddEntry={handleOpenCreateDialog}
              isAdmin={!!user?.isAdmin}
              isDeleting={deleteMutation.isPending}
            />
          </div>
        </div>
      </div>
    </Layout>
  );
}
