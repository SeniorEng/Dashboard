/**
 * Task #669 — Import-Reconcile-UI.
 *
 * Optionaler Schritt nach dem Excel-Import-Preview: Excel als Single Source
 * of Truth für gewählte Kunden + Zeitraum behandeln, DB-Termine die NICHT
 * in der Excel sind GoBD-konform soft-stornieren. Superadmin-Only — die
 * Backend-Route ist hinter `requireSuperAdmin` gemounted, dieses UI gehört
 * zur Admin-Import-Seite (die ebenfalls Superadmin-only ist).
 */

import { useCallback, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";

export interface ImportRowKey {
  customerId: number | null;
  date: string;
  startTime: string;
  vorname: string;
  nachname: string;
}

interface ReconcileAppointmentInfo {
  appointmentId: number;
  customerId: number;
  customerName: string;
  date: string;
  scheduledStart: string | null;
  assignedEmployeeId: number | null;
  performedByEmployeeId: number | null;
  durationPromised: number;
  status: string;
}

interface ReconcileExcludedInfo extends ReconcileAppointmentInfo {
  exclusionReason:
    | "signed_service_record"
    | "signed_appointment"
    | "month_closed"
    | "beyond_excel_cutoff";
  exclusionDetail?: string;
}

interface ReconcilePreviewResponse {
  cancellable: ReconcileAppointmentInfo[];
  excluded: ReconcileExcludedInfo[];
  /** Task #708: Server-Token, im Execute zwingend mitzusenden. */
  previewToken: string;
}

export interface ReconcileExecuteResponse {
  batchId: string;
  cancelled: number;
  reversedTransactions: number;
  excluded: number;
  errors: { appointmentId: number; error: string }[];
}

function exclusionReasonLabel(r: ReconcileExcludedInfo["exclusionReason"]): string {
  switch (r) {
    case "signed_service_record":
      return "Leistungsnachweis unterschrieben";
    case "signed_appointment":
      return "Termin unterschrieben";
    case "month_closed":
      return "Monat geschlossen";
    case "beyond_excel_cutoff":
      return "Cutoff-geschützt (nach letztem Excel-Monat)";
  }
}

interface CustomerOption {
  customerId: number;
  label: string;
}

export interface ImportReconcileSectionProps {
  /** Alle Excel-Zeilen mit gemappten Kunden — Basis für Default-Scope. */
  excelRows: ImportRowKey[];
  /** Ob das Modul aktiviert ist (Checkbox vom User). */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Ergebnis der letzten Execute-Stornierung — wird vom Parent gehalten. */
  result: ReconcileExecuteResponse | null;
  onResultChange: (r: ReconcileExecuteResponse | null) => void;
}

export function ImportReconcileSection({
  excelRows,
  enabled,
  onEnabledChange,
  result,
  onResultChange,
}: ImportReconcileSectionProps) {
  // Default-Scope: alle Kunden + min/max-Datum aus Excel.
  const customerOptions = useMemo<CustomerOption[]>(() => {
    const map = new Map<number, string>();
    for (const r of excelRows) {
      if (r.customerId != null && !map.has(r.customerId)) {
        map.set(r.customerId, `${r.vorname} ${r.nachname}`.trim());
      }
    }
    return Array.from(map.entries())
      .map(([customerId, label]) => ({ customerId, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [excelRows]);

  const defaultDateRange = useMemo(() => {
    const dates = excelRows.map((r) => r.date).filter(Boolean).sort();
    return { start: dates[0] ?? "", end: dates[dates.length - 1] ?? "" };
  }, [excelRows]);

  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(
    () => new Set(customerOptions.map((c) => c.customerId)),
  );
  const [startDate, setStartDate] = useState<string>(defaultDateRange.start);
  const [endDate, setEndDate] = useState<string>(defaultDateRange.end);
  const [reason, setReason] = useState<string>("");
  const [preview, setPreview] = useState<ReconcilePreviewResponse | null>(null);
  const [selectedAppointmentIds, setSelectedAppointmentIds] = useState<Set<number>>(new Set());
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCustomer = (customerId: number) => {
    setSelectedCustomerIds((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
    setPreview(null);
    setSelectedAppointmentIds(new Set());
  };

  const loadPreview = useCallback(async () => {
    setError(null);
    setPreview(null);
    setSelectedAppointmentIds(new Set());

    const customerIds = Array.from(selectedCustomerIds);
    if (customerIds.length === 0) {
      setError("Bitte mindestens einen Kunden auswählen");
      return;
    }
    if (!startDate || !endDate) {
      setError("Bitte Zeitraum angeben");
      return;
    }
    if (startDate > endDate) {
      setError("Startdatum darf nicht nach Enddatum liegen");
      return;
    }

    const excelKeys = excelRows
      .filter(
        (r) =>
          r.customerId != null &&
          customerIds.includes(r.customerId) &&
          r.date >= startDate &&
          r.date <= endDate &&
          r.startTime,
      )
      .map((r) => ({
        customerId: r.customerId as number,
        date: r.date,
        startTime: r.startTime,
      }));

    setLoadingPreview(true);
    try {
      const data = unwrapResult(
        await api.post<ReconcilePreviewResponse>(
          "/admin/import-appointments/reconcile/preview",
          { customerIds, startDate, endDate, excelKeys },
        ),
      );
      setPreview(data);
      setSelectedAppointmentIds(new Set(data.cancellable.map((a) => a.appointmentId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPreview(false);
    }
  }, [selectedCustomerIds, startDate, endDate, excelRows]);

  const toggleAppointment = (appointmentId: number) => {
    setSelectedAppointmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(appointmentId)) next.delete(appointmentId);
      else next.add(appointmentId);
      return next;
    });
  };

  const reasonValid = reason.trim().length >= 10;
  const canExecute =
    !!preview && selectedAppointmentIds.size > 0 && reasonValid && !executing;

  const executeReconcile = useCallback(async () => {
    if (!preview || selectedAppointmentIds.size === 0) return;
    if (!reasonValid) {
      setError("Begründung muss mindestens 10 Zeichen lang sein");
      return;
    }
    setError(null);
    setExecuting(true);
    try {
      const data = unwrapResult(
        await api.post<ReconcileExecuteResponse>(
          "/admin/import-appointments/reconcile/execute",
          {
            appointmentIds: Array.from(selectedAppointmentIds),
            reason: reason.trim(),
            // Task #708: Server-trusted Snapshot via Token; Scope + Cutoff
            // werden serverseitig aus dem Preview-Snapshot gelesen.
            previewToken: preview.previewToken,
          },
        ),
      );
      onResultChange(data);
      setPreview(null);
      setSelectedAppointmentIds(new Set());
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }, [preview, selectedAppointmentIds, reasonValid, reason, selectedCustomerIds, startDate, endDate, onResultChange]);

  return (
    <Card data-testid="card-reconcile">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => onEnabledChange(checked === true)}
            data-testid="checkbox-reconcile-enabled"
          />
          <RotateCcw className="h-4 w-4" />
          <span>Import-Abgleich (Excel als Single Source of Truth)</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground pl-7">
          Optional: Termine im gewählten Zeitraum, die NICHT in der Excel stehen,
          werden GoBD-konform storniert (Audit-Log + Begründung). Geschützt:
          unterschriebene Leistungsnachweise/Termine und geschlossene Monate.
        </p>
      </CardHeader>
      {enabled && (
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-xs font-medium block mb-1">Kunden im Scope</label>
              <div className="max-h-40 overflow-y-auto border rounded p-2 space-y-1" data-testid="list-reconcile-customers">
                {customerOptions.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    Keine gemappten Kunden in der Excel
                  </span>
                )}
                {customerOptions.map((c) => (
                  <label
                    key={c.customerId}
                    className="flex items-center gap-2 text-xs"
                    data-testid={`label-reconcile-customer-${c.customerId}`}
                  >
                    <Checkbox
                      checked={selectedCustomerIds.has(c.customerId)}
                      onCheckedChange={() => toggleCustomer(c.customerId)}
                      data-testid={`checkbox-reconcile-customer-${c.customerId}`}
                    />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <div>
                <label className="text-xs font-medium block mb-1">Von</label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setPreview(null);
                  }}
                  data-testid="input-reconcile-start-date"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1">Bis</label>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => {
                    setEndDate(e.target.value);
                    setPreview(null);
                  }}
                  data-testid="input-reconcile-end-date"
                />
              </div>
            </div>
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={loadPreview}
            disabled={loadingPreview}
            data-testid="button-reconcile-preview"
          >
            {loadingPreview ? "Lade Vorschau..." : "Stornier-Vorschau laden"}
          </Button>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2" data-testid="text-reconcile-error">
              {error}
            </div>
          )}

          {preview && (
            <>
              <div className="text-xs flex flex-wrap gap-3 items-center" data-testid="text-reconcile-summary">
                <span>
                  Stornier-Kandidaten: <strong>{preview.cancellable.length}</strong>
                </span>
                <span>
                  Ausgenommen: <strong>{preview.excluded.length}</strong>
                </span>
                <span className="ml-auto">
                  Ausgewählt: <strong>{selectedAppointmentIds.size}</strong>
                </span>
              </div>

              {preview.cancellable.length > 0 && (
                <div className="border rounded">
                  <div className="bg-muted/50 px-2 py-1 text-xs font-medium">
                    Würden storniert werden
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    <table className="w-full text-xs">
                      <tbody>
                        {preview.cancellable.map((a) => (
                          <tr key={a.appointmentId} className="border-t" data-testid={`row-reconcile-cancellable-${a.appointmentId}`}>
                            <td className="p-1">
                              <Checkbox
                                checked={selectedAppointmentIds.has(a.appointmentId)}
                                onCheckedChange={() => toggleAppointment(a.appointmentId)}
                                data-testid={`checkbox-reconcile-appt-${a.appointmentId}`}
                              />
                            </td>
                            <td className="p-1 whitespace-nowrap">{a.date}</td>
                            <td className="p-1 whitespace-nowrap">{a.scheduledStart ?? ""}</td>
                            <td className="p-1">{a.customerName}</td>
                            <td className="p-1 whitespace-nowrap">{a.durationPromised}min</td>
                            <td className="p-1">
                              <Badge variant="outline" className="text-[10px]">
                                {a.status}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {preview.excluded.length > 0 && (
                <div className="border rounded">
                  <div className="bg-muted/50 px-2 py-1 text-xs font-medium flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3 text-yellow-600" />
                    Ausgenommen (geschützt)
                  </div>
                  <div className="max-h-40 overflow-y-auto">
                    <table className="w-full text-xs">
                      <tbody>
                        {preview.excluded.map((a) => (
                          <tr key={a.appointmentId} className="border-t" data-testid={`row-reconcile-excluded-${a.appointmentId}`}>
                            <td className="p-1 whitespace-nowrap">{a.date}</td>
                            <td className="p-1 whitespace-nowrap">{a.scheduledStart ?? ""}</td>
                            <td className="p-1">{a.customerName}</td>
                            <td className="p-1 text-yellow-700">
                              {exclusionReasonLabel(a.exclusionReason)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {preview.cancellable.length > 0 && (
                <div className="space-y-2 pt-2 border-t">
                  <label className="text-xs font-medium block">
                    Begründung (≥10 Zeichen, Pflicht für Audit-Log)
                  </label>
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="z.B. Excel ist die Single Source of Truth für April 2026 nach Abstimmung mit Buchhaltung"
                    className="text-xs"
                    rows={2}
                    data-testid="textarea-reconcile-reason"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={executeReconcile}
                      disabled={!canExecute}
                      data-testid="button-reconcile-execute"
                    >
                      {executing
                        ? "Storniere..."
                        : `${selectedAppointmentIds.size} Termine stornieren`}
                    </Button>
                    {!reasonValid && reason.length > 0 && (
                      <span className="text-xs text-red-600">
                        Begründung zu kurz ({reason.trim().length}/10)
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {result && (
            <div
              className="text-xs bg-green-50 border border-green-200 rounded p-2 space-y-1"
              data-testid="text-reconcile-result"
            >
              <div>
                <strong>{result.cancelled}</strong> Termine storniert,
                <strong className="ml-1">{result.reversedTransactions}</strong> Budget-Buchungen rückgängig gemacht.
              </div>
              {result.excluded > 0 && (
                <div className="text-yellow-700">
                  {result.excluded} Termine zwischenzeitlich geschützt — übersprungen.
                </div>
              )}
              {result.errors.length > 0 && (
                <div className="text-red-700">
                  {result.errors.length} Fehler:
                  {result.errors.slice(0, 5).map((e, i) => (
                    <div key={i}>#{e.appointmentId}: {e.error}</div>
                  ))}
                </div>
              )}
              <div className="text-muted-foreground">
                Batch-ID: <code>{result.batchId}</code>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
