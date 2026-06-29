import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/patterns/status-badge";
import {
  useAdminMonthClosingReadiness,
  type AdminEmployeeReadiness,
} from "@/features/time-tracking/hooks/use-month-closing";
import { iconSize, componentStyles } from "@/design-system";
import {
  ArrowLeft, Loader2, CheckCircle2, AlertTriangle,
  ChevronDown, CalendarX, PenLine, Users, CalendarClock,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";

interface MissingSignatureItem {
  id: number;
  date: string;
  scheduledStart: string | null;
  customerName: string;
  employeeName: string;
  year: number;
  month: number;
}

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function formatDate(isoDate: string): string {
  const parts = isoDate.split("-");
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

// Task #1496: Der Monatsabschluss erfolgt ausschließlich automatisch am Cutoff.
// Diese Seite ist reine Status-Anzeige (kein manueller Abschluss / kein
// Wieder-Öffnen mehr). „Bereit/Blocker" dienen nur der Information vor dem 8.
function EmployeeStatusLabel({ emp }: { emp: AdminEmployeeReadiness }) {
  if (emp.isClosed) {
    return <StatusBadge type="month" value="closed" data-testid={`badge-status-${emp.userId}`} />;
  }
  if (emp.ready) {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5" data-testid={`badge-status-${emp.userId}`}><CheckCircle2 className="h-3 w-3" />Bereit</span>;
  }
  return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5" data-testid={`badge-status-${emp.userId}`}><AlertTriangle className="h-3 w-3" />Offen</span>;
}

function EmployeeRow({ emp }: { emp: AdminEmployeeReadiness }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = !emp.isClosed && !emp.ready;
  const openCount = emp.openAppointments.length;
  const unsignedCount = emp.unsignedAppointments.length;

  return (
    <div className="border rounded-lg" data-testid={`employee-row-${emp.userId}`}>
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Users className={`${iconSize.sm} text-gray-500 shrink-0`} />
          <span className="font-medium text-sm truncate" data-testid={`text-employee-name-${emp.userId}`}>{emp.displayName}</span>
          <EmployeeStatusLabel emp={emp} />
          {hasDetails && (
            <span className="text-xs text-gray-500">
              ({openCount} offen{unsignedCount > 0 ? `, ${unsignedCount} ohne Unterschrift` : ""})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasDetails && (
            <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
          )}
        </div>
      </div>

      {expanded && hasDetails && (
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
  const today = new Date();
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);

  const { data: cutoffData } = useQuery<{ cutoff: string; year: number; month: number }>({
    queryKey: ["month-close-cutoff", selectedYear, selectedMonth],
    queryFn: async () => {
      const r = await api.get<{ cutoff: string; year: number; month: number }>(`/time-entries/month-close/cutoff/${selectedYear}/${selectedMonth}`);
      return unwrapResult(r);
    },
  });

  // Task #1496: Aktive Liste „fehlende Unterschriften nach Abschluss" — über
  // alle abgeschlossenen Monate, abgeleitet aus der „Dokumentiert"-Stufe.
  const { data: missingSigData } = useQuery<{ items: MissingSignatureItem[] }>({
    queryKey: ["month-closing-missing-signatures"],
    queryFn: async () =>
      unwrapResult(await api.get<{ items: MissingSignatureItem[] }>("/time-entries/month-closing/missing-signatures")),
    staleTime: 5 * 60 * 1000,
  });
  const missingSignatures = missingSigData?.items ?? [];

  const { data, isLoading, isRefetching } = useAdminMonthClosingReadiness(selectedYear, selectedMonth);

  const employees = data?.employees ?? [];

  const stats = useMemo(() => {
    const closed = employees.filter(e => e.isClosed).length;
    const ready = employees.filter(e => !e.isClosed && e.ready).length;
    const open = employees.filter(e => !e.isClosed && !e.ready).length;
    return { closed, ready, open, total: employees.length };
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
      </div>

      {cutoffData?.cutoff && (
        <Card className="mb-4 border-teal-200 bg-teal-50/50" data-testid="card-cutoff-info">
          <CardContent className="p-4 flex items-center gap-3">
            <CalendarClock className="h-5 w-5 text-teal-600 shrink-0" />
            <div className="text-sm text-gray-700">
              Der Monatsabschluss läuft vollautomatisch am{" "}
              <span className="font-semibold text-teal-700" data-testid="text-cutoff-date">
                {cutoffData.cutoff.split("-").reverse().join(".")}
              </span>{" "}
              um 23:00 Uhr — für jeden Mitarbeiter mit Aktivität, unabhängig von offenen
              oder noch nicht unterschriebenen Terminen. Reminder gehen am T-3, T-1 und am
              Cutoff-Tag raus. Diese Übersicht dient nur der Information; manuelles Abschließen
              oder Wiedereröffnen gibt es nicht mehr.
            </div>
          </CardContent>
        </Card>
      )}

      {missingSignatures.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50/40" data-testid="card-missing-signatures-after-close">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <PenLine className="h-5 w-5 text-amber-600 shrink-0" />
              <h2 className="text-sm font-semibold text-amber-800">
                Fehlende Unterschriften nach Abschluss ({missingSignatures.length})
              </h2>
            </div>
            <p className="text-xs text-gray-600 mb-3">
              Diese Termine sind dokumentiert, der Monat ist bereits abgeschlossen, aber es
              fehlt noch die Unterschrift. Unterschrift weiterhin nachholbar — der Eintrag
              verschwindet automatisch, sobald unterschrieben wurde.
            </p>
            <div className="flex flex-col gap-1" data-testid="list-missing-signatures-after-close">
              {missingSignatures.map((item) => (
                <Link
                  key={item.id}
                  href={`/appointment/${item.id}`}
                  className="text-xs text-amber-700 hover:underline flex items-center gap-2 bg-white border border-amber-200 rounded px-2 py-1.5"
                  data-testid={`link-missing-signature-${item.id}`}
                >
                  <span className="font-medium">{formatDate(item.date)} {item.scheduledStart?.slice(0, 5)}</span>
                  <span className="truncate">{item.customerName}</span>
                  <span className="text-gray-400 ml-auto shrink-0">{item.employeeName}</span>
                  <span className="text-gray-400 shrink-0">{MONTH_NAMES[item.month - 1]} {item.year}</span>
                </Link>
              ))}
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
        <span><span className="font-semibold text-amber-700" data-testid="text-stats-open">{stats.open}</span> mit offenen Punkten</span>
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
            <EmployeeRow key={emp.userId} emp={emp} />
          ))}
        </div>
      )}
    </Layout>
  );
}
