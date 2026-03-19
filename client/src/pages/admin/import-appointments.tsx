import { useState, useCallback } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Upload, CheckCircle, AlertTriangle, XCircle, FileSpreadsheet } from "lucide-react";
import { Link } from "wouter";

interface MatchedRow {
  rowIndex: number;
  kundeRaw: string;
  vorname: string;
  nachname: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  kilometers: number;
  employeeName: string;
  serviceType: string;
  budgetType: string;
  customerId: number | null;
  employeeId: number | null;
  serviceId: number | null;
  budgetTypeKey: string | null;
  status: "new" | "duplicate" | "error";
  errors: string[];
  existingAppointmentId: number | null;
  differences: string[];
}

interface PreviewResponse {
  rows: MatchedRow[];
  summary: { total: number; new: number; duplicate: number; error: number };
}

interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: { rowIndex: number; error: string }[];
}

interface Employee {
  id: number;
  displayName: string;
}

type RowAction = "import" | "update" | "skip";

export default function ImportAppointmentsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [serviceRecordResult, setServiceRecordResult] = useState<{ created: number; errors: { key: string; error: string }[] } | null>(null);
  const [creatingRecords, setCreatingRecords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [employees, setEmployees] = useState<Employee[]>([]);

  const [rowActions, setRowActions] = useState<Map<number, RowAction>>(new Map());
  const [employeeOverrides, setEmployeeOverrides] = useState<Map<number, number>>(new Map());

  const getCsrfToken = useCallback((): string | null => {
    const cookies = document.cookie.split(";");
    for (const cookie of cookies) {
      const trimmed = cookie.trim();
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const name = trimmed.substring(0, eqIndex);
      const value = trimmed.substring(eqIndex + 1);
      if (name === "careconnect_csrf" && value) {
        return decodeURIComponent(value);
      }
    }
    return null;
  }, []);

  const loadPreview = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    setImportResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const csrfToken = getCsrfToken();
      const headers: Record<string, string> = {};
      if (csrfToken) headers["x-csrf-token"] = csrfToken;

      const res = await fetch("/api/admin/import-appointments/preview", {
        method: "POST",
        body: formData,
        credentials: "include",
        headers,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }

      const data: PreviewResponse = await res.json();
      setPreview(data);

      const defaultActions = new Map<number, RowAction>();
      for (const row of data.rows) {
        if (row.status === "new") {
          defaultActions.set(row.rowIndex, "import");
        } else if (row.status === "duplicate") {
          defaultActions.set(row.rowIndex, "skip");
        } else {
          defaultActions.set(row.rowIndex, "skip");
        }
      }
      setRowActions(defaultActions);

      const empRes = await fetch("/api/admin/import-appointments/employees", {
        credentials: "include",
        headers,
      });
      if (empRes.ok) {
        const empData: Employee[] = await empRes.json();
        setEmployees(empData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [file, getCsrfToken]);

  const executeImport = useCallback(async () => {
    if (!preview) return;
    setImporting(true);
    setError(null);
    setProgress(0);

    try {
      const actions = preview.rows.map((row) => ({
        action: rowActions.get(row.rowIndex) || "skip",
        rowIndex: row.rowIndex,
        employeeIdOverride: employeeOverrides.get(row.rowIndex),
      }));

      const csrfToken = getCsrfToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (csrfToken) headers["x-csrf-token"] = csrfToken;

      const res = await fetch("/api/admin/import-appointments/execute", {
        method: "POST",
        body: JSON.stringify({ rows: preview.rows, actions }),
        credentials: "include",
        headers,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }

      const result: ImportResult = await res.json();
      setImportResult(result);
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [preview, rowActions, employeeOverrides, getCsrfToken]);

  const createServiceRecords = useCallback(async () => {
    setCreatingRecords(true);
    setError(null);

    try {
      const csrfToken = getCsrfToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (csrfToken) headers["x-csrf-token"] = csrfToken;

      const res = await fetch("/api/admin/import-appointments/create-service-records", {
        method: "POST",
        credentials: "include",
        headers,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }

      const result = await res.json();
      setServiceRecordResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingRecords(false);
    }
  }, [getCsrfToken]);

  const setAllActions = (action: RowAction, filter?: "new" | "duplicate") => {
    if (!preview) return;
    const newActions = new Map(rowActions);
    for (const row of preview.rows) {
      if (filter && row.status !== filter) continue;
      if (row.status === "error" && action !== "skip") continue;
      newActions.set(row.rowIndex, action);
    }
    setRowActions(newActions);
  };

  const selectedForImport = preview
    ? preview.rows.filter((r) => {
        const action = rowActions.get(r.rowIndex);
        return action === "import" || action === "update";
      }).length
    : 0;

  return (
    <Layout variant="admin">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/admin" data-testid="link-back-admin">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Admin
            </Button>
          </Link>
          <h1 className="text-xl font-semibold" data-testid="text-page-title">
            Historische Termine importieren
          </h1>
        </div>

        {error && (
          <Card className="border-red-200 bg-red-50" data-testid="card-error">
            <CardContent className="pt-4">
              <p className="text-red-700 text-sm">{error}</p>
            </CardContent>
          </Card>
        )}

        {!importResult && (
          <Card data-testid="card-upload">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4" />
                Excel-Datei hochladen
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                type="file"
                accept=".xlsx,.xls"
                data-testid="input-file"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              <Button
                onClick={loadPreview}
                disabled={!file || loading}
                data-testid="button-preview"
              >
                <Upload className="h-4 w-4 mr-2" />
                {loading ? "Verarbeite..." : "Vorschau laden"}
              </Button>
            </CardContent>
          </Card>
        )}

        {preview && !importResult && (
          <>
            <Card data-testid="card-summary">
              <CardContent className="pt-4">
                <div className="flex flex-wrap gap-4 text-sm">
                  <div className="flex items-center gap-1">
                    <span className="font-medium">Gesamt:</span> {preview.summary.total}
                  </div>
                  <div className="flex items-center gap-1">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <span>Neu: {preview.summary.new}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <AlertTriangle className="h-4 w-4 text-yellow-600" />
                    <span>Duplikate: {preview.summary.duplicate}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <XCircle className="h-4 w-4 text-red-600" />
                    <span>Fehler: {preview.summary.error}</span>
                  </div>
                  <div className="ml-auto font-medium">
                    Ausgewählt: {selectedForImport}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card data-testid="card-actions">
              <CardContent className="pt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setAllActions("import", "new")} data-testid="button-select-all-new">
                  Alle neuen auswählen
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAllActions("skip")} data-testid="button-deselect-all">
                  Alle abwählen
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAllActions("update", "duplicate")} data-testid="button-update-all-duplicates">
                  Alle Duplikate aktualisieren
                </Button>
                <div className="ml-auto">
                  <Button
                    onClick={executeImport}
                    disabled={importing || selectedForImport === 0}
                    data-testid="button-execute-import"
                  >
                    {importing ? "Importiere..." : `${selectedForImport} Termine importieren`}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {importing && (
              <div className="w-full bg-gray-200 rounded h-2" data-testid="progress-import">
                <div className="bg-primary h-2 rounded transition-all" style={{ width: `${progress}%` }} />
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse" data-testid="table-preview">
                <thead>
                  <tr className="bg-muted/50">
                    <th className="p-2 text-left w-8"></th>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2 text-left">Aktion</th>
                    <th className="p-2 text-left">Kunde</th>
                    <th className="p-2 text-left">Datum</th>
                    <th className="p-2 text-left">Zeit</th>
                    <th className="p-2 text-left">Dauer</th>
                    <th className="p-2 text-left">Art</th>
                    <th className="p-2 text-left">Budget</th>
                    <th className="p-2 text-left">Mitarbeiter</th>
                    <th className="p-2 text-left">km</th>
                    <th className="p-2 text-left">Info</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => {
                    const action = rowActions.get(row.rowIndex) || "skip";
                    const isSelected = action === "import" || action === "update";
                    const hasEmployeeError = row.errors.some((e) => e.includes("Mitarbeiter"));
                    const override = employeeOverrides.get(row.rowIndex);

                    return (
                      <tr
                        key={row.rowIndex}
                        className={`border-b ${
                          row.status === "error" ? "bg-red-50" : row.status === "duplicate" ? "bg-yellow-50" : ""
                        } ${isSelected ? "bg-green-50/30" : ""}`}
                        data-testid={`row-import-${row.rowIndex}`}
                      >
                        <td className="p-2">
                          <Checkbox
                            checked={isSelected}
                            disabled={row.status === "error" && !hasEmployeeError}
                            onCheckedChange={(checked) => {
                              const newActions = new Map(rowActions);
                              if (checked) {
                                newActions.set(row.rowIndex, row.status === "duplicate" ? "update" : "import");
                              } else {
                                newActions.set(row.rowIndex, "skip");
                              }
                              setRowActions(newActions);
                            }}
                            data-testid={`checkbox-row-${row.rowIndex}`}
                          />
                        </td>
                        <td className="p-2">
                          {row.status === "new" && (
                            <Badge variant="outline" className="text-green-700 border-green-300 text-[10px]" data-testid={`status-new-${row.rowIndex}`}>
                              Neu
                            </Badge>
                          )}
                          {row.status === "duplicate" && (
                            <Badge variant="outline" className="text-yellow-700 border-yellow-300 text-[10px]" data-testid={`status-duplicate-${row.rowIndex}`}>
                              Duplikat
                            </Badge>
                          )}
                          {row.status === "error" && (
                            <Badge variant="destructive" className="text-[10px]" data-testid={`status-error-${row.rowIndex}`}>
                              Fehler
                            </Badge>
                          )}
                        </td>
                        <td className="p-2">
                          {row.status !== "error" || hasEmployeeError ? (
                            <Select
                              value={action}
                              onValueChange={(val: string) => {
                                const newActions = new Map(rowActions);
                                newActions.set(row.rowIndex, val as RowAction);
                                setRowActions(newActions);
                              }}
                            >
                              <SelectTrigger className="h-6 text-[10px] w-24" data-testid={`select-action-${row.rowIndex}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="skip">Überspringen</SelectItem>
                                <SelectItem value="import">Importieren</SelectItem>
                                {row.status === "duplicate" && <SelectItem value="update">Aktualisieren</SelectItem>}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-red-500 text-[10px]">-</span>
                          )}
                        </td>
                        <td className="p-2 whitespace-nowrap" data-testid={`text-customer-${row.rowIndex}`}>
                          {row.vorname} {row.nachname}
                        </td>
                        <td className="p-2 whitespace-nowrap" data-testid={`text-date-${row.rowIndex}`}>{row.date}</td>
                        <td className="p-2 whitespace-nowrap">{row.startTime}–{row.endTime}</td>
                        <td className="p-2">{row.durationMinutes}min</td>
                        <td className="p-2">{row.serviceType}</td>
                        <td className="p-2 whitespace-nowrap text-[10px]">{row.budgetType}</td>
                        <td className="p-2">
                          {hasEmployeeError ? (
                            <Select
                              value={override ? String(override) : ""}
                              onValueChange={(val: string) => {
                                const newOverrides = new Map(employeeOverrides);
                                newOverrides.set(row.rowIndex, Number(val));
                                setEmployeeOverrides(newOverrides);
                                if (Number(val) > 0) {
                                  const newActions = new Map(rowActions);
                                  if (rowActions.get(row.rowIndex) === "skip") {
                                    newActions.set(row.rowIndex, "import");
                                  }
                                  setRowActions(newActions);
                                }
                              }}
                            >
                              <SelectTrigger className="h-6 text-[10px] w-36 border-red-300" data-testid={`select-employee-${row.rowIndex}`}>
                                <SelectValue placeholder={row.employeeName} />
                              </SelectTrigger>
                              <SelectContent>
                                {employees.map((emp) => (
                                  <SelectItem key={emp.id} value={String(emp.id)}>
                                    {emp.displayName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-[10px]" data-testid={`text-employee-${row.rowIndex}`}>{row.employeeName}</span>
                          )}
                        </td>
                        <td className="p-2">{row.kilometers}</td>
                        <td className="p-2">
                          {row.errors.length > 0 && (
                            <span className="text-red-600 text-[10px]" data-testid={`text-errors-${row.rowIndex}`}>
                              {row.errors.filter(e => !hasEmployeeError || !e.includes("Mitarbeiter")).join("; ")}
                            </span>
                          )}
                          {row.differences.length > 0 && (
                            <span className="text-yellow-700 text-[10px]" data-testid={`text-differences-${row.rowIndex}`}>
                              {row.differences.join("; ")}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {importResult && (
          <Card data-testid="card-result">
            <CardHeader>
              <CardTitle className="text-base">Import-Ergebnis</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="p-3 rounded bg-green-50 border border-green-200" data-testid="text-result-imported">
                  <div className="font-medium text-green-800">Importiert</div>
                  <div className="text-2xl font-bold text-green-700">{importResult.imported}</div>
                </div>
                <div className="p-3 rounded bg-blue-50 border border-blue-200" data-testid="text-result-updated">
                  <div className="font-medium text-blue-800">Aktualisiert</div>
                  <div className="text-2xl font-bold text-blue-700">{importResult.updated}</div>
                </div>
                <div className="p-3 rounded bg-gray-50 border border-gray-200" data-testid="text-result-skipped">
                  <div className="font-medium text-gray-600">Übersprungen</div>
                  <div className="text-2xl font-bold text-gray-500">{importResult.skipped}</div>
                </div>
                <div className="p-3 rounded bg-red-50 border border-red-200" data-testid="text-result-errors">
                  <div className="font-medium text-red-800">Fehler</div>
                  <div className="text-2xl font-bold text-red-700">{importResult.errors.length}</div>
                </div>
              </div>

              {importResult.errors.length > 0 && (
                <div className="mt-3">
                  <h3 className="font-medium text-sm text-red-700 mb-1">Fehler-Details:</h3>
                  <div className="max-h-60 overflow-y-auto text-xs space-y-2">
                    {importResult.errors.map((e, i) => {
                      const row = preview?.rows.find(r => r.rowIndex === e.rowIndex);
                      return (
                        <div key={i} className="text-red-700 p-2 bg-red-50 rounded border border-red-200" data-testid={`error-detail-${i}`}>
                          <div className="font-medium flex items-center gap-2 mb-1">
                            <XCircle className="h-3.5 w-3.5 flex-shrink-0" />
                            {row ? (
                              <span>{row.vorname} {row.nachname} — {row.date}, {row.startTime}–{row.endTime} ({row.serviceType})</span>
                            ) : (
                              <span>Zeile {e.rowIndex}</span>
                            )}
                          </div>
                          <div className="text-red-600 pl-[22px]">{e.error}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {importResult.imported > 0 && !serviceRecordResult && (
                <div className="pt-3 border-t">
                  <Button
                    onClick={createServiceRecords}
                    disabled={creatingRecords}
                    data-testid="button-create-service-records"
                  >
                    {creatingRecords ? "Erstelle..." : "Leistungsnachweise erstellen"}
                  </Button>
                  <p className="text-xs text-muted-foreground mt-1">
                    Erstellt synthetische Leistungsnachweise für alle importierten Monate.
                  </p>
                </div>
              )}

              {serviceRecordResult && (
                <div className="pt-3 border-t" data-testid="card-service-record-result">
                  <div className="text-sm">
                    <span className="font-medium text-green-700">
                      {serviceRecordResult.created} Leistungsnachweise erstellt
                    </span>
                    {serviceRecordResult.errors.length > 0 && (
                      <div className="mt-1 text-xs text-red-600">
                        {serviceRecordResult.errors.length} Fehler:
                        {serviceRecordResult.errors.slice(0, 5).map((e, i) => (
                          <div key={i}>{e.key}: {e.error}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
