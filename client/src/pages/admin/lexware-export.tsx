import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Clock } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";

interface EmployeeSummaryRow {
  employeeId: number;
  nachname: string;
  vorname: string;
  stundenHauswirtschaft: number;
  stundenAlltagsbegleitung: number;
  stundenSonstiges: number;
  kilometer: number;
  tageUrlaub: number;
  tageKrankheit: number;
}

interface OverviewData {
  rows: EmployeeSummaryRow[];
  year: number;
  month: number;
}

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function formatHours(hours: number): string {
  if (hours === 0) return "–";
  return hours.toFixed(2).replace(".", ",");
}

function formatKm(km: number): string {
  if (km === 0) return "–";
  return `${km}`;
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

  const totals = data?.rows?.reduce(
    (acc, r) => ({
      hw: acc.hw + r.stundenHauswirtschaft,
      ab: acc.ab + r.stundenAlltagsbegleitung,
      sonstiges: acc.sonstiges + r.stundenSonstiges,
      km: acc.km + r.kilometer,
      urlaub: acc.urlaub + r.tageUrlaub,
      krankheit: acc.krankheit + r.tageKrankheit,
    }),
    { hw: 0, ab: 0, sonstiges: 0, km: 0, urlaub: 0, krankheit: 0 }
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
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Sonst. (Std.)</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">KM</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Urlaub (T)</th>
                    <th className="py-2 font-medium text-muted-foreground text-right">Krank (T)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.employeeId} className="border-b last:border-0" data-testid={`row-employee-${row.employeeId}`}>
                      <td className="py-2 pr-4 font-medium">{row.nachname}, {row.vorname}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(row.stundenHauswirtschaft)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(row.stundenAlltagsbegleitung)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(row.stundenSonstiges)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatKm(row.kilometer)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatDays(row.tageUrlaub)}</td>
                      <td className="py-2 text-right font-mono">{formatDays(row.tageKrankheit)}</td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t-2 font-semibold">
                      <td className="py-2 pr-4">Gesamt</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(totals.hw)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(totals.ab)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatHours(totals.sonstiges)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatKm(totals.km)}</td>
                      <td className="py-2 pr-4 text-right font-mono">{formatDays(totals.urlaub)}</td>
                      <td className="py-2 text-right font-mono">{formatDays(totals.krankheit)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
