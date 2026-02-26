import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Clock, AlertTriangle } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";

interface EmployeeSummaryRow {
  employeeId: number;
  nachname: string;
  vorname: string;
  stundenHauswirtschaft: number;
  stundenAlltagsbegleitung: number;
  stundenErstberatung: number;
  stundenSonstiges: number;
  stundenFeiertage: number;
  kilometer: number;
  tageUrlaub: number;
  tageKrankheit: number;
  isEuRentner: boolean;
  employmentType: string;
  weeklyWorkDays: number;
  monthlyWorkHours: number | null;
  bruttoCents: number | null;
  uebertragVormonatCents: number | null;
  auszahlbarCents: number | null;
  uebertragNeuCents: number | null;
}

interface OverviewData {
  rows: EmployeeSummaryRow[];
  year: number;
  month: number;
  earningsLimitCents: number;
}

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function formatHours(hours: number): string {
  if (hours === 0) return "–";
  return hours.toFixed(2).replace(".", ",");
}

function formatEuro(cents: number): string {
  if (cents === 0) return "–";
  return (cents / 100).toFixed(2).replace(".", ",") + " €";
}

function formatKm(km: number): string {
  if (km === 0) return "–";
  return km.toFixed(1);
}

function formatDays(days: number): string {
  if (days === 0) return "–";
  return `${days}`;
}

export default function HoursOverview() {
  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const [selectedYear, setSelectedYear] = useState(String(prevYear));
  const [selectedMonth, setSelectedMonth] = useState(String(prevMonth));

  const { data, isLoading, error } = useQuery<OverviewData>({
    queryKey: ["hours-overview", selectedYear, selectedMonth],
    queryFn: async () => {
      const result = await api.get<OverviewData>(`/admin/hours-overview?year=${selectedYear}&month=${selectedMonth}`);
      return unwrapResult(result);
    },
  });

  const years = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    years.push(String(y));
  }

  const hasMinijobber = data?.rows?.some(r => r.employmentType === "minijobber") ?? false;

  const totals = data?.rows?.reduce(
    (acc, r) => ({
      hw: acc.hw + r.stundenHauswirtschaft,
      ab: acc.ab + r.stundenAlltagsbegleitung,
      eb: acc.eb + r.stundenErstberatung,
      sonstiges: acc.sonstiges + r.stundenSonstiges,
      feiertage: acc.feiertage + r.stundenFeiertage,
      km: acc.km + r.kilometer,
      urlaub: acc.urlaub + r.tageUrlaub,
      krankheit: acc.krankheit + r.tageKrankheit,
    }),
    { hw: 0, ab: 0, eb: 0, sonstiges: 0, feiertage: 0, km: 0, urlaub: 0, krankheit: 0 }
  );

  return (
    <Layout variant="wide">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin">
          <Button variant="ghost" size="icon" data-testid="button-back" aria-label="Zurück">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <h1 className={componentStyles.pageTitle}>Stundenübersicht</h1>
      </div>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex items-end gap-4">
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Monat</label>
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger className="w-[160px]" data-testid="select-overview-month">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((name, idx) => (
                    <SelectItem key={idx + 1} value={String(idx + 1)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Jahr</label>
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger className="w-[100px]" data-testid="select-overview-year">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map(y => (
                    <SelectItem key={y} value={y}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {MONTHS[parseInt(selectedMonth) - 1]} {selectedYear}
            </CardTitle>
            {data?.rows && (
              <span className="text-sm text-muted-foreground" data-testid="text-employee-count">
                {data.rows.length} Mitarbeiter
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Daten werden geladen...</p>
          ) : error ? (
            <p className="text-sm text-red-600 py-8 text-center">Fehler beim Laden der Daten</p>
          ) : !data?.rows?.length ? (
            <p className="text-sm text-muted-foreground py-8 text-center" data-testid="text-no-data">
              Keine Daten für den gewählten Zeitraum vorhanden.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-hours-overview">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Name</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">HW (Std.)</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">AB (Std.)</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">EB (Std.)</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Sonst. (Std.)</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Feiert. (Std.)</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">KM</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Urlaub (T)</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Krank (T)</th>
                    {hasMinijobber && (
                      <>
                        <th className="py-2 pr-4 font-medium text-muted-foreground text-right border-l pl-4">Brutto (€)</th>
                        <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Übertr. Vor. (€)</th>
                        <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Auszahlbar (€)</th>
                        <th className="py-2 font-medium text-muted-foreground text-right">Übertr. neu (€)</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const totalHours = row.stundenHauswirtschaft + row.stundenAlltagsbegleitung + row.stundenErstberatung + row.stundenSonstiges;
                    const euWeeklyLimit = 15;
                    const weeksInMonth = new Date(parseInt(selectedYear), parseInt(selectedMonth), 0).getDate() / 7;
                    const maxMonthlyHours = euWeeklyLimit * weeksInMonth;
                    const isOverLimit = row.isEuRentner && totalHours >= maxMonthlyHours;
                    const hasCarryover = row.uebertragNeuCents !== null && row.uebertragNeuCents > 0;

                    return (
                      <tr key={row.employeeId} className={`border-b last:border-0 ${isOverLimit ? "bg-red-50" : hasCarryover ? "bg-amber-50" : ""}`} data-testid={`row-employee-${row.employeeId}`}>
                        <td className="py-2 pr-4 font-medium">
                          <div className="flex items-center gap-2">
                            <span>{row.nachname}, {row.vorname}</span>
                            {row.isEuRentner && (
                              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-100 text-amber-800" data-testid={`badge-eu-rentner-${row.employeeId}`}>
                                EU
                              </span>
                            )}
                            {row.employmentType === "minijobber" && (
                              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-100 text-blue-800" data-testid={`badge-minijobber-${row.employeeId}`}>
                                MJ
                              </span>
                            )}
                          </div>
                          {isOverLimit && (
                            <div className="flex items-center gap-1 mt-0.5">
                              <AlertTriangle className="h-3 w-3 text-red-600" />
                              <span className="text-[11px] text-red-600 font-medium">
                                {formatHours(totalHours)}h / max. {formatHours(maxMonthlyHours)}h (EU-Grenze)
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-right font-mono">{formatHours(row.stundenHauswirtschaft)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatHours(row.stundenAlltagsbegleitung)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatHours(row.stundenErstberatung)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatHours(row.stundenSonstiges)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatHours(row.stundenFeiertage)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatKm(row.kilometer)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatDays(row.tageUrlaub)}</td>
                        <td className="py-2 pr-4 text-right font-mono">{formatDays(row.tageKrankheit)}</td>
                        {hasMinijobber && (
                          <>
                            <td className="py-2 pr-4 text-right font-mono border-l pl-4">
                              {row.bruttoCents !== null ? formatEuro(row.bruttoCents) : "–"}
                            </td>
                            <td className="py-2 pr-4 text-right font-mono">
                              {row.uebertragVormonatCents !== null ? formatEuro(row.uebertragVormonatCents) : "–"}
                            </td>
                            <td className="py-2 pr-4 text-right font-mono">
                              {row.auszahlbarCents !== null ? formatEuro(row.auszahlbarCents) : "–"}
                            </td>
                            <td className={`py-2 text-right font-mono ${hasCarryover ? "text-amber-700 font-semibold" : ""}`}>
                              {row.uebertragNeuCents !== null ? formatEuro(row.uebertragNeuCents) : "–"}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="py-2 pr-4">Gesamt</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(totals.hw)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(totals.ab)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(totals.eb)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(totals.sonstiges)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(totals.feiertage)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatKm(totals.km)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatDays(totals.urlaub)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatDays(totals.krankheit)}</td>
                      {hasMinijobber && (
                        <>
                          <td className="py-2 pr-4 text-right font-mono border-l pl-4"></td>
                          <td className="py-2 pr-4 text-right font-mono"></td>
                          <td className="py-2 pr-4 text-right font-mono"></td>
                          <td className="py-2 text-right font-mono"></td>
                        </>
                      )}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {hasMinijobber && data?.earningsLimitCents && (
        <p className="text-xs text-muted-foreground mt-4" data-testid="text-minijob-info">
          Minijob-Verdienstgrenze: {formatEuro(data.earningsLimitCents)} / Monat. Übertrag-Spalten nur für Minijobber mit hinterlegten Stundensätzen.
        </p>
      )}
    </Layout>
  );
}
