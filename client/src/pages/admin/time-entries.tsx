import { useState, useMemo, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { useEmployees } from "@/features/customers";
import { iconSize, componentStyles } from "@/design-system";
import { StatusBadge } from "@/components/patterns/status-badge";
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
  ArrowLeft,
  Calendar,
  Loader2,
  Users,
  Settings,
  Unlock,
  Plus,
  Pencil,
  Trash2,
  Lock,
} from "lucide-react";
import type { TimeEntryType, TimeEntryWithUser, VacationSummary, TimeEntry } from "@/lib/api/types";
import { TIME_ENTRY_TYPE_CONFIG } from "@/features/time-tracking/constants";
import { TimeEntryDialog } from "@/features/time-tracking/components/time-entry-dialog";
import { useTimeEntryForm } from "@/features/time-tracking/hooks/use-time-entry-form";
import { useTimeEntryConflict } from "@/features/time-tracking/hooks/use-time-entry-conflict";

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

export default function AdminTimeEntries() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const today = new Date();
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [selectedUserId, setSelectedUserId] = useState<string>("all");
  const [selectedEntryType, setSelectedEntryType] = useState<string>("all");
  const [showVacationDialog, setShowVacationDialog] = useState(false);
  const [vacationEditUser, setVacationEditUser] = useState<{ id: number; name: string } | null>(null);
  const [vacationDays, setVacationDays] = useState("30");
  const [carryOverDays, setCarryOverDays] = useState("0");
  const [reopenTarget, setReopenTarget] = useState<{ userId: number; userName: string } | null>(null);
  const [closeMonthTarget, setCloseMonthTarget] = useState<{ userId: number; userName: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; label: string } | null>(null);

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForUser, setCreateForUser] = useState<{ id: number; name: string } | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editEntry, setEditEntry] = useState<TimeEntryWithUser | null>(null);

  const createForm = useTimeEntryForm();
  const editForm = useTimeEntryForm();
  const createValidation = useTimeEntryConflict(
    createForUser ? { ...createForm.formState, targetUserId: createForUser.id } : createForm.formState,
    showCreateDialog
  );
  const editValidation = useTimeEntryConflict(
    editEntry ? { ...editForm.formState, excludeEntryId: editEntry.id, targetUserId: editEntry.userId } : editForm.formState,
    showEditDialog
  );

  const { data: employees } = useEmployees();

  const employeeFilterOptions = useMemo(() => [
    { value: "all", label: "Alle Mitarbeiter" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })) || []),
  ], [employees]);

  const { data: entries, isLoading } = useQuery({
    queryKey: ["admin-time-entries", selectedYear, selectedMonth, selectedUserId, selectedEntryType],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("year", selectedYear.toString());
      params.set("month", selectedMonth.toString());
      if (selectedUserId !== "all") params.set("userId", selectedUserId);
      if (selectedEntryType !== "all") params.set("entryType", selectedEntryType);
      
      const result = await api.get<TimeEntryWithUser[]>(`/admin/time-entries?${params.toString()}`, signal);
      return unwrapResult(result);
    },
  });

  const { data: selectedUserVacation, isLoading: vacationLoading } = useQuery({
    queryKey: ["admin-vacation-summary", vacationEditUser?.id, selectedYear],
    queryFn: async ({ signal }) => {
      if (!vacationEditUser) return null;
      const result = await api.get<VacationSummary>(
        `/admin/time-entries/vacation-summary/${vacationEditUser.id}/${selectedYear}`,
        signal
      );
      return unwrapResult(result);
    },
    enabled: !!vacationEditUser,
  });

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["admin-time-entries"] });
    queryClient.invalidateQueries({ queryKey: ["admin-month-closings"] });
  }, [queryClient]);

  const updateVacationMutation = useMutation({
    mutationFn: async (data: { userId: number; year: number; totalDays: number; carryOverDays: number }) => {
      const result = await api.put("/admin/time-entries/vacation-allowance", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Urlaubskontingent aktualisiert" });
      queryClient.invalidateQueries({ queryKey: ["admin-vacation-summary"] });
      setShowVacationDialog(false);
      setVacationEditUser(null);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  interface MonthClosingRecord {
    id: number;
    userId: number;
    year: number;
    month: number;
    closedAt: string;
    closedByUserId: number;
    reopenedAt: string | null;
    reopenedByUserId: number | null;
  }

  const { data: monthClosings } = useQuery({
    queryKey: ["admin-month-closings", selectedYear, selectedMonth],
    queryFn: async ({ signal }) => {
      const result = await api.get<{ closings: MonthClosingRecord[] }>(
        `/time-entries/month-closings/admin/${selectedYear}/${selectedMonth}`,
        signal
      );
      return unwrapResult(result);
    },
  });

  const closedUserIds = useMemo(() => {
    if (!monthClosings?.closings) return new Set<number>();
    return new Set(
      monthClosings.closings
        .filter((c) => !c.reopenedAt)
        .map((c) => c.userId)
    );
  }, [monthClosings]);

  const reopenMonthMutation = useMutation({
    mutationFn: async (data: { userId: number; year: number; month: number }) => {
      const result = await api.post("/time-entries/reopen-month", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear} wieder geöffnet` });
      invalidateAll();
      setReopenTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const closeMonthMutation = useMutation({
    mutationFn: async (data: { userId: number; year: number; month: number }) => {
      const result = await api.post("/time-entries/admin/close-month", data);
      return unwrapResult(result);
    },
    onSuccess: (_data, variables) => {
      const emp = employees?.find(e => e.id === variables.userId);
      toast({ title: `${MONTH_NAMES[selectedMonth - 1]} ${selectedYear} für ${emp?.displayName || "Mitarbeiter"} abgeschlossen` });
      invalidateAll();
      setCloseMonthTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.post<TimeEntry>("/time-entries", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Zeiteintrag erstellt" });
      invalidateAll();
      setShowCreateDialog(false);
      setCreateForUser(null);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const result = await api.put<TimeEntry>(`/time-entries/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Zeiteintrag aktualisiert" });
      invalidateAll();
      setShowEditDialog(false);
      setEditEntry(null);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const result = await api.delete(`/time-entries/${id}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Zeiteintrag gelöscht" });
      invalidateAll();
      setDeleteTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const entriesByEmployee = useMemo(() => {
    if (!entries) return {};
    return entries.reduce((acc, entry) => {
      const key = entry.user.displayName;
      if (!acc[key]) acc[key] = [];
      acc[key].push(entry);
      return acc;
    }, {} as Record<string, TimeEntryWithUser[]>);
  }, [entries]);

  const stats = useMemo(() => {
    if (!entries) return { vacation: 0, sick: 0, other: 0, total: 0 };
    return entries.reduce(
      (acc, entry) => {
        acc.total++;
        if (entry.entryType === "urlaub") acc.vacation++;
        else if (entry.entryType === "krankheit") acc.sick++;
        else acc.other++;
        return acc;
      },
      { vacation: 0, sick: 0, other: 0, total: 0 }
    );
  }, [entries]);

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);
  }, []);

  const handleEditVacation = (userId: number, userName: string) => {
    setVacationEditUser({ id: userId, name: userName });
    setShowVacationDialog(true);
  };

  const handleSaveVacation = () => {
    if (!vacationEditUser) return;
    updateVacationMutation.mutate({
      userId: vacationEditUser.id,
      year: selectedYear,
      totalDays: parseInt(vacationDays) || 30,
      carryOverDays: parseInt(carryOverDays) || 0,
    });
  };

  const handleOpenCreate = useCallback((userId: number, userName: string) => {
    const monthStr = String(selectedMonth).padStart(2, "0");
    setCreateForUser({ id: userId, name: userName });
    createForm.reset({ entryDate: `${selectedYear}-${monthStr}-01` });
    setShowCreateDialog(true);
  }, [createForm, selectedYear, selectedMonth]);

  const handleCreate = useCallback(() => {
    if (!createForUser) return;
    const req = createForm.toCreateRequest();
    createMutation.mutate({ ...req, targetUserId: createForUser.id });
  }, [createForm, createForUser, createMutation]);

  const handleOpenEdit = useCallback((entry: TimeEntryWithUser) => {
    setEditEntry(entry);
    editForm.reset({
      entryType: entry.entryType as TimeEntryType,
      entryDate: entry.entryDate,
      startTime: entry.startTime || "",
      endTime: entry.endTime || "",
      isFullDay: entry.isFullDay,
      notes: entry.notes || "",
    });
    setShowEditDialog(true);
  }, [editForm]);

  const handleUpdate = useCallback(() => {
    if (!editEntry) return;
    const req = editForm.toUpdateRequest();
    updateMutation.mutate({ id: editEntry.id, data: req });
  }, [editForm, editEntry, updateMutation]);

  useEffect(() => {
    if (selectedUserVacation) {
      setVacationDays(selectedUserVacation.totalDays.toString());
      setCarryOverDays(selectedUserVacation.carryOverDays.toString());
    }
  }, [selectedUserVacation]);

  const renderEmployeeCard = (employeeName: string, employeeEntries: TimeEntryWithUser[], employeeId?: number) => {
    const isClosed = employeeId ? closedUserIds.has(employeeId) : false;

    return (
      <Card key={employeeName}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className={iconSize.md} />
              {employeeName}
              {isClosed && <StatusBadge type="month" value="closed" size="sm" />}
            </CardTitle>
            <div className="flex items-center gap-1 flex-wrap">
              {employeeId && !isClosed && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-teal-700 hover:text-teal-800 hover:bg-teal-50"
                  onClick={() => setCloseMonthTarget({ userId: employeeId, userName: employeeName })}
                  data-testid={`button-close-month-${employeeId}`}
                >
                  <Lock className={`${iconSize.sm} mr-1`} />
                  Abschließen
                </Button>
              )}
              {employeeId && isClosed && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-amber-700 hover:text-amber-800 hover:bg-amber-50"
                  onClick={() => setReopenTarget({ userId: employeeId, userName: employeeName })}
                  data-testid={`button-reopen-month-${employeeId}`}
                >
                  <Unlock className={`${iconSize.sm} mr-1`} />
                  Wiedereröffnen
                </Button>
              )}
              {employeeId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-blue-700 hover:text-blue-800 hover:bg-blue-50"
                  onClick={() => handleOpenCreate(employeeId, employeeName)}
                  data-testid={`button-add-entry-${employeeId}`}
                >
                  <Plus className={`${iconSize.sm} mr-1`} />
                  Eintrag
                </Button>
              )}
              {employeeId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleEditVacation(employeeId, employeeName)}
                  data-testid={`button-edit-vacation-${employeeId}`}
                >
                  <Settings className={`${iconSize.sm} mr-1`} />
                  Urlaubskontingent
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {employeeEntries.length === 0 ? (
            <p className="text-sm text-gray-500">Keine Zeiteinträge in diesem Monat.</p>
          ) : (
            <div className="space-y-2">
              {employeeEntries
                .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
                .map((entry) => {
                  const config = TIME_ENTRY_TYPE_CONFIG[entry.entryType as TimeEntryType];
                  const Icon = config.icon;
                  const isAutoGenerated = (entry as any).isAutoGenerated;
                  return (
                    <div
                      key={entry.id}
                      className={`p-3 rounded-lg ${config.bgColor} flex items-center justify-between group`}
                      data-testid={`time-entry-${entry.id}`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <Icon className={`${iconSize.md} ${config.color} shrink-0`} />
                        <div className="min-w-0">
                          <div className={`font-medium ${config.color} flex items-center gap-2`}>
                            {config.label}
                            {isAutoGenerated && (
                              <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">Auto</span>
                            )}
                          </div>
                          <div className="text-sm text-gray-600">
                            {formatDateForDisplay(entry.entryDate, { weekday: "short", day: "numeric", month: "short" })}
                            {entry.startTime && entry.endTime && (
                              <span className="ml-2">
                                {entry.startTime.slice(0, 5)} - {entry.endTime.slice(0, 5)}
                              </span>
                            )}
                            {entry.isFullDay && <span className="ml-2">(Ganztägig)</span>}
                          </div>
                          {entry.notes && (
                            <div className="text-xs text-gray-500 truncate mt-0.5">{entry.notes}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0">
                        {!isAutoGenerated && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleOpenEdit(entry)}
                              aria-label="Bearbeiten"
                              data-testid={`button-edit-entry-${entry.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                              onClick={() => setDeleteTarget({
                                id: entry.id,
                                label: `${config.label} am ${formatDateForDisplay(entry.entryDate, { day: "numeric", month: "short" })}`,
                              })}
                              aria-label="Löschen"
                              data-testid={`button-delete-entry-${entry.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <Layout variant="wide">
          <div className={componentStyles.pageHeader}>
            <div className={componentStyles.pageHeaderTop}>
              <Link href="/admin">
                <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                  <ArrowLeft className={iconSize.md} />
                </Button>
              </Link>
              <div className={componentStyles.pageHeaderTitleWrap}>
                <h1 className={componentStyles.pageTitle} data-testid="text-page-title">Zeiterfassung</h1>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-600 mb-4">
            <span><span className="font-semibold text-gray-900" data-testid="text-stats-total">{stats.total}</span> Einträge</span>
            <span className="text-gray-300">|</span>
            <span><span className="font-semibold text-green-700" data-testid="text-stats-vacation">{stats.vacation}</span> Urlaub</span>
            <span className="text-gray-300">|</span>
            <span><span className="font-semibold text-red-700" data-testid="text-stats-sick">{stats.sick}</span> Krankheit</span>
            <span className="text-gray-300">|</span>
            <span><span className="font-semibold text-blue-700" data-testid="text-stats-other">{stats.other}</span> Sonstige</span>
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-6">
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
              <SelectTrigger className="w-[140px]" data-testid="select-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((name, idx) => (
                  <SelectItem key={idx + 1} value={(idx + 1).toString()}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SearchableSelect
              options={employeeFilterOptions}
              value={selectedUserId}
              onValueChange={setSelectedUserId}
              placeholder="Alle Mitarbeiter"
              searchPlaceholder="Mitarbeiter suchen..."
              emptyText="Kein Mitarbeiter gefunden."
              className="w-[180px]"
              data-testid="select-employee"
            />
            <Select value={selectedEntryType} onValueChange={setSelectedEntryType}>
              <SelectTrigger className="w-[150px]" data-testid="select-entry-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Arten</SelectItem>
                {Object.entries(TIME_ENTRY_TYPE_CONFIG).map(([type, config]) => (
                  <SelectItem key={type} value={type}>
                    {config.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : entries && entries.length > 0 ? (
            <div className="flex flex-col gap-3">
              {Object.entries(entriesByEmployee).map(([employeeName, employeeEntries]) => {
                const employee = employees?.find(e => e.displayName === employeeName);
                return renderEmployeeCard(employeeName, employeeEntries, employee?.id);
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="p-12 text-center">
                <Calendar className={`${iconSize["2xl"]} mx-auto mb-4 text-gray-300`} />
                <p className="text-gray-500">Keine Zeiteinträge für diesen Zeitraum.</p>
              </CardContent>
            </Card>
          )}

          {(() => {
            if (!monthClosings?.closings || !employees) return null;
            const employeesInList = new Set(
              Object.entries(entriesByEmployee)
                .map(([name]) => employees?.find(e => e.displayName === name)?.id)
                .filter(Boolean)
            );
            const closedWithoutEntries = monthClosings.closings
              .filter((c) => !c.reopenedAt && !employeesInList.has(c.userId));
            if (closedWithoutEntries.length === 0) return null;
            return (
              <div className="flex flex-col gap-3 mt-4">
                {closedWithoutEntries.map((closing) => {
                  const emp = employees?.find((e) => e.id === closing.userId);
                  if (!emp) return null;
                  return renderEmployeeCard(emp.displayName, [], emp.id);
                })}
              </div>
            );
          })()}

          <TimeEntryDialog
            open={showCreateDialog}
            onOpenChange={(open) => {
              setShowCreateDialog(open);
              if (!open) setCreateForUser(null);
            }}
            title={`Eintrag für ${createForUser?.name || "Mitarbeiter"}`}
            formState={createForm.formState}
            onFieldChange={createForm.updateField}
            validation={createValidation}
            onSubmit={handleCreate}
            isSubmitting={createMutation.isPending}
            isFullDayType={createForm.isFullDayType}
            supportsDateRange={createForm.supportsDateRange}
            submitLabel="Erstellen"
            testIdPrefix="admin-create"
          />

          <TimeEntryDialog
            open={showEditDialog}
            onOpenChange={(open) => {
              setShowEditDialog(open);
              if (!open) setEditEntry(null);
            }}
            title={`Eintrag bearbeiten – ${editEntry?.user.displayName || ""}`}
            formState={editForm.formState}
            onFieldChange={editForm.updateField}
            validation={editValidation}
            onSubmit={handleUpdate}
            isSubmitting={updateMutation.isPending}
            isFullDayType={editForm.isFullDayType}
            supportsDateRange={false}
            submitLabel="Speichern"
            testIdPrefix="admin-edit"
          />

          <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Eintrag löschen?</AlertDialogTitle>
                <AlertDialogDescription>
                  Möchten Sie den Eintrag "{deleteTarget?.label}" wirklich löschen?
                  Diese Aktion wird im Audit-Log protokolliert.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-red-600 hover:bg-red-700"
                  onClick={() => {
                    if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
                  }}
                  disabled={deleteMutation.isPending}
                  data-testid="button-confirm-delete"
                >
                  {deleteMutation.isPending ? (
                    <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Löschen...</>
                  ) : (
                    <><Trash2 className={`${iconSize.sm} mr-1`} />Löschen</>
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={!!closeMonthTarget} onOpenChange={(open) => !open && setCloseMonthTarget(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Monat abschließen?</AlertDialogTitle>
                <AlertDialogDescription>
                  Der {MONTH_NAMES[selectedMonth - 1]} {selectedYear} für{" "}
                  <span className="font-medium">{closeMonthTarget?.userName}</span> wird abgeschlossen.
                  Fehlende Pausen werden automatisch ergänzt.
                  Diese Aktion wird im Audit-Log als Admin-Abschluss protokolliert.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-teal-600 hover:bg-teal-700"
                  onClick={() => {
                    if (closeMonthTarget) {
                      closeMonthMutation.mutate({
                        userId: closeMonthTarget.userId,
                        year: selectedYear,
                        month: selectedMonth,
                      });
                    }
                  }}
                  disabled={closeMonthMutation.isPending}
                  data-testid="button-confirm-close-month"
                >
                  {closeMonthMutation.isPending ? (
                    <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Wird abgeschlossen...</>
                  ) : (
                    <><Lock className={`${iconSize.sm} mr-1`} />Abschließen</>
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={!!reopenTarget} onOpenChange={(open) => !open && setReopenTarget(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Monat wiedereröffnen?</AlertDialogTitle>
                <AlertDialogDescription>
                  Der {MONTH_NAMES[selectedMonth - 1]} {selectedYear} für{" "}
                  <span className="font-medium">{reopenTarget?.userName}</span> wird wieder
                  geöffnet. Alle automatisch generierten Pausen werden dabei entfernt.
                  Der Mitarbeiter kann danach wieder Einträge bearbeiten.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-amber-600 hover:bg-amber-700"
                  onClick={() => {
                    if (reopenTarget) {
                      reopenMonthMutation.mutate({
                        userId: reopenTarget.userId,
                        year: selectedYear,
                        month: selectedMonth,
                      });
                    }
                  }}
                  disabled={reopenMonthMutation.isPending}
                  data-testid="button-confirm-reopen"
                >
                  {reopenMonthMutation.isPending ? (
                    <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Wird geöffnet...</>
                  ) : (
                    <><Unlock className={`${iconSize.sm} mr-1`} />Wiedereröffnen</>
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Dialog open={showVacationDialog} onOpenChange={setShowVacationDialog}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  Urlaubskontingent {selectedYear} - {vacationEditUser?.name}
                </DialogTitle>
              </DialogHeader>
              {vacationLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className={`${iconSize.lg} animate-spin`} />
                </div>
              ) : (
                <div className="space-y-4 pt-4">
                  {selectedUserVacation && (
                    <div className="p-4 rounded-lg bg-gray-50 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Genommen:</span>
                        <span className="font-medium text-green-700">{selectedUserVacation.usedDays} {selectedUserVacation.usedDays === 1 ? 'Tag' : 'Tage'}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Geplant:</span>
                        <span className="font-medium text-blue-700">{selectedUserVacation.plannedDays} {selectedUserVacation.plannedDays === 1 ? 'Tag' : 'Tage'}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Verfügbar:</span>
                        <span className="font-medium text-teal-700">{selectedUserVacation.remainingDays} {selectedUserVacation.remainingDays === 1 ? 'Tag' : 'Tage'}</span>
                      </div>
                      <div className="flex justify-between text-sm border-t pt-2">
                        <span>Krankheitstage:</span>
                        <span className="font-medium text-red-700">{selectedUserVacation.sickDays} {selectedUserVacation.sickDays === 1 ? 'Tag' : 'Tage'}</span>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="totalDays">Jahresurlaub (Tage)</Label>
                      <Input
                        id="totalDays"
                        type="number"
                        value={vacationDays}
                        onChange={(e) => setVacationDays(e.target.value)}
                        min={0}
                        max={365}
                        data-testid="input-total-days"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="carryOverDays">Resturlaub Vorjahr</Label>
                      <Input
                        id="carryOverDays"
                        type="number"
                        value={carryOverDays}
                        onChange={(e) => setCarryOverDays(e.target.value)}
                        min={0}
                        max={365}
                        data-testid="input-carry-over"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-4">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowVacationDialog(false);
                        setVacationEditUser(null);
                      }}
                    >
                      Abbrechen
                    </Button>
                    <Button
                      className="bg-teal-600 hover:bg-teal-700"
                      onClick={handleSaveVacation}
                      disabled={updateVacationMutation.isPending}
                      data-testid="button-save-vacation"
                    >
                      {updateVacationMutation.isPending ? (
                        <><Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />Speichern...</>
                      ) : (
                        "Speichern"
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
    </Layout>
  );
}
