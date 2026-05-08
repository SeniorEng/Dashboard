import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/patterns/status-badge";
import { useToast } from "@/hooks/use-toast";
import {
  useAdminMonthClosingReadiness,
  useAdminCloseMonth,
  useAdminReopenMonth,
  useAdminBatchCloseMonth,
  type AdminEmployeeReadiness,
} from "@/features/time-tracking/hooks/use-month-closing";
import { iconSize, componentStyles } from "@/design-system";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowLeft, Lock, Unlock, Loader2, CheckCircle2, AlertTriangle,
  ChevronDown, CalendarX, PenLine, Users, CalendarClock,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
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

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function formatDate(isoDate: string): string {
  const parts = isoDate.split("-");
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function EmployeeStatusLabel({ emp }: { emp: AdminEmployeeReadiness }) {
  if (emp.isClosed) {
    return <StatusBadge type="month" value="closed" data-testid={`badge-status-${emp.userId}`} />;
  }
  if (emp.ready) {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5" data-testid={`badge-status-${emp.userId}`}><CheckCircle2 className="h-3 w-3" />Bereit</span>;
  }
  return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5" data-testid={`badge-status-${emp.userId}`}><AlertTriangle className="h-3 w-3" />Blocker</span>;
}

function EmployeeRow({
  emp,
  year,
  month,
  onClose,
  onReopen,
  isClosing,
  isReopening,
  isSuperAdmin,
}: {
  emp: AdminEmployeeReadiness;
  year: number;
  month: number;
  onClose: (emp: AdminEmployeeReadiness) => void;
  onReopen: (emp: AdminEmployeeReadiness) => void;
  isClosing: boolean;
  isReopening: boolean;
  isSuperAdmin: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasBlockers = !emp.isClosed && !emp.ready;
  const blockerCount = emp.openAppointments.length + emp.unsignedAppointments.length;

  return (
    <div className="border rounded-lg" data-testid={`employee-row-${emp.userId}`}>
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => hasBlockers && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Users className={`${iconSize.sm} text-gray-500 shrink-0`} />
          <span className="font-medium text-sm truncate" data-testid={`text-employee-name-${emp.userId}`}>{emp.displayName}</span>
          <EmployeeStatusLabel emp={emp} />
          {hasBlockers && (
            <span className="text-xs text-gray-500">
              ({blockerCount} Blocker)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!emp.isClosed && emp.ready && isSuperAdmin && (
            <Button
              size="sm"
              variant="outline"
              className="text-teal-700 border-teal-200 hover:bg-teal-50"
              onClick={(e) => { e.stopPropagation(); onClose(emp); }}
              disabled={isClosing}
              data-testid={`button-close-${emp.userId}`}
              title="Manueller Notabschluss (Geschäftsführung)"
            >
              {isClosing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
              Manuell abschließen
            </Button>
          )}
          {emp.isClosed && isSuperAdmin && (
            <Button
              size="sm"
              variant="outline"
              className="text-amber-700 border-amber-200 hover:bg-amber-50"
              onClick={(e) => { e.stopPropagation(); onReopen(emp); }}
              disabled={isReopening}
              data-testid={`button-reopen-${emp.userId}`}
            >
              {isReopening ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Unlock className="h-3 w-3 mr-1" />}
              Wiedereröffnen
            </Button>
          )}
          {hasBlockers && (
            <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
          )}
        </div>
      </div>

      {expanded && hasBlockers && (
        <div className="px-4 pb-3 border-t bg-gray-50/50">
          {emp.openAppointments.length > 0 && (
            <div className="mt-3" data-testid={`blockers-open-${emp.userId}`}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <CalendarX className="h-3.5 w-3.5 text-red-500" />
                <span className="text-xs font-medium text-red-700">
                  {emp.openAppointments.length} offene(r) Termin(e)
                </span>
              </div>
              <div className="flex flex-col gap-1 ml-5">
                {emp.openAppointments.map((apt) => (
                  <Link
                    key={apt.id}
                    href={`/appointment/${apt.id}`}
                    className="text-xs text-red-600 hover:underline flex items-center gap-2 bg-red-50 rounded px-2 py-1"
                  >
                    <span>{formatDate(apt.date)} {apt.scheduledStart?.slice(0, 5)}</span>
                    <span className="truncate">{apt.customerName}</span>
                    <StatusBadge type="status" value={apt.status} className="text-[10px] ml-auto" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {emp.unsignedAppointments.length > 0 && (
            <div className="mt-3" data-testid={`blockers-unsigned-${emp.userId}`}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <PenLine className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-medium text-amber-700">
                  {emp.unsignedAppointments.length} Termin(e) ohne Unterschrift
                </span>
              </div>
              <div className="flex flex-col gap-1 ml-5">
                {emp.unsignedAppointments.map((apt) => (
                  <Link
                    key={apt.id}
                    href={`/appointment/${apt.id}`}
                    className="text-xs text-amber-600 hover:underline flex items-center gap-2 bg-amber-50 rounded px-2 py-1"
                  >
                    <span>{formatDate(apt.date)} {apt.scheduledStart?.slice(0, 5)}</span>
                    <span className="truncate">{apt.customerName}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {!emp.hasTimeEntries && (
            <div className="mt-3 text-xs text-gray-500 ml-5" data-testid={`blocker-no-entries-${emp.userId}`}>
              Keine Zeiteinträge oder abgeschlossene Termine vorhanden.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminMonthClosing() {
  const { toast } = useToast();
  const today = new Date();
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [batchCloseConfirm, setBatchCloseConfirm] = useState(false);
  const [closeTarget, setCloseTarget] = useState<AdminEmployeeReadiness | null>(null);
  const [reopenTarget, setReopenTarget] = useState<AdminEmployeeReadiness | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const { user } = useAuth();
  const isSuperAdmin = !!user?.isSuperAdmin;

  const cutoffYear = selectedMonth === 12 ? selectedYear + 1 : selectedYear;
  const cutoffMonth = selectedMonth === 12 ? 1 : selectedMonth + 1;
  const { data: cutoffData } = useQuery<{ cutoff: string; year: number; month: number }>({
    queryKey: ["month-close-cutoff", cutoffYear, cutoffMonth, selectedYear, selectedMonth],
    queryFn: async () => {
      const r = await api.get<{ cutoff: string; year: number; month: number }>(`/time-entries/month-close/cutoff/${selectedYear}/${selectedMonth}`);
      return unwrapResult(r);
    },
  });

  const { data, isLoading, isRefetching } = useAdminMonthClosingReadiness(selectedYear, selectedMonth);
  const closeMutation = useAdminCloseMonth();
  const reopenMutation = useAdminReopenMonth();
  const batchCloseMutation = useAdminBatchCloseMonth();

  const employees = data?.employees ?? [];

  const stats = useMemo(() => {
    const closed = employees.filter(e => e.isClosed).length;
    const ready = employees.filter(e => !e.isClosed && e.ready).length;
    const blocked = employees.filter(e => !e.isClosed && !e.ready).length;
    return { closed, ready, blocked, total: employees.length };
  }, [employees]);

  const sortedEmployees = useMemo(() => {
    return [...employees].sort((a, b) => {
      if (a.isClosed !== b.isClosed) return a.isClosed ? 1 : -1;
      if (a.ready !== b.ready) return a.ready ? -1 : 1;
      return a.displayName.localeCompare(b.displayName, "de");
    });
  }, [employees]);

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);
  }, []);

  const monthName = MONTH_NAMES[selectedMonth - 1];

  const handleClose = (emp: AdminEmployeeReadiness) => {
    setCloseTarget(emp);
  };

  const handleConfirmClose = () => {
    if (!closeTarget) return;
    closeMutation.mutate(
      { userId: closeTarget.userId, year: selectedYear, month: selectedMonth },
      {
        onSuccess: () => {
          toast({ title: `${monthName} ${selectedYear} für ${closeTarget.displayName} abgeschlossen` });
          setCloseTarget(null);
        },
        onError: (error: Error) => {
          toast({ title: "Fehler", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  const handleReopen = (emp: AdminEmployeeReadiness) => {
    setReopenTarget(emp);
  };

  const handleConfirmReopen = () => {
    if (!reopenTarget) return;
    if (reopenReason.trim().length < 10) {
      toast({ title: "Begründung erforderlich", description: "Bitte gib mindestens 10 Zeichen Begründung an.", variant: "destructive" });
      return;
    }
    reopenMutation.mutate(
      { userId: reopenTarget.userId, year: selectedYear, month: selectedMonth, reason: reopenReason.trim() },
      {
        onSuccess: () => {
          toast({ title: `${monthName} ${selectedYear} für ${reopenTarget.displayName} wieder geöffnet` });
          setReopenTarget(null);
          setReopenReason("");
        },
        onError: (error: Error) => {
          toast({ title: "Fehler", description: error.message, variant: "destructive" });
        },
      }
    );
  };

  const handleBatchClose = () => {
    batchCloseMutation.mutate(
      { year: selectedYear, month: selectedMonth },
      {
        onSuccess: (data) => {
          toast({ title: `${data.closedCount} Mitarbeiter abgeschlossen` });
          setBatchCloseConfirm(false);
        },
        onError: (error: Error) => {
          toast({ title: "Fehler", description: error.message, variant: "destructive" });
          setBatchCloseConfirm(false);
        },
      }
    );
  };

  return (
    <Layout variant="admin">
      <div className={componentStyles.pageHeader}>
        <div className={componentStyles.pageHeaderTop}>
          <Link href="/admin">
            <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <div className={componentStyles.pageHeaderTitleWrap}>
            <h1 className={componentStyles.pageTitle} data-testid="text-page-title">Monatsabschluss</h1>
          </div>
        </div>
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

        {stats.ready > 0 && isSuperAdmin && (
          <Button
            className="bg-teal-600 hover:bg-teal-700 ml-auto"
            onClick={() => setBatchCloseConfirm(true)}
            disabled={batchCloseMutation.isPending}
            data-testid="button-batch-close"
            title="Manueller Notabschluss aller Bereiten (Geschäftsführung)"
          >
            {batchCloseMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Lock className="h-4 w-4 mr-2" />
            )}
            Alle bereit manuell abschließen ({stats.ready})
          </Button>
        )}
      </div>

      {cutoffData?.cutoff && (
        <Card className="mb-4 border-teal-200 bg-teal-50/50" data-testid="card-cutoff-info">
          <CardContent className="p-4 flex items-center gap-3">
            <CalendarClock className="h-5 w-5 text-teal-600 shrink-0" />
            <div className="text-sm text-gray-700">
              Automatischer Monatsabschluss am{" "}
              <span className="font-semibold text-teal-700" data-testid="text-cutoff-date">
                {cutoffData.cutoff.split("-").reverse().join(".")}
              </span>{" "}
              um 23:00 Uhr. Reminder gehen am T-3, T-1 und am Cutoff-Tag raus.
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-600 mb-4">
        <span><span className="font-semibold text-gray-900" data-testid="text-stats-total">{stats.total}</span> Mitarbeiter</span>
        <span className="text-gray-300">|</span>
        <span><span className="font-semibold text-green-700" data-testid="text-stats-closed">{stats.closed}</span> abgeschlossen</span>
        <span className="text-gray-300">|</span>
        <span><span className="font-semibold text-teal-700" data-testid="text-stats-ready">{stats.ready}</span> bereit</span>
        <span className="text-gray-300">|</span>
        <span><span className="font-semibold text-amber-700" data-testid="text-stats-blocked">{stats.blocked}</span> mit Blockern</span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
        </div>
      ) : sortedEmployees.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Users className={`${iconSize["2xl"]} mx-auto mb-4 text-gray-300`} />
            <p className="text-gray-500">Keine aktiven Mitarbeiter gefunden.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2" data-testid="employee-list">
          {isRefetching && (
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Aktualisiere...
            </div>
          )}
          {sortedEmployees.map((emp) => (
            <EmployeeRow
              key={emp.userId}
              emp={emp}
              year={selectedYear}
              month={selectedMonth}
              onClose={handleClose}
              onReopen={handleReopen}
              isClosing={closeMutation.isPending && closeMutation.variables?.userId === emp.userId}
              isReopening={reopenMutation.isPending && reopenMutation.variables?.userId === emp.userId}
              isSuperAdmin={isSuperAdmin}
            />
          ))}
        </div>
      )}

      <AlertDialog open={batchCloseConfirm} onOpenChange={setBatchCloseConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Alle bereiten Mitarbeiter abschließen?</AlertDialogTitle>
            <AlertDialogDescription>
              Der {monthName} {selectedYear} wird für {stats.ready} Mitarbeiter abgeschlossen.
              Fehlende Pausen werden automatisch ergänzt und alle Einträge gesperrt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-batch-close">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-teal-600 hover:bg-teal-700"
              onClick={handleBatchClose}
              disabled={batchCloseMutation.isPending}
              data-testid="button-confirm-batch-close"
            >
              {batchCloseMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Lock className="h-4 w-4 mr-2" />
              )}
              Alle abschließen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!closeTarget} onOpenChange={(open) => !open && setCloseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Monat abschließen?</AlertDialogTitle>
            <AlertDialogDescription>
              Der {monthName} {selectedYear} für{" "}
              <span className="font-medium">{closeTarget?.displayName}</span> wird abgeschlossen.
              Fehlende Pausen werden automatisch ergänzt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-teal-600 hover:bg-teal-700"
              onClick={handleConfirmClose}
              disabled={closeMutation.isPending}
              data-testid="button-confirm-close-month"
            >
              {closeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Lock className="h-4 w-4 mr-2" />}
              Abschließen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!reopenTarget} onOpenChange={(open) => { if (!open) { setReopenTarget(null); setReopenReason(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Monat wiedereröffnen?</AlertDialogTitle>
            <AlertDialogDescription>
              Der {monthName} {selectedYear} für{" "}
              <span className="font-medium">{reopenTarget?.displayName}</span> wird wieder geöffnet.
              Automatische Pausen werden entfernt. Diese Aktion wird im Audit-Log dokumentiert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <label htmlFor="reopen-reason" className="text-sm font-medium text-gray-700 mb-1 block">
              Begründung (Pflichtfeld)
            </label>
            <Textarea
              id="reopen-reason"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="z.B. Korrektur eines fehlenden Zeiteintrags nach Absprache mit dem Mitarbeiter"
              rows={3}
              maxLength={500}
              data-testid="input-reopen-reason"
            />
            <div className="text-xs text-gray-500 mt-1">{reopenReason.length}/500 Zeichen</div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              onClick={handleConfirmReopen}
              disabled={reopenMutation.isPending || reopenReason.trim().length < 10 || !isSuperAdmin}
              data-testid="button-confirm-reopen"
            >
              {reopenMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Unlock className="h-4 w-4 mr-2" />}
              Wiedereröffnen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
