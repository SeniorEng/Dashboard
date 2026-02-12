import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { useEmployees } from "@/features/customers";
import { iconSize } from "@/design-system";
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
  Palmtree,
  Thermometer,
  Coffee,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Loader2,
  FileText,
  Users,
  Settings,
  Unlock,
} from "lucide-react";
import type { TimeEntryType, TimeEntryWithUser, VacationSummary } from "@/lib/api/types";

const TIME_ENTRY_TYPE_CONFIG: Record<TimeEntryType, { label: string; icon: React.ElementType; color: string; bgColor: string }> = {
  urlaub: { label: "Urlaub", icon: Palmtree, color: "text-green-700", bgColor: "bg-green-100" },
  krankheit: { label: "Krankheit", icon: Thermometer, color: "text-red-700", bgColor: "bg-red-100" },
  pause: { label: "Pause", icon: Coffee, color: "text-amber-700", bgColor: "bg-amber-100" },
  bueroarbeit: { label: "Büroarbeit", icon: Briefcase, color: "text-blue-700", bgColor: "bg-blue-100" },
  vertrieb: { label: "Vertrieb", icon: Briefcase, color: "text-purple-700", bgColor: "bg-purple-100" },
  schulung: { label: "Schulung", icon: FileText, color: "text-indigo-700", bgColor: "bg-indigo-100" },
  besprechung: { label: "Besprechung", icon: FileText, color: "text-teal-700", bgColor: "bg-teal-100" },
  sonstiges: { label: "Sonstiges", icon: FileText, color: "text-gray-700", bgColor: "bg-gray-100" },
};

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
      queryClient.invalidateQueries({ queryKey: ["admin-month-closings"] });
      queryClient.invalidateQueries({ queryKey: ["admin-time-entries"] });
      setReopenTarget(null);
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

  const handlePrevMonth = () => {
    if (selectedMonth === 1) {
      setSelectedMonth(12);
      setSelectedYear(selectedYear - 1);
    } else {
      setSelectedMonth(selectedMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (selectedMonth === 12) {
      setSelectedMonth(1);
      setSelectedYear(selectedYear + 1);
    } else {
      setSelectedMonth(selectedMonth + 1);
    }
  };

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

  // Update form when vacation data loads
  useMemo(() => {
    if (selectedUserVacation) {
      setVacationDays(selectedUserVacation.totalDays.toString());
      setCarryOverDays(selectedUserVacation.carryOverDays.toString());
    }
  }, [selectedUserVacation]);

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-6xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900" data-testid="text-page-title">
                Zeiterfassung
              </h1>
              <p className="text-gray-600">Übersicht aller Mitarbeiter-Zeiteinträge</p>
            </div>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <Card>
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
                <div className="text-xs text-gray-500">Einträge gesamt</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-green-700">{stats.vacation}</div>
                <div className="text-xs text-gray-500">Urlaubstage</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-red-700">{stats.sick}</div>
                <div className="text-xs text-gray-500">Krankheitstage</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="text-2xl font-bold text-blue-700">{stats.other}</div>
                <div className="text-xs text-gray-500">Sonstige</div>
              </CardContent>
            </Card>
          </div>

          {/* Filters */}
          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" onClick={handlePrevMonth} data-testid="button-prev-month">
                    <ChevronLeft className={iconSize.md} />
                  </Button>
                  <span className="font-medium min-w-[150px] text-center">
                    {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
                  </span>
                  <Button variant="ghost" size="icon" onClick={handleNextMonth} data-testid="button-next-month">
                    <ChevronRight className={iconSize.md} />
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  <Label className="text-sm text-gray-500">Mitarbeiter:</Label>
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
                </div>

                <div className="flex items-center gap-2">
                  <Label className="text-sm text-gray-500">Art:</Label>
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
              </div>
            </CardContent>
          </Card>

          {/* Entries List */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : entries && entries.length > 0 ? (
            <div className="flex flex-col gap-3">
              {Object.entries(entriesByEmployee).map(([employeeName, employeeEntries]) => {
                const employee = employees?.find(e => e.displayName === employeeName);
                return (
                  <Card key={employeeName}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <Users className={iconSize.md} />
                          {employeeName}
                          {employee && closedUserIds.has(employee.id) && (
                            <StatusBadge type="month" value="closed" size="sm" />
                          )}
                        </CardTitle>
                        <div className="flex items-center gap-1">
                          {employee && closedUserIds.has(employee.id) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-amber-700 hover:text-amber-800 hover:bg-amber-50"
                              onClick={() => setReopenTarget({ userId: employee.id, userName: employee.displayName })}
                              data-testid={`button-reopen-month-${employee.id}`}
                            >
                              <Unlock className={`${iconSize.sm} mr-1`} />
                              Wiedereröffnen
                            </Button>
                          )}
                          {employee && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEditVacation(employee.id, employee.displayName)}
                              data-testid={`button-edit-vacation-${employee.id}`}
                            >
                              <Settings className={`${iconSize.sm} mr-1`} />
                              Urlaubskontingent
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {employeeEntries
                          .sort((a, b) => a.entryDate.localeCompare(b.entryDate))
                          .map((entry) => {
                            const config = TIME_ENTRY_TYPE_CONFIG[entry.entryType as TimeEntryType];
                            const Icon = config.icon;
                            return (
                              <div
                                key={entry.id}
                                className={`p-3 rounded-lg ${config.bgColor} flex items-center justify-between`}
                                data-testid={`time-entry-${entry.id}`}
                              >
                                <div className="flex items-center gap-3">
                                  <Icon className={`${iconSize.md} ${config.color}`} />
                                  <div>
                                    <div className={`font-medium ${config.color}`}>{config.label}</div>
                                    <div className="text-sm text-gray-600">
                                      {formatDateForDisplay(entry.entryDate, { weekday: "short", day: "numeric", month: "short" })}
                                      {entry.startTime && entry.endTime && (
                                        <span className="ml-2">
                                          {entry.startTime.slice(0, 5)} - {entry.endTime.slice(0, 5)}
                                        </span>
                                      )}
                                      {entry.isFullDay && <span className="ml-2">(Ganztägig)</span>}
                                    </div>
                                  </div>
                                </div>
                                {entry.notes && (
                                  <div className="text-sm text-gray-600 max-w-[200px] truncate">
                                    {entry.notes}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    </CardContent>
                  </Card>
                );
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

          {/* Closed months for employees without entries in current view */}
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
                  return (
                    <Card key={closing.id}>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <Users className={iconSize.md} />
                            {emp.displayName}
                            <StatusBadge type="month" value="closed" size="sm" />
                          </CardTitle>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-amber-700 hover:text-amber-800 hover:bg-amber-50"
                            onClick={() => setReopenTarget({ userId: emp.id, userName: emp.displayName })}
                            data-testid={`button-reopen-month-${emp.id}`}
                          >
                            <Unlock className={`${iconSize.sm} mr-1`} />
                            Wiedereröffnen
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-gray-500">Keine Zeiteinträge in diesem Monat.</p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            );
          })()}

          {/* Reopen Month Confirmation */}
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
                    <>
                      <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                      Wird geöffnet...
                    </>
                  ) : (
                    <>
                      <Unlock className={`${iconSize.sm} mr-1`} />
                      Wiedereröffnen
                    </>
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Vacation Edit Dialog */}
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
                        <span className="font-medium text-green-700">{selectedUserVacation.usedDays} Tage</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Geplant:</span>
                        <span className="font-medium text-blue-700">{selectedUserVacation.plannedDays} Tage</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Verfügbar:</span>
                        <span className="font-medium text-teal-700">{selectedUserVacation.remainingDays} Tage</span>
                      </div>
                      <div className="flex justify-between text-sm border-t pt-2">
                        <span>Krankheitstage:</span>
                        <span className="font-medium text-red-700">{selectedUserVacation.sickDays} Tage</span>
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
                        <>
                          <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                          Speichern...
                        </>
                      ) : (
                        "Speichern"
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </Layout>
  );
}
