import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { iconSize } from "@/design-system";
import { Loader2, Euro, Pencil, Check, X, Calendar, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { api, unwrapResult, ApiError } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatEuroDE, parseEuroDE } from "@shared/utils/format";
import { parseLocalDate } from "@shared/utils/datetime";
import { WAGE_ROLES, type WageRole } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface ServiceData {
  id: number;
  name: string;
  code: string | null;
  unitType: string;
  defaultPriceCents: number;
  employeeRateCents: number;
  isActive: boolean;
  isBillable: boolean;
}

interface WageRateRow {
  id: number;
  role: WageRole;
  serviceId: number;
  cents: number;
  validFrom: string;
  validTo: string | null;
  serviceName: string;
  serviceCode: string | null;
  defaultRateCents: number;
  unitType: string;
}

interface AffectedMonth {
  year: number;
  month: number;
  employeeCount: number;
}

type SaveVariables = {
  role: WageRole;
  serviceId: number;
  cents: number;
  validFrom?: string;
  confirmReplace?: boolean;
  confirmClosedOverride?: boolean;
};

type DeleteVariables = {
  rateId: number;
  confirmClosedOverride?: boolean;
};

interface PendingReplaceState {
  role: WageRole;
  serviceId: number;
  cents: number;
  validFrom?: string;
  existing: { id: number; cents: number; validFrom: string; serviceName: string; role: WageRole };
}

type PendingClosed =
  | { kind: "save"; vars: SaveVariables; months: AffectedMonth[] }
  | { kind: "delete"; vars: DeleteVariables; months: AffectedMonth[] };

const ROLE_LABELS: Record<WageRole, string> = {
  admin: "Verwaltung",
  teamLead: "Teamleitung",
  employee: "Mitarbeiter",
};

const UNIT_LABELS: Record<string, string> = {
  hours: "/Std.",
  kilometers: "/km",
  flat: " pauschal",
};

const MONTH_LABELS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function getTodayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateDisplay(dateStr: string | null | undefined): string {
  if (!dateStr || typeof dateStr !== "string") return "—";
  try {
    const d = parseLocalDate(dateStr.slice(0, 10));
    if (!d || Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return "—";
  }
}

function cellKey(role: WageRole, serviceId: number): string {
  return `${role}-${serviceId}`;
}

export function EmployeeServiceRates() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editValidFrom, setEditValidFrom] = useState("");
  const [expandedServiceId, setExpandedServiceId] = useState<number | null>(null);
  const [pendingReplace, setPendingReplace] = useState<PendingReplaceState | null>(null);
  const [pendingClosed, setPendingClosed] = useState<PendingClosed | null>(null);

  const { data: services, isLoading: loadingServices } = useQuery<ServiceData[]>({
    queryKey: ["services"],
    queryFn: async () => unwrapResult(await api.get<ServiceData[]>("/services")),
    staleTime: 60000,
  });

  const { data: activeRates, isLoading: loadingRates } = useQuery<WageRateRow[]>({
    queryKey: ["role-wage-rates"],
    queryFn: async () => unwrapResult(await api.get<WageRateRow[]>("/services/role-wage-rates")),
    staleTime: 30000,
  });

  const { data: futureRates } = useQuery<WageRateRow[]>({
    queryKey: ["role-wage-rates-future"],
    queryFn: async () => unwrapResult(await api.get<WageRateRow[]>("/services/role-wage-rates/future")),
    staleTime: 30000,
  });

  const { data: allRates } = useQuery<WageRateRow[]>({
    queryKey: ["role-wage-rates-all"],
    queryFn: async () => unwrapResult(await api.get<WageRateRow[]>("/services/role-wage-rates/all")),
    staleTime: 30000,
    enabled: expandedServiceId !== null,
  });

  const saveMutation = useMutation({
    mutationFn: async (vars: SaveVariables) => {
      const body: Record<string, unknown> = { role: vars.role, serviceId: vars.serviceId, cents: vars.cents };
      if (vars.validFrom) body.validFrom = vars.validFrom;
      if (vars.confirmReplace) body.confirmReplace = true;
      if (vars.confirmClosedOverride) body.confirmClosedOverride = true;
      return unwrapResult(await api.post("/services/role-wage-rates", body));
    },
    onSuccess: (_data, vars) => {
      invalidateRelated(queryClient, "role-wage-rates");
      setEditingCell(null);
      setEditValue("");
      setEditValidFrom("");
      setPendingReplace(null);
      setPendingClosed(null);
      toast({ title: vars.confirmReplace ? "Bestehender Lohnsatz ersetzt" : "Lohnsatz gespeichert" });
    },
    onError: (error: Error, vars) => {
      if (error instanceof ApiError && error.code === "WAGE_CONFLICT" && !vars.confirmReplace) {
        const existing = error.details?.existing as PendingReplaceState["existing"] | undefined;
        if (existing) {
          setPendingReplace({
            role: vars.role,
            serviceId: vars.serviceId,
            cents: vars.cents,
            validFrom: vars.validFrom,
            existing,
          });
          return;
        }
      }
      if (error instanceof ApiError && error.code === "CLOSED_WAGE_PERIOD_AFFECTED" && !vars.confirmClosedOverride) {
        const months = (error.details?.months as AffectedMonth[] | undefined) || [];
        setPendingClosed({ kind: "save", vars, months });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (vars: DeleteVariables) => {
      const url = vars.confirmClosedOverride
        ? `/services/role-wage-rates/${vars.rateId}?confirmClosedOverride=true`
        : `/services/role-wage-rates/${vars.rateId}`;
      return unwrapResult(await api.delete(url));
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "role-wage-rates");
      setPendingClosed(null);
      toast({ title: "Lohnsatz-Phase entfernt" });
    },
    onError: (error: Error, vars) => {
      if (error instanceof ApiError && error.code === "CLOSED_WAGE_PERIOD_AFFECTED" && !vars.confirmClosedOverride) {
        const months = (error.details?.months as AffectedMonth[] | undefined) || [];
        setPendingClosed({ kind: "delete", vars, months });
        return;
      }
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  function startEdit(role: WageRole, serviceId: number, currentCents: number) {
    setEditingCell(cellKey(role, serviceId));
    setEditValue(formatEuroDE(currentCents, { withCurrency: false }));
    setEditValidFrom("");
  }

  function cancelEdit() {
    setEditingCell(null);
    setEditValue("");
    setEditValidFrom("");
  }

  function handleSave(role: WageRole, serviceId: number) {
    const cents = parseEuroDE(editValue);
    if (cents === null || cents < 0) {
      toast({ title: "Ungültiger Betrag", variant: "destructive" });
      return;
    }
    saveMutation.mutate({ role, serviceId, cents, validFrom: editValidFrom || undefined });
  }

  function confirmClosed() {
    if (!pendingClosed) return;
    if (pendingClosed.kind === "save") {
      saveMutation.mutate({ ...pendingClosed.vars, confirmClosedOverride: true });
    } else {
      deleteMutation.mutate({ ...pendingClosed.vars, confirmClosedOverride: true });
    }
  }

  const isLoading = loadingServices || loadingRates;
  const activeServices = services?.filter(s => s.isActive) || [];

  const activeByCell = new Map<string, WageRateRow>();
  activeRates?.forEach(r => activeByCell.set(cellKey(r.role, r.serviceId), r));

  const futureByCell = new Map<string, WageRateRow[]>();
  futureRates?.forEach(r => {
    const k = cellKey(r.role, r.serviceId);
    const list = futureByCell.get(k) || [];
    list.push(r);
    futureByCell.set(k, list);
  });

  const hasFuture = (futureRates?.length || 0) > 0;

  return (
    <div className="mt-6 pt-6 border-t">
      <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
        <Euro className={iconSize.sm} />
        Rollenbasierte Vergütung (firmenweit je Rolle × Leistung)
      </h3>

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : activeServices.length === 0 ? (
        <p className="text-sm text-gray-500 py-4 text-center" data-testid="text-no-wage-services">
          Keine aktiven Dienstleistungen im Katalog
        </p>
      ) : (
        <div className="space-y-2" data-testid="wage-matrix">
          {hasFuture && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
              <p className="text-xs text-blue-700">
                <Calendar className="inline h-3 w-3 mr-1" />
                Geplante Lohnänderungen vorhanden.
              </p>
            </div>
          )}

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium text-gray-500">Dienstleistung</th>
                  {WAGE_ROLES.map(role => (
                    <th key={role} className="text-right px-2 py-1.5 font-medium text-gray-500 w-32">
                      {ROLE_LABELS[role]}
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {activeServices.map(service => {
                  const unitLabel = UNIT_LABELS[service.unitType] || "";
                  const isExpanded = expandedServiceId === service.id;
                  return (
                    <tr key={service.id} className="border-t align-top" data-testid={`row-wage-${service.id}`}>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{service.name}</span>
                          {service.code && <span className="text-xs text-gray-400">({service.code})</span>}
                        </div>
                        <button
                          type="button"
                          className="text-[11px] text-gray-500 hover:text-gray-700 flex items-center gap-1 mt-0.5"
                          onClick={() => setExpandedServiceId(isExpanded ? null : service.id)}
                          data-testid={`button-toggle-history-${service.id}`}
                        >
                          {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          Historie {isExpanded ? "ausblenden" : "anzeigen"}
                        </button>
                      </td>
                      {WAGE_ROLES.map(role => {
                        const key = cellKey(role, service.id);
                        const activeRate = activeByCell.get(key);
                        const isEditing = editingCell === key;
                        const cellFuture = futureByCell.get(key) || [];
                        return (
                          <td key={role} className="px-2 py-2 text-right w-32">
                            {isEditing ? (
                              <div className="flex flex-col items-end gap-1">
                                <div className="flex items-center gap-1">
                                  <Input
                                    type="text"
                                    value={editValue}
                                    onChange={e => setEditValue(e.target.value)}
                                    className="h-7 text-sm text-right w-20"
                                    autoFocus
                                    placeholder="0,00"
                                    onKeyDown={e => {
                                      if (e.key === "Enter") handleSave(role, service.id);
                                      if (e.key === "Escape") cancelEdit();
                                    }}
                                    data-testid={`input-wage-${role}-${service.id}`}
                                  />
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    onClick={() => handleSave(role, service.id)}
                                    disabled={saveMutation.isPending}
                                    data-testid={`button-save-wage-${role}-${service.id}`}
                                  >
                                    <Check className="h-3.5 w-3.5 text-green-600" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    onClick={cancelEdit}
                                    data-testid={`button-cancel-wage-${role}-${service.id}`}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                                <Input
                                  type="date"
                                  value={editValidFrom}
                                  onChange={e => setEditValidFrom(e.target.value)}
                                  className="h-7 text-xs w-32"
                                  data-testid={`input-valid-from-${role}-${service.id}`}
                                />
                              </div>
                            ) : (
                              <div className="flex items-center justify-end gap-1">
                                <div className="flex flex-col items-end">
                                  {activeRate ? (
                                    <>
                                      <span className="font-semibold text-teal-700" data-testid={`text-wage-${role}-${service.id}`}>
                                        {formatCurrency(activeRate.cents)}{unitLabel}
                                      </span>
                                      <span className="text-[10px] text-gray-400">ab {formatDateDisplay(activeRate.validFrom)}</span>
                                    </>
                                  ) : (
                                    <span className="text-gray-400 text-xs" data-testid={`text-wage-${role}-${service.id}`}>
                                      Standard: {formatCurrency(service.employeeRateCents)}{unitLabel}
                                    </span>
                                  )}
                                  {cellFuture.map(fr => (
                                    <span
                                      key={fr.id}
                                      className="text-[10px] text-blue-600 flex items-center gap-0.5"
                                      data-testid={`text-future-wage-${fr.id}`}
                                    >
                                      <Calendar className="h-2.5 w-2.5" />
                                      ab {formatDateDisplay(fr.validFrom)}: {formatCurrency(fr.cents)}
                                    </span>
                                  ))}
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => startEdit(role, service.id, activeRate ? activeRate.cents : service.employeeRateCents)}
                                  data-testid={`button-edit-wage-${role}-${service.id}`}
                                >
                                  <Pencil className="h-3.5 w-3.5 text-gray-500" />
                                </Button>
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {expandedServiceId !== null && (() => {
            const svc = activeServices.find(s => s.id === expandedServiceId);
            const phases = (allRates || [])
              .filter(r => r.serviceId === expandedServiceId)
              .concat((futureRates || []).filter(r => r.serviceId === expandedServiceId && !(allRates || []).some(a => a.id === r.id)));
            const todayISO = getTodayISO();
            return (
              <div className="border rounded-lg overflow-hidden" data-testid={`history-${expandedServiceId}`}>
                <div className="bg-gray-50 px-2 py-1.5 text-xs font-medium text-gray-600">
                  Historie & geplante Phasen: {svc?.name}
                </div>
                {phases.length === 0 ? (
                  <p className="text-xs text-gray-500 text-center py-2">Keine Phasen vorhanden (es gilt der Katalog-Standard).</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-500">Rolle</th>
                        <th className="text-right px-2 py-1.5 font-medium text-gray-500">Satz</th>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-500">Gültig ab</th>
                        <th className="text-left px-2 py-1.5 font-medium text-gray-500">Gültig bis</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {phases.map(p => {
                        const isEnded = p.validTo != null && p.validTo.slice(0, 10) < todayISO;
                        const deletable = !isEnded;
                        return (
                          <tr key={p.id} className={`border-t ${!p.validTo ? "bg-teal-50/50" : ""}`} data-testid={`history-row-${p.id}`}>
                            <td className="px-2 py-1.5">{ROLE_LABELS[p.role]}</td>
                            <td className="px-2 py-1.5 text-right font-medium" data-testid={`text-history-wage-${p.id}`}>
                              {formatCurrency(p.cents)}{UNIT_LABELS[p.unitType] || ""}
                            </td>
                            <td className="px-2 py-1.5" data-testid={`text-history-valid-from-${p.id}`}>{formatDateDisplay(p.validFrom)}</td>
                            <td className="px-2 py-1.5" data-testid={`text-history-valid-to-${p.id}`}>{p.validTo ? formatDateDisplay(p.validTo) : "—"}</td>
                            <td className="px-1 py-1.5">
                              {deletable && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0"
                                  onClick={() => deleteMutation.mutate({ rateId: p.id })}
                                  disabled={deleteMutation.isPending}
                                  data-testid={`button-delete-wage-${p.id}`}
                                >
                                  <X className="h-3 w-3 text-gray-400 hover:text-red-500" />
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })()}

          <p className="text-[11px] text-gray-500">
            Lohnsätze gelten firmenweit je Rolle und Leistung. Klicken Sie auf den Stift, um einen Satz zu setzen;
            über das Datumsfeld legen Sie einen „gültig ab"-Stichtag fest (frühestens heute). Fehlt ein Rollen-Satz,
            gilt der Katalog-Standard. Änderungen werden als neue Korrekturphase angelegt — bestehende Historieneinträge
            bleiben revisionssicher (GoBD).
          </p>
        </div>
      )}

      <AlertDialog open={!!pendingReplace} onOpenChange={open => { if (!open) setPendingReplace(null); }}>
        <AlertDialogContent data-testid="dialog-replace-wage">
          <AlertDialogHeader>
            <AlertDialogTitle>Bestehenden Lohnsatz ersetzen?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {pendingReplace ? (
                  <>
                    <p>
                      Für <span className="font-medium">{ROLE_LABELS[pendingReplace.existing.role]} · {pendingReplace.existing.serviceName}</span>{" "}
                      existiert bereits ein aktiver Lohnsatz ab dem{" "}
                      <span className="font-medium">{formatDateDisplay(pendingReplace.existing.validFrom)}</span>:
                    </p>
                    <div className="rounded-md border bg-gray-50 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-600">Bisheriger Satz</span>
                        <span className="font-semibold" data-testid="text-existing-wage">{formatCurrency(pendingReplace.existing.cents)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-gray-600">Neuer Satz</span>
                        <span className="font-semibold text-amber-700" data-testid="text-new-wage">{formatCurrency(pendingReplace.cents)}</span>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">
                      Der bestehende Eintrag wird als ersetzt markiert. Die Aktion erscheint im Audit-Log.
                    </p>
                  </>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-replace">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-replace"
              onClick={() => {
                if (!pendingReplace) return;
                saveMutation.mutate({
                  role: pendingReplace.role,
                  serviceId: pendingReplace.serviceId,
                  cents: pendingReplace.cents,
                  validFrom: pendingReplace.validFrom,
                  confirmReplace: true,
                });
              }}
            >
              Ja, ersetzen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingClosed !== null} onOpenChange={open => { if (!open) setPendingClosed(null); }}>
        <AlertDialogContent data-testid="dialog-confirm-closed-period">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Bereits abgeschlossene Lohn-Monate betroffen
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Diese Lohnänderung betrifft bereits abgeschlossene Lohn-Monate. Eine Änderung kann sich auf
                  bereits abgerechnete Mitarbeiter-Vergütungen auswirken.
                </p>
                {pendingClosed && pendingClosed.months.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded p-2">
                    <p className="font-medium mb-1">Betroffene Monate:</p>
                    <ul className="space-y-0.5">
                      {pendingClosed.months.slice(0, 12).map(m => (
                        <li key={`${m.year}-${m.month}`} className="text-xs" data-testid={`affected-month-${m.year}-${m.month}`}>
                          {MONTH_LABELS[m.month - 1]} {m.year} ({m.employeeCount} Mitarbeiter)
                        </li>
                      ))}
                      {pendingClosed.months.length > 12 && (
                        <li className="text-xs text-gray-500">… und {pendingClosed.months.length - 12} weitere</li>
                      )}
                    </ul>
                  </div>
                )}
                <p className="text-xs text-gray-600">
                  Bitte bestätigen Sie nur, wenn Sie sicher sind. Die Aktion wird im Audit-Log dokumentiert.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-closed-override">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmClosed}
              className="bg-amber-600 hover:bg-amber-700"
              data-testid="button-confirm-closed-override"
            >
              Trotzdem fortfahren
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
