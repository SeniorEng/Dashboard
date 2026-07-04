import { useState, useCallback } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Upload, CheckCircle, AlertTriangle, XCircle, FileSpreadsheet, Scissors } from "lucide-react";
import { Link } from "wouter";
import { api, unwrapResult } from "@/lib/api/client";
import {
  ImportReconcileSection,
  type ReconcileExecuteResponse,
} from "@/features/appointments/import-reconcile-section";
import {
  determineImportAction,
  actionWhenSelected,
  classifyImportAction,
} from "@shared/domain/import-appointment-action";

interface BudgetTrimInfo {
  originalMinutes: number;
  trimmedMinutes: number;
  reason: string;
}

interface ImportRowDiff {
  serviceCode?: { db: string | null; excel: string };
  durationMinutes?: { db: number; excel: number };
  endTime?: { db: string; excel: string };
  assignedEmployee?: { dbId: number | null; dbName: string | null; excelId: number | null; excelName: string };
  kilometers?: { db: number; excel: number };
}

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
  status: "new" | "duplicate" | "upgrade" | "beyond_cutoff" | "error";
  errors: string[];
  existingAppointmentId: number | null;
  differences: string[];
  budgetTrimInfo: BudgetTrimInfo | null;
  diff: ImportRowDiff | null;
  /** Task #1243: Vorjahres-Termin echter Pflegekasse → nur Dokumentation, kein Budgetverbrauch. */
  documentationOnly?: boolean;
  /** Task #1602: Bestandstermin bereits abgerechnet (signierter LN ODER nicht-stornierte Rechnung) → nicht aktualisierbar. */
  billedProtected?: boolean;
}

function serviceCodeLabel(code: string | null | undefined): string {
  if (!code) return "?";
  if (code === "hauswirtschaft") return "HW";
  if (code === "alltagsbegleitung") return "AB";
  return code;
}

interface DuplicateImportWarning {
  batchId: number;
  fileName: string | null;
  importedAt: string;
  importedCount: number;
  updatedCount: number;
}

interface PreviewResponse {
  rows: MatchedRow[];
  summary: { total: number; new: number; duplicate: number; upgrade: number; beyondCutoff: number; error: number; budgetTrimmed: number; documentationOnly: number; billedProtected: number };
  /** Task #708: Server-Token für Trust-Boundary im Execute. */
  previewToken: string;
  /** Task #819: SHA-256 des Datei-Puffers (Doppel-Import-Erkennung). */
  fileHash: string;
  /** Task #819: Gesetzt, wenn dieselbe Datei schon einmal importiert wurde. */
  duplicateImportWarning: DuplicateImportWarning | null;
}

interface ImportResult {
  imported: number;
  updated: number;
  /** Task #708: bisher nur geplante Termine auf `completed` angehoben. */
  upgraded: number;
  skipped: number;
  trimmed: number;
  /** Task #708: durch Cutoff-Schutz blockierte Mutationen. */
  cutoffProtected: number;
  /** Task #1243: als reine Dokumentation (ohne Budgetverbrauch) importierte Vorjahres-Termine. */
  documentationOnly: number;
  /** Task #1602: übersprungene, bereits abgerechnete Bestandstermine (LN/Rechnung). */
  billedProtected: number;
  errors: { rowIndex: number; error: string }[];
}

interface Employee {
  id: number;
  displayName: string;
}

type RowAction = "import" | "update" | "upgrade" | "skip";

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
  // Task #819: GoBD-Gate — Diffs müssen bewusst geprüft werden, bevor
  // Bestandstermine via Import überschrieben werden.
  const [diffsReviewed, setDiffsReviewed] = useState(false);

  // Task #669 — optional Import-Reconcile (Single-Source-of-Truth-Modus).
  const [reconcileEnabled, setReconcileEnabled] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<ReconcileExecuteResponse | null>(null);

  const loadPreview = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    setImportResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const data = unwrapResult(
        await api.postFormData<PreviewResponse>("/admin/import-appointments/preview", formData)
      );
      setPreview(data);

      // Task #819: Default-Aktion zentral aus Status + Diff ableiten
      // (`determineImportAction`) — eine einzige Quelle für Preview-Default
      // UND Checkbox-Toggle, damit die Status→Aktion-Logik nicht driftet.
      const defaultActions = new Map<number, RowAction>();
      for (const row of data.rows) {
        defaultActions.set(
          row.rowIndex,
          determineImportAction({
            status: row.status,
            hasDiff: row.diff !== null,
            billedProtected: row.billedProtected === true,
          }),
        );
      }
      setRowActions(defaultActions);
      setDiffsReviewed(false);

      const empResult = await api.get<Employee[]>("/admin/import-appointments/employees");
      if (empResult.success) {
        setEmployees(empResult.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [file]);

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

      const result = unwrapResult(
        await api.post<ImportResult>("/admin/import-appointments/execute", {
          rows: preview.rows,
          actions,
          previewToken: preview.previewToken,
        })
      );
      setImportResult(result);
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [preview, rowActions, employeeOverrides]);

  const createServiceRecords = useCallback(async () => {
    setCreatingRecords(true);
    setError(null);

    try {
      const result = unwrapResult(
        await api.post<{ created: number; errors: { key: string; error: string }[] }>("/admin/import-appointments/create-service-records", {})
      );
      setServiceRecordResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingRecords(false);
    }
  }, []);

  const setAllActions = (action: RowAction, filter?: "new" | "duplicate") => {
    if (!preview) return;
    const newActions = new Map(rowActions);
    for (const row of preview.rows) {
      if (filter && row.status !== filter) continue;
      if (row.status === "error" && action !== "skip") continue;
      // Task #1602: Bereits abgerechnete Bestandstermine bleiben immer `skip`
      // (Massen-Aktion darf sie nicht auf update/upgrade/import setzen).
      if (row.billedProtected && action !== "skip") continue;
      newActions.set(row.rowIndex, action);
    }
    setRowActions(newActions);
  };

  const selectedForImport = preview
    ? preview.rows.filter((r) => {
        const action = rowActions.get(r.rowIndex);
        return action === "import" || action === "update" || action === "upgrade";
      }).length
    : 0;

  // Task #819: Sind selektierte Zeilen dabei, die einen Bestandstermin mit
  // Feld-Diff überschreiben (Update/Upgrade)? Dann muss der Nutzer die Diffs
  // vor dem Import explizit bestätigt haben (GoBD-Vier-Augen-Gate).
  const selectedDiffCount = preview
    ? preview.rows.filter((r) => {
        const action = rowActions.get(r.rowIndex);
        return (action === "update" || action === "upgrade") && r.diff !== null;
      }).length
    : 0;
  const requiresDiffReview = selectedDiffCount > 0;
  const executeBlocked = selectedForImport === 0 || (requiresDiffReview && !diffsReviewed);

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

        {preview?.duplicateImportWarning && !importResult && (
          <Card className="border-amber-300 bg-amber-50" data-testid="card-duplicate-import-warning">
            <CardContent className="pt-4">
              <div className="flex items-start gap-2 text-sm text-amber-800">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">Diese Datei wurde bereits importiert.</p>
                  <p className="text-amber-700 text-xs mt-0.5" data-testid="text-duplicate-import-detail">
                    {preview.duplicateImportWarning.fileName ?? "Unbenannte Datei"} — am{" "}
                    {new Date(preview.duplicateImportWarning.importedAt).toLocaleString("de-DE")}
                    {" "}({preview.duplicateImportWarning.importedCount} importiert,{" "}
                    {preview.duplicateImportWarning.updatedCount} aktualisiert). Ein erneuter
                    Import kann zu Doppelbuchungen führen — bitte die Diffs sorgfältig prüfen.
                  </p>
                </div>
              </div>
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
                  {preview.summary.upgrade > 0 && (
                    <div className="flex items-center gap-1" data-testid="summary-upgrade">
                      <CheckCircle className="h-4 w-4 text-blue-600" />
                      <span>Upgegradet: {preview.summary.upgrade}</span>
                    </div>
                  )}
                  {preview.summary.beyondCutoff > 0 && (
                    <div className="flex items-center gap-1" data-testid="summary-beyond-cutoff">
                      <AlertTriangle className="h-4 w-4 text-slate-500" />
                      <span>Cutoff-geschützt: {preview.summary.beyondCutoff}</span>
                    </div>
                  )}
                  {preview.summary.billedProtected > 0 && (
                    <div className="flex items-center gap-1" data-testid="summary-billed-protected">
                      <AlertTriangle className="h-4 w-4 text-purple-600" />
                      <span>Bereits abgerechnet: {preview.summary.billedProtected}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <XCircle className="h-4 w-4 text-red-600" />
                    <span>Fehler: {preview.summary.error}</span>
                  </div>
                  {preview.summary.budgetTrimmed > 0 && (
                    <div className="flex items-center gap-1">
                      <Scissors className="h-4 w-4 text-orange-600" />
                      <span>Budget-Kürzung: {preview.summary.budgetTrimmed}</span>
                    </div>
                  )}
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
                <div className="ml-auto flex items-center gap-3">
                  {requiresDiffReview && (
                    <label className="flex items-center gap-2 text-xs text-amber-800 cursor-pointer" data-testid="label-diffs-reviewed">
                      <Checkbox
                        checked={diffsReviewed}
                        onCheckedChange={(checked) => setDiffsReviewed(checked === true)}
                        data-testid="checkbox-diffs-reviewed"
                      />
                      <span>
                        Diffs geprüft ({selectedDiffCount} Termin{selectedDiffCount === 1 ? "" : "e"} mit Abweichung)
                      </span>
                    </label>
                  )}
                  <Button
                    onClick={executeImport}
                    disabled={importing || executeBlocked}
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
                    const isSelected = action === "import" || action === "update" || action === "upgrade";
                    const hasEmployeeError = row.errors.some((e) => e.includes("Mitarbeiter"));
                    const override = employeeOverrides.get(row.rowIndex);
                    const isBudgetTrimmed = row.budgetTrimInfo !== null;

                    return (
                      <tr
                        key={row.rowIndex}
                        className={`border-b ${
                          row.status === "error" ? "bg-red-50" : row.status === "duplicate" ? "bg-yellow-50" : isBudgetTrimmed ? "bg-orange-50" : ""
                        } ${isSelected ? "bg-green-50/30" : ""}`}
                        data-testid={`row-import-${row.rowIndex}`}
                      >
                        <td className="p-2">
                          <Checkbox
                            checked={isSelected}
                            disabled={(row.status === "error" && !hasEmployeeError) || row.status === "beyond_cutoff" || row.billedProtected === true}
                            onCheckedChange={(checked) => {
                              const newActions = new Map(rowActions);
                              if (checked) {
                                newActions.set(row.rowIndex, actionWhenSelected(row.status, row.billedProtected === true));
                              } else {
                                newActions.set(row.rowIndex, "skip");
                              }
                              setRowActions(newActions);
                            }}
                            data-testid={`checkbox-row-${row.rowIndex}`}
                          />
                        </td>
                        <td className="p-2">
                          {row.status === "new" && row.documentationOnly && (
                            <Badge variant="outline" className="text-teal-700 border-teal-300 bg-teal-50 text-[10px]" data-testid={`status-documentation-only-${row.rowIndex}`}>
                              Dokumentation
                            </Badge>
                          )}
                          {row.status === "new" && !isBudgetTrimmed && !row.documentationOnly && (
                            <Badge variant="outline" className="text-green-700 border-green-300 text-[10px]" data-testid={`status-new-${row.rowIndex}`}>
                              Neu
                            </Badge>
                          )}
                          {row.status === "new" && isBudgetTrimmed && (
                            <Badge variant="outline" className="text-orange-700 border-orange-300 bg-orange-50 text-[10px]" data-testid={`status-budget-trimmed-${row.rowIndex}`}>
                              <Scissors className="h-3 w-3 mr-0.5" />
                              Gekürzt
                            </Badge>
                          )}
                          {row.status === "duplicate" && (
                            <Badge variant="outline" className="text-yellow-700 border-yellow-300 text-[10px]" data-testid={`status-duplicate-${row.rowIndex}`}>
                              Duplikat
                            </Badge>
                          )}
                          {row.status === "upgrade" && (
                            <Badge variant="outline" className="text-blue-700 border-blue-300 bg-blue-50 text-[10px]" data-testid={`status-upgrade-${row.rowIndex}`}>
                              Hochstufen
                            </Badge>
                          )}
                          {row.status === "beyond_cutoff" && (
                            <Badge variant="outline" className="text-slate-600 border-slate-300 bg-slate-50 text-[10px]" data-testid={`status-beyond-cutoff-${row.rowIndex}`}>
                              Cutoff-geschützt
                            </Badge>
                          )}
                          {row.status === "error" && (
                            <Badge variant="destructive" className="text-[10px]" data-testid={`status-error-${row.rowIndex}`}>
                              Fehler
                            </Badge>
                          )}
                          {/* Task #1602: Bereits abgerechneter Bestandstermin
                              (signierter LN ODER nicht-stornierte Rechnung) →
                              hart geschützt, kein Update per Import. */}
                          {row.billedProtected && (
                            <Badge variant="outline" className="ml-1 text-purple-700 border-purple-300 bg-purple-50 text-[10px]" data-testid={`status-billed-protected-${row.rowIndex}`}>
                              bereits abgerechnet
                            </Badge>
                          )}
                          {/* Task #819: Aktions-Klassifikation (create/update/noop) */}
                          {(row.status === "duplicate" || row.status === "upgrade") && !row.billedProtected && (
                            classifyImportAction({ status: row.status, hasDiff: row.diff !== null }) === "update" ? (
                              <Badge variant="outline" className="ml-1 text-amber-700 border-amber-300 bg-amber-50 text-[10px]" data-testid={`classify-update-${row.rowIndex}`}>
                                Update: alt→neu
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="ml-1 text-slate-500 border-slate-300 text-[10px]" data-testid={`classify-unchanged-${row.rowIndex}`}>
                                unverändert
                              </Badge>
                            )
                          )}
                          {/* Task #1602: Diff + Schutz → Nutzer muss per Storno korrigieren. */}
                          {row.billedProtected && row.diff !== null && (
                            <Badge variant="outline" className="ml-1 text-purple-600 border-purple-300 text-[10px]" data-testid={`classify-protected-drift-${row.rowIndex}`}>
                              prüfen / ggf. per Storno korrigieren
                            </Badge>
                          )}
                        </td>
                        <td className="p-2">
                          {row.status === "beyond_cutoff" ? (
                            <span className="text-slate-400 text-[10px]">Cutoff</span>
                          ) : row.status !== "error" || hasEmployeeError ? (
                            <Select
                              value={action}
                              disabled={row.billedProtected === true}
                              onValueChange={(val: string) => {
                                if (row.billedProtected === true) return;
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
                                {!row.billedProtected && <SelectItem value="import">Importieren</SelectItem>}
                                {!row.billedProtected && row.status === "duplicate" && <SelectItem value="update">Aktualisieren</SelectItem>}
                                {!row.billedProtected && row.status === "upgrade" && <SelectItem value="upgrade">Hochstufen</SelectItem>}
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
                        <td className="p-2 whitespace-nowrap">
                          {row.startTime}–{row.endTime}
                          {row.diff?.endTime && (
                            <span
                              className="block text-yellow-700 text-[10px]"
                              data-testid={`diff-endtime-${row.rowIndex}`}
                            >
                              DB: {row.diff.endTime.db}
                            </span>
                          )}
                        </td>
                        <td className="p-2" data-testid={`text-duration-${row.rowIndex}`}>
                          {isBudgetTrimmed ? (
                            <span className="text-orange-700 font-medium">
                              <span className="line-through text-muted-foreground">{row.budgetTrimInfo!.originalMinutes}</span>
                              {" → "}
                              {row.budgetTrimInfo!.trimmedMinutes}min
                            </span>
                          ) : (
                            <span>{row.durationMinutes}min</span>
                          )}
                          {row.diff?.durationMinutes && (
                            <span
                              className="block text-yellow-700 text-[10px]"
                              data-testid={`diff-duration-${row.rowIndex}`}
                            >
                              DB: {row.diff.durationMinutes.db}min
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          {row.serviceType}
                          {row.diff?.serviceCode && (
                            <Badge
                              variant="destructive"
                              className="ml-1 text-[10px]"
                              data-testid={`badge-service-mismatch-${row.rowIndex}`}
                            >
                              Art weicht ab: {serviceCodeLabel(row.diff.serviceCode.db)} → {serviceCodeLabel(row.diff.serviceCode.excel)}
                            </Badge>
                          )}
                        </td>
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
                          {row.diff?.assignedEmployee && (
                            <span
                              className="block text-yellow-700 text-[10px]"
                              data-testid={`diff-employee-${row.rowIndex}`}
                            >
                              DB: {row.diff.assignedEmployee.dbName ?? row.diff.assignedEmployee.dbId ?? "?"}
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          {row.kilometers}
                          {row.diff?.kilometers && (
                            <span
                              className="block text-yellow-700 text-[10px]"
                              data-testid={`diff-km-${row.rowIndex}`}
                            >
                              DB: {row.diff.kilometers.db}
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          {isBudgetTrimmed && (
                            <span className="text-orange-700 text-[10px] block" data-testid={`text-budget-trim-${row.rowIndex}`}>
                              {row.budgetTrimInfo!.reason}
                            </span>
                          )}
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

        {preview && !importResult && (
          <ImportReconcileSection
            excelRows={preview.rows.map((r) => ({
              customerId: r.customerId,
              date: r.date,
              startTime: r.startTime,
              vorname: r.vorname,
              nachname: r.nachname,
            }))}
            enabled={reconcileEnabled}
            onEnabledChange={setReconcileEnabled}
            result={reconcileResult}
            onResultChange={setReconcileResult}
          />
        )}

        {importResult && (
          <Card data-testid="card-result">
            <CardHeader>
              <CardTitle className="text-base">Import-Ergebnis</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                <div className="p-3 rounded bg-green-50 border border-green-200" data-testid="text-result-imported">
                  <div className="font-medium text-green-800">Importiert</div>
                  <div className="text-2xl font-bold text-green-700">{importResult.imported}</div>
                </div>
                {importResult.trimmed > 0 && (
                  <div className="p-3 rounded bg-orange-50 border border-orange-200" data-testid="text-result-trimmed">
                    <div className="font-medium text-orange-800">Davon gekürzt</div>
                    <div className="text-2xl font-bold text-orange-700">{importResult.trimmed}</div>
                  </div>
                )}
                {importResult.documentationOnly > 0 && (
                  <div className="p-3 rounded bg-teal-50 border border-teal-200" data-testid="text-result-documentation-only">
                    <div className="font-medium text-teal-800">Als Dokumentation</div>
                    <div className="text-2xl font-bold text-teal-700">{importResult.documentationOnly}</div>
                  </div>
                )}
                <div className="p-3 rounded bg-blue-50 border border-blue-200" data-testid="text-result-updated">
                  <div className="font-medium text-blue-800">Aktualisiert</div>
                  <div className="text-2xl font-bold text-blue-700">{importResult.updated}</div>
                </div>
                {importResult.upgraded > 0 && (
                  <div className="p-3 rounded bg-purple-50 border border-purple-200" data-testid="text-result-upgraded">
                    <div className="font-medium text-purple-800">Upgegradet</div>
                    <div className="text-2xl font-bold text-purple-700">{importResult.upgraded}</div>
                  </div>
                )}
                {importResult.cutoffProtected > 0 && (
                  <div className="p-3 rounded bg-amber-50 border border-amber-200" data-testid="text-result-cutoff-protected">
                    <div className="font-medium text-amber-800">Cutoff-geschützt</div>
                    <div className="text-2xl font-bold text-amber-700">{importResult.cutoffProtected}</div>
                  </div>
                )}
                {importResult.billedProtected > 0 && (
                  <div className="p-3 rounded bg-purple-50 border border-purple-200" data-testid="text-result-billed-protected">
                    <div className="font-medium text-purple-800">Bereits abgerechnet</div>
                    <div className="text-2xl font-bold text-purple-700">{importResult.billedProtected}</div>
                  </div>
                )}
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
