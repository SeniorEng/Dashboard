import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Download, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";

interface ExportRow {
  year: number;
  month: number;
  personalnummer: string;
  employeeName: string;
  lohnartnummer: string;
  lohnartLabel: string;
  value: string;
  unit: string;
}

interface ExportData {
  rows: ExportRow[];
  warnings: string[];
  year: number;
  month: number;
}

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export default function LexwareExport() {
  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const [selectedYear, setSelectedYear] = useState(String(prevYear));
  const [selectedMonth, setSelectedMonth] = useState(String(prevMonth));

  const { data, isLoading, error } = useQuery<ExportData>({
    queryKey: ["lexware-export", selectedYear, selectedMonth],
    queryFn: async () => {
      const res = await fetch(`/api/admin/lexware-export?year=${selectedYear}&month=${selectedMonth}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Export-Daten konnten nicht geladen werden");
      return res.json();
    },
  });

  const handleDownload = () => {
    window.open(
      `/api/admin/lexware-export/csv?year=${selectedYear}&month=${selectedMonth}`,
      "_blank"
    );
  };

  const years = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    years.push(String(y));
  }

  return (
    <Layout variant="admin">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <h1 className={componentStyles.pageTitle}>Lohnexport (Lexware)</h1>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Zeitraum wählen</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4">
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Monat</label>
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger className="w-[160px]" data-testid="select-export-month">
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
                <SelectTrigger className="w-[100px]" data-testid="select-export-year">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map(y => (
                    <SelectItem key={y} value={y}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleDownload}
              disabled={!data?.rows?.length}
              data-testid="button-download-csv"
            >
              <Download className="mr-2 h-4 w-4" />
              CSV herunterladen
            </Button>
          </div>
        </CardContent>
      </Card>

      {data?.warnings && data.warnings.length > 0 && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2" data-testid="export-warnings">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            {data.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
            <p className="mt-1 font-medium">
              <Link href="/admin/settings" className="underline">Lohnartnummern in den Einstellungen konfigurieren</Link>
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              Vorschau — {MONTHS[parseInt(selectedMonth) - 1]} {selectedYear}
            </CardTitle>
            {data?.rows && (
              <span className="text-sm text-muted-foreground" data-testid="text-row-count">
                {data.rows.length} Zeilen
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
              Stellen Sie sicher, dass Mitarbeiter eine Personalnummer haben.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-export-preview">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Personalnr.</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Mitarbeiter</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Lohnart-Nr.</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground">Bezeichnung</th>
                    <th className="py-2 pr-4 font-medium text-muted-foreground text-right">Wert</th>
                    <th className="py-2 font-medium text-muted-foreground">Einheit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, idx) => (
                    <tr key={idx} className="border-b last:border-0" data-testid={`row-export-${idx}`}>
                      <td className="py-2 pr-4 font-mono">{row.personalnummer}</td>
                      <td className="py-2 pr-4">{row.employeeName}</td>
                      <td className="py-2 pr-4 font-mono">{row.lohnartnummer}</td>
                      <td className="py-2 pr-4">{row.lohnartLabel}</td>
                      <td className="py-2 pr-4 text-right font-mono">{row.value}</td>
                      <td className="py-2">{row.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
