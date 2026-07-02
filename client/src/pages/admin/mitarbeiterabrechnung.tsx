import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Clock,
  AlertTriangle,
  ChevronRight,
  Loader2,
  CheckCircle2,
  Percent,
  TrendingUp,
  Wallet,
  Lock,
  Plus,
  Pencil,
  Trash2,
  Plane,
} from "lucide-react";
import { iconSize, componentStyles, colors } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { formatEuroDE } from "@shared/utils/money";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateTimeEntry,
  useUpdateTimeEntry,
  useDeleteTimeEntry,
} from "@/features/time-tracking/hooks/use-time-entries";
import { useTimeEntryForm } from "@/features/time-tracking/hooks/use-time-entry-form";
import { useTimeEntryConflict } from "@/features/time-tracking/hooks/use-time-entry-conflict";
import { TimeEntryDialog } from "@/features/time-tracking/components/time-entry-dialog";
import { useAllVacationSummaries } from "@/features/time-tracking/hooks/use-vacation-summaries";
import { VacationDialog } from "@/features/team/components/vacation-dialog";
import { TIME_ENTRY_TYPE_CONFIG } from "@/features/time-tracking/constants";
import type { TimeEntryType } from "@/lib/api/types";

const CATEGORY_LABELS: Record<string, string> = {
  hw: "Hauswirtschaft",
  ab: "Alltagsbegleitung",
  feiertage: "Feiertage",
  kilometer: "Kilometer",
};
const CATEGORY_UNIT: Record<string, string> = {
  hw: "Std",
  ab: "Std",
  feiertage: "Std",
  kilometer: "km",
};

interface ErfasstBucket {
  hw: number;
  ab: number;
  feiertage: number;
  kilometer: number;
}
interface SaldoBucket {
  hw: number;
  ab: number;
  feiertage: number;
  kilometer: number;
}
interface MinijobPay {
  bruttoCents: number;
  uebertragVormonatCents: number;
  auszahlbarCents: number;
  uebertragNeuCents: number;
  limitCents: number;
  kappung: boolean;
}
interface OverviewRow {
  employeeId: number;
  vorname: string;
  nachname: string;
  employmentType: string;
  isEuRentner: boolean;
  erfasst: ErfasstBucket;
  saldo: SaldoBucket;
  stundenkontoSaldo: number;
  kilometerSaldo: number;
  unsignedAppointmentCount: number;
  unsignedMinutes: number;
  minijob: MinijobPay | null;
  isClosed: boolean;
}
interface Kpis {
  erfassteStunden: { current: number; previous: number; deltaPct: number | null };
  abrechenbareStunden: { current: number; previous: number; deltaPct: number | null };
  produktivquote: { current: number | null; gemeinkostenStunden: number };
  wachstum: { produktivDeltaPct: number | null; gemeinkostenDeltaPct: number | null };
  stundenkontoSaldo: number;
  offeneTermine: { hours: number; count: number };
  activeEmployees: number;
  minijobKappung: { count: number };
}
interface OverviewData {
  year: number;
  month: number;
  earningsLimitCents: number;
  standDate: string;
  kpis: Kpis;
  rows: OverviewRow[];
}

interface AccountCell {
  category: string;
  anfangsbestand: number;
  anfangsbestandType: "go_live" | "carryover";
  erfasst: number;
  bezahlt: number;
  bezahltIsDefault: boolean;
  saldo: number;
}
interface DrillAppointment {
  id: number;
  date: string;
  scheduledStart: string | null;
  status: string;
  customerName: string;
  serviceMinutes: number;
  travelMinutes: number;
  travelKm: number;
  customerKm: number;
}
interface DrillTimeEntry {
  id: number;
  entryType: string;
  entryDate: string;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  kilometers: number | null;
  notes: string | null;
}
interface DrillRow extends OverviewRow {
  stundenHauswirtschaft: number;
  stundenAlltagsbegleitung: number;
  stundenErstberatung: number;
  stundenAnfahrt: number;
  stundenSonstiges: number;
  stundenLeerfahrten: number;
  stundenFeiertage: number;
  tageUrlaub: number;
  tageKrankheit: number;
  urlaubStunden: number;
  krankheitStunden: number;
  kilometer: number;
  kilometerAnfahrt: number;
  kilometerKunden: number;
  kilometerSonstige: number;
  kilometerLeerfahrten: number;
  dailySollHours: number;
}
interface DrillData {
  year: number;
  month: number;
  employeeId: number;
  isClosed: boolean;
  row: DrillRow | null;
  accountCells: AccountCell[];
  appointments: DrillAppointment[];
  timeEntries: DrillTimeEntry[];
}

interface UnsignedAppointment {
  id: number;
  date: string;
  scheduledStart: string | null;
  customerName: string;
  minutes: number;
}
interface UnsignedData {
  appointments: UnsignedAppointment[];
  year: number;
  month: number;
  employeeId: number;
}

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function fmtHours(n: number): string {
  return `${n.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} h`;
}
function fmtKm(n: number): string {
  return `${n.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}
function fmtMinutesAsHours(min: number): string {
  return fmtHours(Math.round((min / 60) * 100) / 100);
}
function fmtQuote(n: number | null): string {
  if (n === null) return "—";
  return `${n.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}
function fmtSignedPct(n: number | null): string {
  if (n === null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;
}
function employmentLabel(type: string, isEuRentner: boolean): string {
  const base = type === "minijobber" ? "Minijob"
    : type === "teilzeit" ? "Teilzeit"
    : type === "vollzeit" ? "Vollzeit"
    : type;
  return isEuRentner ? `${base} · EU-Rentner` : base;
}

function DeltaBadge({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) {
    return <span className="text-xs text-gray-400" data-testid="text-delta-na">kein Vormonat</span>;
  }
  const positive = deltaPct >= 0;
  const cls = positive ? colors.badge.green : colors.badge.rose;
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded ${cls.bg} ${cls.text}`}
      data-testid="text-delta"
    >
      {positive ? "+" : ""}{deltaPct.toLocaleString("de-DE", { maximumFractionDigits: 1 })}% ggü. Vormonat
    </span>
  );
}

export default function Mitarbeiterabrechnung() {
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [drillFor, setDrillFor] = useState<{ employeeId: number; name: string } | null>(null);
  const [unsignedFor, setUnsignedFor] = useState<{ employeeId: number; name: string } | null>(null);

  const { data, isLoading, error } = useQuery<OverviewData>({
    queryKey: ["mitarbeiterabrechnung", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get<OverviewData>(
        `/admin/mitarbeiterabrechnung?year=${selectedYear}&month=${selectedMonth}`,
      );
      return unwrapResult(result);
    },
  });

  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  return (
    <Layout variant="wide">
      <div>
        <div className={componentStyles.pageHeader}>
          <div className={componentStyles.pageHeaderTop}>
            <Link href="/admin">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div className={componentStyles.pageHeaderTitleWrap}>
              <h1 className={componentStyles.pageTitle} data-testid="text-page-title">
                Mitarbeiterabrechnung &amp; Stundenkonto
              </h1>
              <p className={componentStyles.pageSubtitle}>
                Monatsabschluss der Lohn­zeiten, Kilometer und Auszahl-Rückstände
              </p>
            </div>
          </div>
          <div className={componentStyles.pageHeaderActions}>
            <Select value={String(selectedMonth)} onValueChange={(v) => setSelectedMonth(Number(v))}>
              <SelectTrigger className="w-full sm:w-40" data-testid="select-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_NAMES.map((name, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)} data-testid={`option-month-${i + 1}`}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(selectedYear)} onValueChange={(v) => setSelectedYear(Number(v))}>
              <SelectTrigger className="w-full sm:w-28" data-testid="select-year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={String(y)} data-testid={`option-year-${y}`}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-16" data-testid="state-loading">
            <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
          </div>
        )}

        {error && (
          <Card>
            <CardContent className="py-8 text-center text-red-700" data-testid="state-error">
              Die Mitarbeiterabrechnung konnte nicht geladen werden.
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
              <KpiCard
                icon={<Clock className={iconSize.md} />}
                label="Erfasste Stunden"
                value={fmtHours(data.kpis.erfassteStunden.current)}
                footer={<DeltaBadge deltaPct={data.kpis.erfassteStunden.deltaPct} />}
                testId="kpi-erfasste-stunden"
              />
              <KpiCard
                icon={<CheckCircle2 className={iconSize.md} />}
                label="Abrechenbare Stunden"
                value={fmtHours(data.kpis.abrechenbareStunden.current)}
                valueClassName="text-teal-700"
                footer={<DeltaBadge deltaPct={data.kpis.abrechenbareStunden.deltaPct} />}
                testId="kpi-abrechenbare-stunden"
              />
              <KpiCard
                icon={<Percent className={iconSize.md} />}
                label="Produktivquote"
                value={fmtQuote(data.kpis.produktivquote.current)}
                footer={<span className="text-xs text-gray-500">Wasserkopf {fmtHours(data.kpis.produktivquote.gemeinkostenStunden)}</span>}
                testId="kpi-produktivquote"
              />
              <KpiCard
                icon={<TrendingUp className={iconSize.md} />}
                label="Wachstum vs. Vormonat"
                value={fmtSignedPct(data.kpis.wachstum.produktivDeltaPct)}
                valueClassName={
                  data.kpis.wachstum.produktivDeltaPct === null
                    ? undefined
                    : data.kpis.wachstum.produktivDeltaPct >= 0
                      ? "text-green-700"
                      : "text-rose-700"
                }
                footer={<span className="text-xs text-gray-500">Gemeinkosten {fmtSignedPct(data.kpis.wachstum.gemeinkostenDeltaPct)}</span>}
                testId="kpi-wachstum"
              />
              <KpiCard
                icon={<Wallet className={iconSize.md} />}
                label="Stundenkonto-Saldo"
                value={fmtHours(data.kpis.stundenkontoSaldo)}
                footer={<span className="text-xs text-gray-500">Auszahl-Rückstand gesamt</span>}
                testId="kpi-stundenkonto"
              />
              <KpiCard
                icon={<AlertTriangle className={iconSize.md} />}
                label="Offene Termine"
                value={fmtHours(data.kpis.offeneTermine.hours)}
                footer={<span className="text-xs text-amber-700">{data.kpis.offeneTermine.count} dokumentiert, nicht unterschrieben</span>}
                testId="kpi-offene-termine"
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base" data-testid="text-table-title">
                  {MONTH_NAMES[selectedMonth - 1]} {selectedYear} — eine Zeile je Mitarbeiter
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.rows.length === 0 ? (
                  <div className={componentStyles.emptyState} data-testid="state-empty">
                    <Clock className={componentStyles.emptyStateIcon} />
                    <p className={componentStyles.emptyStateText}>
                      Keine Aktivität in diesem Monat.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm tabular-nums">
                      <thead>
                        <tr className="border-b text-left text-gray-500">
                          <th className="px-4 py-2 font-medium">Mitarbeiter</th>
                          <th className="px-4 py-2 font-medium text-right">Erfasst</th>
                          <th className="px-4 py-2 font-medium text-right">Kilometer</th>
                          <th className="px-4 py-2 font-medium text-right">Stundenkonto</th>
                          <th
                            className="px-4 py-2 font-medium text-right"
                            title="Dokumentierte Termine ohne Unterschrift. Diese Stunden zählen zur Lohnzeit und sind bereits in „Erfasst“ enthalten – sie sind nur noch nicht gegenüber Kunde/Pflegekasse abrechenbar, weil die Unterschrift fehlt."
                          >
                            Noch nicht abrechenbar
                          </th>
                          <th className="px-4 py-2 font-medium">Status</th>
                          <th className="px-4 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r) => {
                          const erfasstStd = Math.round((r.erfasst.hw + r.erfasst.ab + r.erfasst.feiertage) * 100) / 100;
                          const name = `${r.nachname}, ${r.vorname}`;
                          return (
                            <tr
                              key={r.employeeId}
                              className="border-b last:border-0 hover:bg-gray-50"
                              data-testid={`row-employee-${r.employeeId}`}
                            >
                              <td className="px-4 py-3">
                                <div className="font-medium text-gray-900" data-testid={`text-name-${r.employeeId}`}>{name}</div>
                                <div className="text-xs text-gray-500">{employmentLabel(r.employmentType, r.isEuRentner)}</div>
                              </td>
                              <td className="px-4 py-3 text-right" data-testid={`text-erfasst-${r.employeeId}`}>{fmtHours(erfasstStd)}</td>
                              <td className="px-4 py-3 text-right" data-testid={`text-km-${r.employeeId}`}>{fmtKm(r.erfasst.kilometer)}</td>
                              <td className="px-4 py-3 text-right" data-testid={`text-saldo-${r.employeeId}`}>
                                <span className={r.stundenkontoSaldo !== 0 ? "font-medium text-amber-700" : "text-gray-500"}>
                                  {fmtHours(r.stundenkontoSaldo)}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                {r.unsignedAppointmentCount > 0 ? (
                                  <button
                                    className="text-amber-700 hover:underline inline-flex items-center gap-1"
                                    onClick={() => setUnsignedFor({ employeeId: r.employeeId, name })}
                                    data-testid={`button-unsigned-${r.employeeId}`}
                                  >
                                    <AlertTriangle className={iconSize.xs} />
                                    {fmtMinutesAsHours(r.unsignedMinutes)} ({r.unsignedAppointmentCount})
                                  </button>
                                ) : (
                                  <span className="text-gray-300">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                {r.isClosed ? (
                                  <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${colors.badge.gray.bg} ${colors.badge.gray.text}`} data-testid={`badge-closed-${r.employeeId}`}>
                                    <Lock className={iconSize.xs} /> abgeschlossen
                                  </span>
                                ) : (
                                  <span className={`text-xs px-1.5 py-0.5 rounded ${colors.badge.blue.bg} ${colors.badge.blue.text}`} data-testid={`badge-open-${r.employeeId}`}>offen</span>
                                )}
                                {r.minijob?.kappung && (
                                  <span className={`ml-1 text-xs px-1.5 py-0.5 rounded ${colors.badge.orange.bg} ${colors.badge.orange.text}`} data-testid={`badge-kappung-${r.employeeId}`}>
                                    Kappung
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDrillFor({ employeeId: r.employeeId, name })}
                                  data-testid={`button-drill-${r.employeeId}`}
                                >
                                  Details <ChevronRight className={iconSize.sm} />
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {drillFor && (
        <EmployeeDrillDialog
          employeeId={drillFor.employeeId}
          name={drillFor.name}
          year={selectedYear}
          month={selectedMonth}
          onClose={() => setDrillFor(null)}
        />
      )}

      {unsignedFor && (
        <UnsignedDialog
          employeeId={unsignedFor.employeeId}
          name={unsignedFor.name}
          year={selectedYear}
          month={selectedMonth}
          onClose={() => setUnsignedFor(null)}
        />
      )}
    </Layout>
  );
}

function KpiCard({ icon, label, value, footer, testId, valueClassName }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  footer?: React.ReactNode;
  testId: string;
  valueClassName?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-gray-500 mb-1">
          {icon}
          <span className="text-xs">{label}</span>
        </div>
        <div className={`text-xl font-bold tabular-nums ${valueClassName ?? "text-gray-900"}`} data-testid={`${testId}-value`}>{value}</div>
        {footer && <div className="mt-1">{footer}</div>}
      </CardContent>
    </Card>
  );
}

function EmployeeDrillDialog({ employeeId, name, year, month, onClose }: {
  employeeId: number;
  name: string;
  year: number;
  month: number;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<DrillData>({
    queryKey: ["mitarbeiterabrechnung-drill", employeeId, year, month],
    queryFn: async () => {
      const result = await api.get<DrillData>(
        `/admin/mitarbeiterabrechnung/employee/${employeeId}?year=${year}&month=${month}`,
      );
      return unwrapResult(result);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="dialog-drill">
        <DialogHeader>
          <DialogTitle data-testid="text-drill-title">{name}</DialogTitle>
          <DialogDescription>
            {MONTH_NAMES[month - 1]} {year}
            {data?.isClosed && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-gray-500">
                <Lock className={iconSize.xs} /> Monat abgeschlossen — schreibgeschützt
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-12" data-testid="state-drill-loading">
            <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
          </div>
        )}

        {data && (
          <Tabs defaultValue="termine">
            <TabsList className={componentStyles.tabsList}>
              <TabsTrigger value="termine" data-testid="tab-termine">Termine &amp; Zeiten</TabsTrigger>
              <TabsTrigger value="aufschluesselung" data-testid="tab-aufschluesselung">Aufschlüsselung</TabsTrigger>
              <TabsTrigger value="stundenkonto" data-testid="tab-stundenkonto">Stundenkonto</TabsTrigger>
            </TabsList>

            <TabsContent value="termine">
              <DrillTermine
                employeeId={employeeId}
                name={name}
                year={year}
                month={month}
                isClosed={data.isClosed}
                appointments={data.appointments}
                timeEntries={data.timeEntries}
              />
            </TabsContent>
            <TabsContent value="aufschluesselung">
              <DrillAufschluesselung row={data.row} />
            </TabsContent>
            <TabsContent value="stundenkonto">
              <DrillStundenkonto
                employeeId={employeeId}
                year={year}
                month={month}
                cells={data.accountCells}
                isClosed={data.isClosed}
              />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DrillTermine({
  employeeId,
  name,
  year,
  month,
  isClosed,
  appointments,
  timeEntries,
}: {
  employeeId: number;
  name: string;
  year: number;
  month: number;
  isClosed: boolean;
  appointments: DrillAppointment[];
  timeEntries: DrillTimeEntry[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showVacation, setShowVacation] = useState(false);
  const [vacationDays, setVacationDays] = useState("");
  const [carryOverDays, setCarryOverDays] = useState("");

  const createForm = useTimeEntryForm();
  const editForm = useTimeEntryForm();
  const createMutation = useCreateTimeEntry();
  const updateMutation = useUpdateTimeEntry();
  const deleteMutation = useDeleteTimeEntry();

  const createValidation = useTimeEntryConflict(
    showCreate
      ? {
          entryDate: createForm.formState.entryDate,
          entryType: createForm.formState.entryType,
          startTime: createForm.formState.startTime,
          endTime: createForm.formState.endTime,
          isFullDay: createForm.formState.isFullDay,
          targetUserId: employeeId,
        }
      : null,
    showCreate,
  );
  const editValidation = useTimeEntryConflict(
    showEdit && editForm.formState.id
      ? {
          entryDate: editForm.formState.entryDate,
          entryType: editForm.formState.entryType,
          startTime: editForm.formState.startTime,
          endTime: editForm.formState.endTime,
          isFullDay: editForm.formState.isFullDay,
          excludeEntryId: editForm.formState.id,
          targetUserId: employeeId,
        }
      : null,
    showEdit,
  );

  const { data: vacationMap, isLoading: vacationLoading } = useAllVacationSummaries(year);
  const vacation = vacationMap?.[employeeId] ?? null;

  const invalidateDrill = () => {
    // invalidate-direct-allowed: page-local read models (overview + drill) are not
    // registered in RELATED_DOMAINS; the mutation hooks already invalidate the
    // shared "time-entries" domain.
    // eslint-disable-next-line no-restricted-syntax
    queryClient.invalidateQueries({ queryKey: ["mitarbeiterabrechnung"] });
    // eslint-disable-next-line no-restricted-syntax
    queryClient.invalidateQueries({ queryKey: ["mitarbeiterabrechnung-drill", employeeId, year, month] });
  };

  const vacationSaveMutation = useMutation({
    mutationFn: async (data: { vacationDaysPerYear: number; carryOverDays: number }) => {
      const result = await api.patch(`/admin/users/${employeeId}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      // invalidate-direct-allowed: vacation-summaries not covered by a domain
      // eslint-disable-next-line no-restricted-syntax
      queryClient.invalidateQueries({ queryKey: ["admin", "vacation-summaries"] });
      invalidateDrill();
      toast({ title: "Urlaubskontingent gespeichert" });
      setShowVacation(false);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleOpenCreate = () => {
    if (isClosed) return;
    createForm.reset({
      targetUserId: employeeId,
      entryDate: `${year}-${String(month).padStart(2, "0")}-01`,
    });
    setShowCreate(true);
  };
  const handleCreate = () => {
    if (isClosed) return;
    createMutation.mutate(createForm.toCreateRequest(), {
      onSuccess: () => {
        invalidateDrill();
        setShowCreate(false);
      },
    });
  };
  const handleOpenEdit = (e: DrillTimeEntry) => {
    if (isClosed) return;
    editForm.setForEdit({
      id: e.id,
      entryType: e.entryType,
      entryDate: e.entryDate,
      startTime: e.startTime,
      endTime: e.endTime,
      isFullDay: e.startTime === null,
      kilometers: e.kilometers,
      notes: e.notes,
    });
    setShowEdit(true);
  };
  const handleUpdate = () => {
    if (!editForm.formState.id || isClosed) return;
    updateMutation.mutate(
      { id: editForm.formState.id, data: editForm.toUpdateRequest() },
      {
        onSuccess: () => {
          invalidateDrill();
          setShowEdit(false);
        },
      },
    );
  };
  const handleDelete = (id: number) => {
    if (isClosed) return;
    if (!window.confirm("Zeiteintrag wirklich löschen?")) return;
    deleteMutation.mutate(id, { onSuccess: invalidateDrill });
  };
  const handleOpenVacation = () => {
    setVacationDays(vacation ? String(vacation.configuredAnnualDays) : "");
    setCarryOverDays(vacation ? String(vacation.carryOverDays) : "");
    setShowVacation(true);
  };
  const handleSaveVacation = () => {
    vacationSaveMutation.mutate({
      vacationDaysPerYear: parseInt(vacationDays) || 0,
      carryOverDays: parseInt(carryOverDays) || 0,
    });
  };

  return (
    <div className="space-y-4 pt-2">
      <div>
        <h3 className="text-sm font-medium text-gray-900 mb-2">Dokumentierte Termine</h3>
        {appointments.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-appointments">Keine dokumentierten Termine.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="px-2 py-1 font-medium">Datum</th>
                  <th className="px-2 py-1 font-medium">Kunde</th>
                  <th className="px-2 py-1 font-medium text-right">Leistung</th>
                  <th className="px-2 py-1 font-medium text-right">Anfahrt</th>
                  <th className="px-2 py-1 font-medium text-right">km</th>
                </tr>
              </thead>
              <tbody>
                {appointments.map((a) => (
                  <tr key={a.id} className="border-b last:border-0" data-testid={`row-appt-${a.id}`}>
                    <td className="px-2 py-1">{a.date}</td>
                    <td className="px-2 py-1">{a.customerName}</td>
                    <td className="px-2 py-1 text-right">{fmtMinutesAsHours(a.serviceMinutes)}</td>
                    <td className="px-2 py-1 text-right">{fmtMinutesAsHours(a.travelMinutes)}</td>
                    <td className="px-2 py-1 text-right">{fmtKm(a.travelKm + a.customerKm)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-900">Manuelle Zeiteinträge</h3>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenVacation}
              disabled={isClosed}
              data-testid="button-edit-vacation"
            >
              <Plane className={iconSize.sm} />
              Urlaubskontingent
            </Button>
            <Button
              size="sm"
              onClick={handleOpenCreate}
              disabled={isClosed}
              data-testid="button-add-entry"
            >
              <Plus className={iconSize.sm} />
              Zeiteintrag
            </Button>
          </div>
        </div>
        {isClosed && (
          <p className="text-xs text-amber-700 mb-2" data-testid="text-entries-locked">
            Monat abgeschlossen — Zeiteinträge können nicht mehr bearbeitet werden.
          </p>
        )}
        {timeEntries.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-entries">Keine Zeiteinträge.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="px-2 py-1 font-medium">Datum</th>
                  <th className="px-2 py-1 font-medium">Art</th>
                  <th className="px-2 py-1 font-medium text-right">Dauer</th>
                  <th className="px-2 py-1 font-medium text-right">km</th>
                  <th className="px-2 py-1 font-medium text-right">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {timeEntries.map((e) => (
                  <tr key={e.id} className="border-b last:border-0" data-testid={`row-entry-${e.id}`}>
                    <td className="px-2 py-1">{e.entryDate}</td>
                    <td className="px-2 py-1">{TIME_ENTRY_TYPE_CONFIG[e.entryType as TimeEntryType]?.label ?? e.entryType}</td>
                    <td className="px-2 py-1 text-right">{e.durationMinutes !== null ? fmtMinutesAsHours(e.durationMinutes) : "—"}</td>
                    <td className="px-2 py-1 text-right">{e.kilometers !== null ? fmtKm(e.kilometers) : "—"}</td>
                    <td className="px-2 py-1 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => handleOpenEdit(e)}
                          disabled={isClosed}
                          data-testid={`button-edit-entry-${e.id}`}
                        >
                          <Pencil className={iconSize.sm} />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-rose-600"
                          onClick={() => handleDelete(e.id)}
                          disabled={isClosed || deleteMutation.isPending}
                          data-testid={`button-delete-entry-${e.id}`}
                        >
                          <Trash2 className={iconSize.sm} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <TimeEntryDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={`Zeiteintrag für ${name}`}
        formState={createForm.formState}
        onFieldChange={createForm.updateField}
        validation={createValidation}
        onSubmit={handleCreate}
        isSubmitting={createMutation.isPending}
        isFullDayType={createForm.isFullDayType}
        supportsDateRange={createForm.supportsDateRange}
        supportsFullDayToggle={createForm.supportsFullDayToggle}
        submitLabel="Anlegen"
        testIdPrefix="create"
      />
      <TimeEntryDialog
        open={showEdit}
        onOpenChange={setShowEdit}
        title={`Zeiteintrag bearbeiten – ${name}`}
        formState={editForm.formState}
        onFieldChange={editForm.updateField}
        validation={editValidation}
        onSubmit={handleUpdate}
        isSubmitting={updateMutation.isPending}
        isFullDayType={editForm.isFullDayType}
        supportsDateRange={editForm.supportsDateRange}
        supportsFullDayToggle={editForm.supportsFullDayToggle}
        submitLabel="Speichern"
        testIdPrefix="edit"
      />
      <VacationDialog
        open={showVacation}
        onOpenChange={setShowVacation}
        year={year}
        userName={name}
        vacation={vacation}
        vacationLoading={vacationLoading}
        vacationDays={vacationDays}
        onVacationDaysChange={setVacationDays}
        carryOverDays={carryOverDays}
        onCarryOverDaysChange={setCarryOverDays}
        onSave={handleSaveVacation}
        onCancel={() => setShowVacation(false)}
        isSaving={vacationSaveMutation.isPending}
      />
    </div>
  );
}

function DrillAufschluesselung({ row }: { row: DrillRow | null }) {
  if (!row) {
    return <p className="text-sm text-gray-500 pt-2" data-testid="text-no-breakdown">Keine Daten.</p>;
  }
  const lines: { label: string; value: string }[] = [
    { label: "Hauswirtschaft", value: fmtHours(row.stundenHauswirtschaft) },
    { label: "Alltagsbegleitung", value: fmtHours(row.stundenAlltagsbegleitung) },
    { label: "Erstberatung", value: fmtHours(row.stundenErstberatung) },
    { label: "Anfahrtszeit", value: fmtHours(row.stundenAnfahrt) },
    { label: "Leerfahrten", value: fmtHours(row.stundenLeerfahrten) },
    { label: "Sonstiges (Büro/Vertrieb)", value: fmtHours(row.stundenSonstiges) },
    { label: "Feiertage", value: fmtHours(row.stundenFeiertage) },
    { label: `Urlaub (${row.tageUrlaub} Tage)`, value: fmtHours(row.urlaubStunden) },
    { label: `Krankheit (${row.tageKrankheit} Tage)`, value: fmtHours(row.krankheitStunden) },
  ];
  const kmLines: { label: string; value: string }[] = [
    { label: "Anfahrt-km", value: fmtKm(row.kilometerAnfahrt) },
    { label: "Kunden-km", value: fmtKm(row.kilometerKunden) },
    { label: "Leerfahrten-km", value: fmtKm(row.kilometerLeerfahrten) },
    { label: "Sonstige km", value: fmtKm(row.kilometerSonstige) },
    { label: "Summe km", value: fmtKm(row.kilometer) },
  ];
  return (
    <div className="space-y-4 pt-2">
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-medium text-gray-900 mb-2">Stunden</h3>
          <dl className="text-sm">
            {lines.map((l) => (
              <div key={l.label} className="flex justify-between border-b py-1 last:border-0" data-testid={`breakdown-${l.label}`}>
                <dt className="text-gray-600">{l.label}</dt>
                <dd className="tabular-nums">{l.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-900 mb-2">Kilometer</h3>
          <dl className="text-sm">
            {kmLines.map((l) => (
              <div key={l.label} className="flex justify-between border-b py-1 last:border-0">
                <dt className="text-gray-600">{l.label}</dt>
                <dd className="tabular-nums">{l.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      {row.minijob && (
        <div>
          <h3 className="text-sm font-medium text-gray-900 mb-2">Minijob-Verdienst</h3>
          <dl className="text-sm">
            <div className="flex justify-between border-b py-1"><dt className="text-gray-600">Brutto</dt><dd className="tabular-nums">{formatEuroDE(row.minijob.bruttoCents)}</dd></div>
            <div className="flex justify-between border-b py-1"><dt className="text-gray-600">Übertrag Vormonat</dt><dd className="tabular-nums">{formatEuroDE(row.minijob.uebertragVormonatCents)}</dd></div>
            <div className="flex justify-between border-b py-1"><dt className="text-gray-600">Auszahlbar</dt><dd className="tabular-nums">{formatEuroDE(row.minijob.auszahlbarCents)}</dd></div>
            <div className="flex justify-between border-b py-1 last:border-0"><dt className="text-gray-600">Übertrag Folgemonat</dt><dd className="tabular-nums">{formatEuroDE(row.minijob.uebertragNeuCents)}</dd></div>
          </dl>
          {row.minijob.kappung && (
            <p className="text-xs text-amber-700 mt-1" data-testid="text-kappung-note">
              Verdienst über {formatEuroDE(row.minijob.limitCents)} — Rest wird in den Folgemonat übertragen.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DrillStundenkonto({ employeeId, year, month, cells, isClosed }: {
  employeeId: number;
  year: number;
  month: number;
  cells: AccountCell[];
  isClosed: boolean;
}) {
  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-gray-500">
        Saldo = Anfangsbestand + Erfasst − Bezahlt. „Bezahlt" ohne Eingabe entspricht „Erfasst" (Saldo 0).
      </p>
      {cells.map((cell) => (
        <AccountCellEditor
          key={cell.category}
          employeeId={employeeId}
          year={year}
          month={month}
          cell={cell}
          isClosed={isClosed}
        />
      ))}
    </div>
  );
}

function AccountCellEditor({ employeeId, year, month, cell, isClosed }: {
  employeeId: number;
  year: number;
  month: number;
  cell: AccountCell;
  isClosed: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const unit = CATEGORY_UNIT[cell.category] ?? "";
  const [anfangsbestand, setAnfangsbestand] = useState(String(cell.anfangsbestand));
  const [bezahlt, setBezahlt] = useState(cell.bezahltIsDefault ? "" : String(cell.bezahlt));

  const canEditOpening = !isClosed && cell.anfangsbestandType === "go_live";

  const mutation = useMutation({
    mutationFn: async (payload: { anfangsbestand?: number | null; bezahlt?: number | null; openingBalanceType?: "go_live" | "carryover" }) => {
      const result = await api.put(`/admin/mitarbeiterabrechnung/account`, {
        userId: employeeId,
        year,
        month,
        category: cell.category,
        ...payload,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      // invalidate-direct-allowed: Stundenkonto-Daten sind ausschließlich in dieser Feature-Ansicht sichtbar (keine domänenübergreifende Konsistenz betroffen).
      // eslint-disable-next-line no-restricted-syntax
      queryClient.invalidateQueries({ queryKey: ["mitarbeiterabrechnung"] });
      // invalidate-direct-allowed: Drill-down derselben Feature-Ansicht, auf genau diesen Mitarbeiter/Monat begrenzt.
      // eslint-disable-next-line no-restricted-syntax
      queryClient.invalidateQueries({ queryKey: ["mitarbeiterabrechnung-drill", employeeId, year, month] });
      toast({ title: "Gespeichert", description: `${CATEGORY_LABELS[cell.category]} aktualisiert.` });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Fehler",
        description: err instanceof Error ? err.message : "Speichern fehlgeschlagen.",
      });
    },
  });

  const saveOpening = () => {
    const val = anfangsbestand.trim() === "" ? 0 : Number(anfangsbestand.replace(",", "."));
    if (isNaN(val)) {
      toast({ variant: "destructive", title: "Ungültig", description: "Bitte eine Zahl eingeben." });
      return;
    }
    mutation.mutate({ anfangsbestand: val, openingBalanceType: "go_live" });
  };
  const saveBezahlt = () => {
    if (bezahlt.trim() === "") {
      mutation.mutate({ bezahlt: null });
      return;
    }
    const val = Number(bezahlt.replace(",", "."));
    if (isNaN(val) || val < 0) {
      toast({ variant: "destructive", title: "Ungültig", description: "Bitte eine Zahl ≥ 0 eingeben." });
      return;
    }
    mutation.mutate({ bezahlt: val });
  };

  return (
    <div className="rounded-lg border p-3" data-testid={`account-cell-${cell.category}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-gray-900">{CATEGORY_LABELS[cell.category]}</span>
        <span className={`text-sm tabular-nums font-medium ${cell.saldo !== 0 ? "text-amber-700" : "text-gray-500"}`} data-testid={`cell-saldo-${cell.category}`}>
          Saldo: {cell.saldo.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })} {unit}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
        <div>
          <Label className="text-xs text-gray-500">Anfangsbestand</Label>
          {canEditOpening ? (
            <div className="flex gap-1">
              <Input
                value={anfangsbestand}
                onChange={(e) => setAnfangsbestand(e.target.value)}
                inputMode="decimal"
                className="h-8"
                data-testid={`input-anfangsbestand-${cell.category}`}
              />
              <Button size="sm" variant="outline" className="h-8" onClick={saveOpening} disabled={mutation.isPending} data-testid={`button-save-anfangsbestand-${cell.category}`}>
                OK
              </Button>
            </div>
          ) : (
            <div className="h-8 flex items-center text-sm tabular-nums text-gray-700" data-testid={`text-anfangsbestand-${cell.category}`}>
              {cell.anfangsbestand.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
              <span className="ml-1 text-xs text-gray-400">({cell.anfangsbestandType === "carryover" ? "Übertrag" : "Eröffnung"})</span>
            </div>
          )}
        </div>
        <div>
          <Label className="text-xs text-gray-500">Erfasst</Label>
          <div className="h-8 flex items-center text-sm tabular-nums text-gray-700" data-testid={`text-erfasst-${cell.category}`}>
            {cell.erfasst.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div>
          <Label className="text-xs text-gray-500">Bezahlt</Label>
          {isClosed ? (
            <div className="h-8 flex items-center text-sm tabular-nums text-gray-700" data-testid={`text-bezahlt-${cell.category}`}>
              {cell.bezahlt.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
            </div>
          ) : (
            <div className="flex gap-1">
              <Input
                value={bezahlt}
                onChange={(e) => setBezahlt(e.target.value)}
                placeholder={cell.erfasst.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
                inputMode="decimal"
                className="h-8"
                data-testid={`input-bezahlt-${cell.category}`}
              />
              <Button size="sm" variant="outline" className="h-8" onClick={saveBezahlt} disabled={mutation.isPending} data-testid={`button-save-bezahlt-${cell.category}`}>
                OK
              </Button>
            </div>
          )}
        </div>
        <div className="text-right">
          <Label className="text-xs text-gray-500">Einheit</Label>
          <div className="h-8 flex items-center justify-end text-sm text-gray-400">{unit}</div>
        </div>
      </div>
    </div>
  );
}

function UnsignedDialog({ employeeId, name, year, month, onClose }: {
  employeeId: number;
  name: string;
  year: number;
  month: number;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery<UnsignedData>({
    queryKey: ["mitarbeiterabrechnung-unsigned", employeeId, year, month],
    queryFn: async () => {
      const result = await api.get<UnsignedData>(
        `/admin/mitarbeiterabrechnung/unsigned-appointments?year=${year}&month=${month}&employeeId=${employeeId}`,
      );
      return unwrapResult(result);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="dialog-unsigned">
        <DialogHeader>
          <DialogTitle>Termine ohne Unterschrift</DialogTitle>
          <DialogDescription>
            {name} · {MONTH_NAMES[month - 1]} {year} — zählen zur Lohnzeit, sind aber noch nicht abrechenbar.
          </DialogDescription>
        </DialogHeader>
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
          </div>
        )}
        {data && (
          data.appointments.length === 0 ? (
            <p className="text-sm text-gray-500 py-4" data-testid="text-no-unsigned">Keine offenen Unterschriften.</p>
          ) : (
            <div className="space-y-2">
              {data.appointments.map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded-lg border p-2 text-sm" data-testid={`unsigned-appt-${a.id}`}>
                  <div>
                    <div className="font-medium">{a.customerName}</div>
                    <div className="text-xs text-gray-500">{a.date}{a.scheduledStart ? ` · ${a.scheduledStart}` : ""}</div>
                  </div>
                  <span className="tabular-nums text-gray-600">{fmtMinutesAsHours(a.minutes)}</span>
                </div>
              ))}
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
