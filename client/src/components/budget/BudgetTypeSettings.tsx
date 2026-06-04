import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ArrowUp, ArrowDown, Save, Plus, History, ChevronDown, ChevronUp, ChevronRight, Trash2, RefreshCw, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BUDGET_TYPE_LABELS, type BudgetType, BUDGET_45B_MAX_MONTHLY_CENTS, BUDGET_39_42A_MAX_YEARLY_CENTS, BUDGET_45A_MAX_BY_PFLEGEGRAD } from "@shared/domain/budgets";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { formatCurrency } from "@shared/utils/format";
import { formatEuroDE, parseEuroDE } from "@shared/utils/money";
import { todayISO } from "@shared/utils/datetime";
import { validate45bInitialBalanceNotPriorYear, max45bStartValueCents, resolve45bAccrualAnchor } from "@shared/domain/budget/carryover-eligibility";
// Task #608 / #716: Sentinel-Wert, mit dem der Historisierungs-Backfill alte
// Zeilen auf „rückwirkend gültig" markiert hat. Im UI als leeres Feld +
// Hinweistext rendern, statt buchstäblich „01.01.1970" anzuzeigen. Zentral
// in `shared/domain/budget-settings-sentinel.ts` — KEIN frei stehender
// `"1970-01-01"`-String hier (Architektur-Test).
import { SETTINGS_VALID_FROM_EPOCH } from "@shared/domain/budget-settings-sentinel";

interface BudgetTypeSetting {
  id: number | null;
  customerId: number;
  budgetType: string;
  enabled: boolean;
  priority: number;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
  validFrom: string | null;
  validTo: string | null;
  // Task #703 — Heute wirksamer Vorgänger bei nahtlosem Übergang. Wenn gesetzt,
  // gilt diese Latest-Intent-Zeile erst ab validFrom, der Topf ist heute aber
  // bereits aktiv (vorherige Zeile schließt mit validTo=heute).
  effectiveToday?: {
    validFrom: string | null;
    validTo: string | null;
    enabled: boolean;
    monthlyLimitCents: number | null;
    yearlyLimitCents: number | null;
  } | null;
}

interface InitialBalanceAllocation {
  id: number;
  amountCents: number;
  validFrom: string;
  notes: string | null;
  createdAt: string;
  // Task #608: Carryover-Allokationen (source='carryover') werden für §45b
  // in derselben Liste angezeigt wie manuelle Startwerte, damit der Übertrag
  // aus dem Vorjahr im UI sichtbar und löschbar ist.
  source?: string;
  expiresAt?: string | null;
  year?: number;
  month?: number | null;
}

interface CareLevelHistoryEntry {
  validFrom: string;
}

interface BudgetTypeSettingsProps {
  customerId: number;
  pflegegrad?: number;
  // Task #975 — Pflegegrad-Historie als Accrual-Anker für die §45b-Startwert-
  // Obergrenze (frühestes `validFrom`). Identisch zur Server-Logik in
  // `server/routes/budget.ts` (initial-balance-Handler).
  careLevelHistory?: CareLevelHistoryEntry[];
}

const MONTH_OPTIONS = [
  { value: "01", label: "Januar" },
  { value: "02", label: "Februar" },
  { value: "03", label: "März" },
  { value: "04", label: "April" },
  { value: "05", label: "Mai" },
  { value: "06", label: "Juni" },
  { value: "07", label: "Juli" },
  { value: "08", label: "August" },
  { value: "09", label: "September" },
  { value: "10", label: "Oktober" },
  { value: "11", label: "November" },
  { value: "12", label: "Dezember" },
];

function getCurrentYearMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function formatMonthYear(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length < 2) return dateStr;
  const monthLabel = MONTH_OPTIONS.find(m => m.value === parts[1])?.label || parts[1];
  return `${monthLabel} ${parts[0]}`;
}

// Task #608: Carryover-Ablaufdatum als DE-Datum (TT.MM.JJJJ) ausgeben.
function formatExpiryDE(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

// Task #441 — Re-Exports auf den zentralen Money-Helper.
// Keine eigene Parsing/Formatting-Logik mehr; alle Komponenten teilen
// `parseEuroDE` / `formatEuroDE` (mit `withCurrency: false` für reines
// Input-Feld-Format ohne "€"-Suffix).
function euroStringToCents(value: string): number | null {
  return parseEuroDE(value);
}

function centsToEuroString(cents: number | null): string {
  if (cents === null) return "";
  return formatEuroDE(cents, { withCurrency: false });
}

function isValidEuroInput(value: string): boolean {
  if (value === "") return true;
  return /^[0-9]+[.,]?[0-9]{0,2}$/.test(value);
}

export function BudgetTypeSettings({ customerId, pflegegrad, careLevelHistory }: BudgetTypeSettingsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<BudgetTypeSetting[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
  const [expandedInitialBalance, setExpandedInitialBalance] = useState<Record<string, boolean>>({});
  const [euroValues, setEuroValues] = useState<Record<string, { monthly: string; yearly: string }>>({});
  const [dateValues, setDateValues] = useState<Record<string, { validFrom: string; validTo: string }>>({});

  const { data, isLoading } = useQuery<BudgetTypeSetting[]>({
    queryKey: ["budget-type-settings", customerId],
    queryFn: async () => {
      const result = await api.get<BudgetTypeSetting[]>(`/budget/${customerId}/type-settings`);
      return unwrapResult(result);
    },
    staleTime: 60000,
  });

  useEffect(() => {
    if (data) {
      const sorted = [...data].sort((a, b) => a.priority - b.priority);
      setSettings(sorted);
      setHasChanges(false);
      const initEuro: Record<string, { monthly: string; yearly: string }> = {};
      const initDates: Record<string, { validFrom: string; validTo: string }> = {};
      sorted.forEach(s => {
        initEuro[s.budgetType] = {
          monthly: centsToEuroString(s.monthlyLimitCents),
          yearly: centsToEuroString(s.yearlyLimitCents),
        };
        initDates[s.budgetType] = {
          // Task #608: Epoch-Sentinel als leer rendern (Backfill-Marker).
          validFrom: s.validFrom && s.validFrom !== SETTINGS_VALID_FROM_EPOCH ? s.validFrom : "",
          validTo: s.validTo || "",
        };
      });
      setEuroValues(initEuro);
      setDateValues(initDates);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (newSettings: BudgetTypeSetting[]) => {
      const settingsPayload = newSettings.map(s => {
        const ev = euroValues[s.budgetType];
        const dv = dateValues[s.budgetType];
        return {
          budgetType: s.budgetType,
          enabled: s.enabled,
          priority: s.priority,
          monthlyLimitCents: euroStringToCents(ev?.monthly || ""),
          yearlyLimitCents: euroStringToCents(ev?.yearly || ""),
          validFrom: dv?.validFrom || null,
          validTo: dv?.validTo || null,
        };
      });
      return unwrapResult(await api.put(`/budget/${customerId}/type-settings`, {
        settings: settingsPayload,
      }));
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      // Task #703 — Nach dem Speichern muss `budget-type-settings` frisch geladen
      // werden, damit Form-Init (validFrom/limits) und Übergangs-Banner die
      // soeben angelegte Transition (alte Zeile validTo=heute, neue Zeile
      // validFrom=morgen) sehen.
      await queryClient.refetchQueries({ queryKey: ["budget-type-settings", customerId], type: "active" });
      invalidateRelated(queryClient, "budget", { customerId });
      toast({ title: "Budget-Einstellungen gespeichert" });
      setHasChanges(false);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const movePriority = (index: number, direction: "up" | "down") => {
    const newSettings = [...settings];
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= newSettings.length) return;

    [newSettings[index], newSettings[swapIndex]] = [newSettings[swapIndex], newSettings[index]];

    newSettings.forEach((s, i) => {
      newSettings[i] = { ...s, priority: i + 1 };
    });

    setSettings(newSettings);
    setHasChanges(true);
  };

  const toggleEnabled = (index: number) => {
    const newSettings = [...settings];
    newSettings[index] = { ...newSettings[index], enabled: !newSettings[index].enabled };
    setSettings(newSettings);
    setHasChanges(true);
  };

  const updateEuroValue = (budgetType: string, field: "monthly" | "yearly", value: string) => {
    if (!isValidEuroInput(value)) return;
    setEuroValues(prev => ({
      ...prev,
      [budgetType]: { ...prev[budgetType], [field]: value },
    }));
    setHasChanges(true);
  };

  // Task #603 — §45b zeigt wieder ein Monats-Eingabefeld ("Unser Anteil"),
  // das die monatliche Aufstockung des Jahrestopfs reduziert (KEIN harter Cap).
  const isMonthlyBudget = (budgetType: string) =>
    budgetType === "umwandlung_45a" || budgetType === "entlastungsbetrag_45b";

  const isYearlyBudget = (budgetType: string) =>
    budgetType === "ersatzpflege_39_42a";

  const formatMaxEuro = (cents: number) => formatEuroDE(cents).replace(/,00\s*€/, " €");

  const getMaxHint = (budgetType: string): string | null => {
    if (budgetType === "entlastungsbetrag_45b") {
      return `Gesetzl. Max: ${formatMaxEuro(BUDGET_45B_MAX_MONTHLY_CENTS)}/Monat`;
    }
    if (budgetType === "umwandlung_45a" && pflegegrad) {
      const maxCents = BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? 0;
      return maxCents > 0 ? `Gesetzl. Max: ${formatMaxEuro(maxCents)}/Monat (PG ${pflegegrad})` : null;
    }
    if (budgetType === "ersatzpflege_39_42a") {
      return `Gesetzl. Max: ${formatMaxEuro(BUDGET_39_42A_MAX_YEARLY_CENTS)}/Jahr`;
    }
    return null;
  };

  const toggleHistory = (budgetType: string) => {
    setExpandedHistory(prev => ({ ...prev, [budgetType]: !prev[budgetType] }));
  };

  const toggleInitialBalance = (budgetType: string) => {
    setExpandedInitialBalance(prev => ({ ...prev, [budgetType]: !prev[budgetType] }));
  };

  if (isLoading) {
    return <div className="text-sm text-gray-500">Laden...</div>;
  }

  return (
    <div className="space-y-2" data-testid="budget-type-settings">
      <div className="space-y-2">
        {settings.map((setting, index) => {
          const label = BUDGET_TYPE_LABELS[setting.budgetType as BudgetType] || setting.budgetType;

          return (
            <div
              key={setting.budgetType}
              className={`p-2 rounded-lg border ${setting.enabled ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-60"}`}
              data-testid={`budget-type-setting-${setting.budgetType}`}
            >
              <div className="flex items-center gap-1.5">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => movePriority(index, "up")}
                    disabled={index === 0}
                    className="p-1 flex items-center justify-center rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                    data-testid={`btn-priority-up-${setting.budgetType}`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => movePriority(index, "down")}
                    disabled={index === settings.length - 1}
                    className="p-1 flex items-center justify-center rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                    data-testid={`btn-priority-down-${setting.budgetType}`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </div>

                <span className="text-sm font-medium leading-snug flex-1 min-w-0">
                  <span className="text-gray-500">{index + 1}.</span> {label}
                </span>

                <Switch
                  checked={setting.enabled}
                  onCheckedChange={() => toggleEnabled(index)}
                  className="shrink-0"
                  data-testid={`switch-enabled-${setting.budgetType}`}
                />
              </div>

              {setting.enabled && (
                <div className="mt-2 ml-[52px] space-y-2">
                  {/* Task #703 — Nahtloser GoBD-Übergang: Latest-Intent-Zeile
                      gilt ab validFrom (zukunft), aber `effectiveToday` deckt
                      heute noch ab. Im Formular sehen Admins die Werte der
                      kommenden Zeile — der Hinweis macht klar, wann die
                      Änderung greift und was bis dahin gilt. */}
                  {setting.effectiveToday && setting.validFrom && setting.validFrom > todayISO() && (
                    <p className="text-[11px] text-gray-500" data-testid={`hint-pending-transition-${setting.budgetType}`}>
                      Letzte Änderung greift ab {setting.validFrom}. Bis dahin gilt:
                      {" "}{centsToEuroString(setting.effectiveToday.monthlyLimitCents) || centsToEuroString(setting.effectiveToday.yearlyLimitCents) || "—"}
                      {setting.effectiveToday.monthlyLimitCents != null ? " €/Monat" : setting.effectiveToday.yearlyLimitCents != null ? " €/Jahr" : ""}
                      .
                    </p>
                  )}
                  {isMonthlyBudget(setting.budgetType) && (
                    <div>
                      <Label className="text-xs text-gray-500">Unser Anteil (€/Monat)</Label>
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0,00"
                        value={euroValues[setting.budgetType]?.monthly || ""}
                        onChange={(e) => updateEuroValue(setting.budgetType, "monthly", e.target.value)}
                        className="h-8 mt-1 text-base"
                        data-testid={`input-monthly-limit-${setting.budgetType}`}
                      />
                      {getMaxHint(setting.budgetType) && (
                        <p className="text-[11px] text-gray-500 mt-0.5">{getMaxHint(setting.budgetType)}</p>
                      )}
                    </div>
                  )}

                  {isYearlyBudget(setting.budgetType) && (
                    <div>
                      <Label className="text-xs text-gray-500">Unser Anteil (€/Jahr)</Label>
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0,00"
                        value={euroValues[setting.budgetType]?.yearly || ""}
                        onChange={(e) => updateEuroValue(setting.budgetType, "yearly", e.target.value)}
                        className="h-8 mt-1 text-base"
                        data-testid={`input-yearly-limit-${setting.budgetType}`}
                      />
                      {getMaxHint(setting.budgetType) && (
                        <p className="text-[11px] text-gray-500 mt-0.5">{getMaxHint(setting.budgetType)}</p>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-gray-500">Gültig ab</Label>
                      <Input
                        type="date"
                        value={dateValues[setting.budgetType]?.validFrom || ""}
                        onChange={(e) => {
                          setDateValues(prev => ({
                            ...prev,
                            [setting.budgetType]: { ...prev[setting.budgetType], validFrom: e.target.value },
                          }));
                          setHasChanges(true);
                        }}
                        className="h-8 mt-1 text-sm"
                        data-testid={`input-valid-from-${setting.budgetType}`}
                      />
                      {/* Task #608: Hinweis für historische Zeilen, deren validFrom vom
                          Backfill auf den Unix-Epoch gesetzt wurde — der wörtliche
                          „01.01.1970"-Wert hat Nutzer verwirrt. */}
                      {setting.validFrom === SETTINGS_VALID_FROM_EPOCH && !dateValues[setting.budgetType]?.validFrom && (
                        <p className="text-[11px] text-gray-500 mt-0.5" data-testid={`hint-valid-from-since-setup-${setting.budgetType}`}>
                          seit Einrichtung (rückwirkend gültig)
                        </p>
                      )}
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500">Gültig bis</Label>
                      <Input
                        type="date"
                        value={dateValues[setting.budgetType]?.validTo || ""}
                        onChange={(e) => {
                          setDateValues(prev => ({
                            ...prev,
                            [setting.budgetType]: { ...prev[setting.budgetType], validTo: e.target.value },
                          }));
                          setHasChanges(true);
                        }}
                        className="h-8 mt-1 text-sm"
                        data-testid={`input-valid-to-${setting.budgetType}`}
                      />
                    </div>
                  </div>
                  {dateValues[setting.budgetType]?.validTo && dateValues[setting.budgetType].validTo < todayISO() && (
                    <p className="text-[11px] text-amber-600 mt-0.5">Dieser Topf ist abgelaufen</p>
                  )}

                  {setting.budgetType === "entlastungsbetrag_45b" && (
                    <>
                      <button
                        type="button"
                        onClick={() => toggleInitialBalance(setting.budgetType)}
                        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
                        data-testid={`btn-toggle-initial-balance-${setting.budgetType}`}
                      >
                        {expandedInitialBalance[setting.budgetType] ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        Startwert festlegen
                      </button>

                      {expandedInitialBalance[setting.budgetType] && (
                        <div className="border-t border-gray-100 pt-2 space-y-3">
                          {/* Task #670 — Restguthaben aus Vorjahr (Carryover, verfällt 30.06.) */}
                          <CarryoverSection
                            customerId={customerId}
                            budgetType={setting.budgetType}
                          />
                          <InitialBalanceSection
                            customerId={customerId}
                            budgetType={setting.budgetType}
                            careLevelHistory={careLevelHistory}
                            expanded={!!expandedHistory[setting.budgetType]}
                            onToggleHistory={() => toggleHistory(setting.budgetType)}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasChanges && (
        <Button
          onClick={() => saveMutation.mutate(settings)}
          disabled={saveMutation.isPending}
          className="w-full"
          data-testid="btn-save-budget-type-settings"
        >
          <Save className="h-4 w-4 mr-2" />
          {saveMutation.isPending ? "Wird gespeichert..." : "Einstellungen speichern"}
        </Button>
      )}

      {hasChanges ? (
        <p className="text-xs text-gray-500 text-center">Bitte erst Einstellungen speichern, um Umbuchungen vorzunehmen.</p>
      ) : (
        <RebookSection customerId={customerId} />
      )}
    </div>
  );
}

interface RebookPreview {
  disabledTypes: string[];
  affectedAppointments: number;
  totalAmountCents: number;
  transactions: Array<{ id: number; budgetType: string; amountCents: number; appointmentId: number | null; transactionDate: string }>;
}

interface RebookResult {
  reversedCount: number;
  rebookedCount: number;
  totalOldAmountCents: number;
  totalNewAmountCents: number;
  errors: Array<{ appointmentId: number; error: string }>;
}

function RebookSection({ customerId }: { customerId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);

  const { data: preview, isLoading: previewLoading, isError: previewError, refetch } = useQuery<RebookPreview>({
    queryKey: ["budget-rebook-preview", customerId],
    queryFn: async () => unwrapResult(await api.get<RebookPreview>(`/budget/${customerId}/rebook-preview`)),
    staleTime: 30000,
  });

  const rebookMutation = useMutation({
    mutationFn: async () => {
      return unwrapResult(await api.post<RebookResult>(`/budget/${customerId}/rebook`, {}));
    },
    onSuccess: async (result) => {
      await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      invalidateRelated(queryClient, "budget", { customerId });
      setShowDialog(false);
      if (result.errors.length > 0) {
        toast({
          variant: "destructive",
          title: `Umbuchung teilweise abgeschlossen`,
          description: `${result.rebookedCount} Termine umgebucht, ${result.errors.length} Fehler`,
        });
      } else {
        toast({
          title: "Umbuchung erfolgreich",
          description: `${result.rebookedCount} Termine umgebucht · ${formatCurrency(result.totalOldAmountCents)} → ${formatCurrency(result.totalNewAmountCents)}`,
        });
      }
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler bei Umbuchung", description: error.message });
    },
  });

  const hasRebookableTransactions = preview && preview.transactions.length > 0;

  if (previewLoading || !hasRebookableTransactions) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => { refetch(); setShowDialog(true); }}
        className="w-full text-xs"
        data-testid="btn-open-rebook-dialog"
      >
        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
        Buchungen auf aktive Töpfe umbuchen ({preview!.affectedAppointments} Termine)
      </Button>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Budget-Umbuchung
            </DialogTitle>
          </DialogHeader>

          {previewLoading ? (
            <div className="py-6 text-center text-sm text-gray-500">Vorschau wird geladen...</div>
          ) : previewError ? (
            <div className="py-6 text-center space-y-2">
              <p className="text-sm text-red-600">Vorschau konnte nicht geladen werden.</p>
              <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="btn-retry-rebook-preview">
                Erneut versuchen
              </Button>
            </div>
          ) : !hasRebookableTransactions ? (
            <div className="py-6 text-center text-sm text-gray-500">
              Keine Buchungen auf deaktivierten Töpfen gefunden. Es gibt nichts umzubuchen.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-amber-800">
                  <p className="font-medium mb-1">Folgende Buchungen werden umgebucht:</p>
                  <ul className="space-y-1 text-xs">
                    {preview!.disabledTypes.map(t => (
                      <li key={t}>
                        {BUDGET_TYPE_LABELS[t as BudgetType] || t}: {preview!.transactions.filter(tx => tx.budgetType === t).length} Buchungen
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500">Betroffene Termine</p>
                  <p className="text-lg font-bold text-gray-900" data-testid="text-rebook-appointments">{preview!.affectedAppointments}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500">Gesamtbetrag</p>
                  <p className="text-lg font-bold text-gray-900" data-testid="text-rebook-amount">{formatCurrency(preview!.totalAmountCents)}</p>
                </div>
              </div>

              <p className="text-xs text-gray-500">
                Alle Buchungen betroffener Termine werden komplett storniert und auf die aktiven Töpfe (nach Priorität) neu berechnet.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowDialog(false)}>
              Abbrechen
            </Button>
            {hasRebookableTransactions && (
              <Button
                size="sm"
                onClick={() => rebookMutation.mutate()}
                disabled={rebookMutation.isPending}
                data-testid="btn-confirm-rebook"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${rebookMutation.isPending ? "animate-spin" : ""}`} />
                {rebookMutation.isPending ? "Wird umgebucht..." : "Jetzt umbuchen"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface InitialBalanceSectionProps {
  customerId: number;
  budgetType: string;
  careLevelHistory?: CareLevelHistoryEntry[];
  expanded: boolean;
  onToggleHistory: () => void;
}

function InitialBalanceSection({ customerId, budgetType, careLevelHistory, expanded, onToggleHistory }: InitialBalanceSectionProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [month, setMonth] = useState(getCurrentYearMonth());
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const { data: allAllocations, isLoading } = useQuery<InitialBalanceAllocation[]>({
    queryKey: ["initial-balances", customerId, budgetType],
    queryFn: async () => {
      const result = await api.get<InitialBalanceAllocation[]>(`/budget/${customerId}/initial-balances/${budgetType}`);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });

  // Task #670 — Startwert-Sektion zeigt NUR `initial_balance`. Carryover wird
  // separat in `CarryoverSection` gerendert, damit die beiden fachlich
  // unterschiedlichen Töpfe ("läuft nicht ab" vs. "verfällt 30.06.") in der
  // UI nicht mehr vermischt werden.
  const allocations = allAllocations?.filter(a => a.source !== "carryover");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const amountCents = euroStringToCents(amount);
      if (!amountCents || amountCents <= 0) throw new Error("Bitte einen gültigen Betrag eingeben");
      // Task #964 — Prior-Year-§45b-Startwert ist ein Übertrag; Server lehnt ihn
      // ebenfalls ab. Hier früh blocken, damit die Fehlermeldung sofort erscheint.
      const guardError = budgetType === "entlastungsbetrag_45b"
        ? validate45bInitialBalanceNotPriorYear(month, new Date().getFullYear())
        : null;
      if (guardError) throw new Error(guardError);
      // Task #975 — §45b-Startwert-Obergrenze (gleiche SSoT wie Server,
      // `max45bStartValueCents`). Vor dem Round-Trip blocken, damit der Admin
      // nicht erst eine 400-Antwort erhält.
      if (budgetType === "entlastungsbetrag_45b" && start45bCap !== null && amountCents > start45bCap) {
        throw new Error(`§45b-Startguthaben darf höchstens ${formatCurrency(start45bCap)} betragen (rechtlich mögliche Ansammlung bis zum Startmonat).`);
      }
      return unwrapResult(await api.post(`/budget/${customerId}/initial-balance/${budgetType}`, {
        amountCents,
        validFrom: month,
      }));
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      invalidateRelated(queryClient, "budget", { customerId });
      toast({ title: "Startwert gespeichert" });
      setAmount("");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (allocationId: number) => {
      return unwrapResult(await api.delete(`/budget/${customerId}/initial-balance/${allocationId}`));
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      invalidateRelated(queryClient, "budget", { customerId });
      toast({ title: "Startwert gelöscht" });
      setDeleteConfirmId(null);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const latestAllocation = allocations?.[0];
  const hasHistory = !!allocations && allocations.length > 0;
  const hasValidInput = amount && (euroStringToCents(amount) ?? 0) > 0;

  const selectedYear = parseInt(month.split("-")[0]);
  const selectedMonthNum = parseInt(month.split("-")[1]);
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const showMidYearWarning = selectedMonthNum > 1;

  // Task #964 — §45b-Startwerte dürfen NUR im laufenden Jahr liegen. Ein
  // Stichmonat aus einem früheren Jahr ist rechtlich ein Übertrag aus dem
  // Vorjahr (verfällt 30.06.) und gehört in die `CarryoverSection`. Daher
  // bietet die Jahr-Auswahl für §45b nur das laufende Jahr an, und ein
  // Server-konsistenter Guard blockt das Speichern, falls doch ein Vorjahr
  // im State landet. (§45a/§39 nutzen diese Sektion nicht.)
  const is45b = budgetType === "entlastungsbetrag_45b";
  const priorYearError = is45b
    ? validate45bInitialBalanceNotPriorYear(month, currentYear)
    : null;
  const yearOptions = is45b
    ? [currentYear]
    : Array.from({ length: 5 }, (_, i) => currentYear - i);

  // Task #975 — §45b-Startwert-Obergrenze sichtbar machen, BEVOR gespeichert wird.
  // Identisch zur Server-Berechnung (`max45bStartValueCents`,
  // `server/routes/budget.ts`): Accrual-Anker = FRÜHESTES `validFrom` der
  // Pflegegrad-Historie (Fallback = der erfasste Startmonat selbst), Stichmonat =
  // `${month}-01`. Nur für §45b — §45a/§39 bleiben uncapped. Task #981: Der Anker
  // wird über die gemeinsame, reihenfolge-unabhängige SSoT `resolve45bAccrualAnchor`
  // abgeleitet (kein eigener Sortier-Ausdruck mehr).
  const validFromDate = `${month}-01`;
  const accrualAnchor = resolve45bAccrualAnchor(careLevelHistory ?? [], validFromDate);
  const start45bCap = is45b ? max45bStartValueCents(accrualAnchor, validFromDate) : null;
  const enteredCents = euroStringToCents(amount) ?? 0;
  const exceedsCap = start45bCap !== null && hasValidInput && enteredCents > start45bCap;

  const filteredMonths = MONTH_OPTIONS.filter(m => {
    if (selectedYear < currentYear) return true;
    if (selectedYear === currentYear) return parseInt(m.value) <= currentMonth;
    return false;
  });

  return (
    <div>
      {latestAllocation && (
        <div
          className={`flex items-center justify-between mb-2 py-1 px-2 rounded text-sm ${
            latestAllocation.source === "carryover" ? "bg-amber-50" : "bg-teal-50"
          }`}
          data-testid={`text-current-balance-${budgetType}`}
        >
          <span className="text-gray-600 flex items-center gap-1.5">
            {latestAllocation.source === "carryover" ? (
              <>
                <StatusBadge type="info" value="Übertrag" size="sm" />
                <span>aus Vorjahr{latestAllocation.expiresAt ? ` (gültig bis ${formatExpiryDE(latestAllocation.expiresAt)})` : ""}</span>
              </>
            ) : (
              <>Startwert (ab {formatMonthYear(latestAllocation.validFrom)})</>
            )}
          </span>
          <div className="flex items-center gap-2">
            <span className={`font-semibold ${latestAllocation.source === "carryover" ? "text-amber-700" : "text-teal-700"}`}>{formatCurrency(latestAllocation.amountCents)}</span>
            {deleteConfirmId === latestAllocation.id ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate(latestAllocation.id)}
                  className="text-[10px] px-1.5 py-0.5 bg-red-500 text-white rounded hover:bg-red-600"
                  data-testid={`btn-confirm-delete-${budgetType}`}
                >
                  Löschen
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirmId(null)}
                  className="text-[10px] px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded hover:bg-gray-300"
                >
                  Abbrechen
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDeleteConfirmId(latestAllocation.id)}
                className="p-0.5 text-gray-500 hover:text-red-500 rounded"
                title="Startwert löschen"
                data-testid={`btn-delete-balance-${budgetType}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-xs text-gray-500">
          {hasHistory ? "Startwert anpassen" : "Startwert festlegen"}
        </Label>
        <div className="space-y-2">
          <div>
            <Label className="text-[11px] text-gray-500">Restguthaben (€)</Label>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => {
                if (isValidEuroInput(e.target.value)) setAmount(e.target.value);
              }}
              className={`h-8 text-base ${exceedsCap ? "border-red-400 focus-visible:ring-red-400" : ""}`}
              data-testid={`input-initial-balance-${budgetType}`}
            />
            {is45b && start45bCap !== null && !priorYearError && (
              <p
                className={`text-[11px] mt-0.5 ${exceedsCap ? "text-red-600 font-medium" : "text-gray-500"}`}
                data-testid={`text-max-initial-balance-${budgetType}`}
              >
                Maximal {formatCurrency(start45bCap)} möglich (rechtlich mögliche Ansammlung bis {formatMonthYear(month)}).
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-gray-500">Ab Monat</Label>
              <select
                value={month.split("-")[1]}
                onChange={(e) => {
                  const yr = month.split("-")[0];
                  setMonth(`${yr}-${e.target.value}`);
                }}
                className="h-8 w-full text-sm border border-gray-200 rounded-md px-2"
                data-testid={`select-balance-month-${budgetType}`}
              >
                {filteredMonths.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-[11px] text-gray-500">Jahr</Label>
              <select
                value={month.split("-")[0]}
                onChange={(e) => {
                  const mo = month.split("-")[1];
                  const newYear = parseInt(e.target.value);
                  const maxMonth = newYear === currentYear ? String(currentMonth).padStart(2, "0") : "12";
                  const adjustedMonth = mo > maxMonth ? maxMonth : mo;
                  setMonth(`${e.target.value}-${adjustedMonth}`);
                }}
                className="h-8 w-full text-sm border border-gray-200 rounded-md px-2"
                data-testid={`select-balance-year-${budgetType}`}
              >
                {yearOptions.map(y => (
                  <option key={y} value={String(y)}>{y}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {hasValidInput && showMidYearWarning && (
          <div
            className="flex items-start gap-2 mt-1 p-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800"
            data-testid={`warning-mid-year-stichmonat-${budgetType}`}
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p>
                <strong>Hinweis:</strong> Startwert <strong>ab {formatMonthYear(month)}</strong> –
                frühere monatliche Allokationen aus den Vormonaten ({selectedYear}) bleiben bestehen.
              </p>
              <p>
                Der eingegebene Betrag gilt als Restguthaben ab dem Stichmonat. Bereits in den
                Vormonaten verbrauchtes Budget muss in diesem Wert berücksichtigt sein – sonst werden
                Buchungen aus den Vormonaten doppelt gezählt.
              </p>
              {hasHistory && allocations && allocations.length > 1 && (
                <button
                  type="button"
                  onClick={() => { if (!expanded) onToggleHistory(); }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-amber-900 underline hover:text-amber-700"
                  data-testid={`link-open-balance-history-${budgetType}`}
                >
                  <History className="h-3 w-3" />
                  Startwert-Historie ansehen ({allocations.length - 1} weitere {allocations.length - 1 === 1 ? "Eintrag" : "Einträge"})
                </button>
              )}
            </div>
          </div>
        )}

        {priorYearError && (
          <div
            className="flex items-start gap-2 mt-1 p-2 rounded bg-red-50 border border-red-200 text-xs text-red-700"
            data-testid={`error-prior-year-initial-balance-${budgetType}`}
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>{priorYearError}</p>
          </div>
        )}

        {exceedsCap && !priorYearError && start45bCap !== null && (
          <div
            className="flex items-start gap-2 mt-1 p-2 rounded bg-red-50 border border-red-200 text-xs text-red-700"
            data-testid={`error-exceeds-cap-initial-balance-${budgetType}`}
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>§45b-Startguthaben darf höchstens {formatCurrency(start45bCap)} betragen (rechtlich mögliche Ansammlung bis zum Startmonat).</p>
          </div>
        )}

        {hasValidInput && !priorYearError && !exceedsCap && (
          <div className="space-y-2 mt-1">
            <p className="text-xs text-teal-600">
              <Plus className="h-3 w-3 inline" /> {formatCurrency(euroStringToCents(amount) || 0)} wird als Restguthaben ab {formatMonthYear(month)} {hasHistory ? "aktualisiert" : "gespeichert"}
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="w-full h-7 text-xs"
              data-testid={`btn-save-initial-balance-${budgetType}`}
            >
              <Save className="h-3 w-3 mr-1" />
              {saveMutation.isPending ? "Wird gespeichert..." : (hasHistory ? "Startwert aktualisieren" : "Startwert speichern")}
            </Button>
          </div>
        )}
      </div>

      {hasHistory && allocations.length > 1 && (
        <button
          type="button"
          onClick={onToggleHistory}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mt-2"
          data-testid={`btn-toggle-history-${budgetType}`}
        >
          <History className="h-3 w-3" />
          {allocations.length - 1} weitere Einträge
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      )}

      {expanded && hasHistory && allocations.length > 1 && (
        <div className="mt-2 space-y-1" data-testid={`initial-balance-history-${budgetType}`}>
          {allocations.slice(1).map((alloc) => (
            <div key={alloc.id} className="flex items-center justify-between py-1.5 px-2 rounded bg-gray-50 text-xs">
              <div className="flex items-center gap-2">
                {alloc.source === "carryover" ? (
                  <>
                    <StatusBadge type="info" value="Übertrag" size="sm" />
                    <span className="text-gray-500">
                      aus Vorjahr{alloc.expiresAt ? ` (gültig bis ${formatExpiryDE(alloc.expiresAt)})` : ""}
                    </span>
                  </>
                ) : (
                  <StatusBadge type="info" value={`ab ${formatMonthYear(alloc.validFrom)}`} size="sm" />
                )}
                {alloc.notes && <span className="text-gray-500">{alloc.notes}</span>}
              </div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-700">{formatCurrency(alloc.amountCents)}</span>
                {deleteConfirmId === alloc.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(alloc.id)}
                      className="text-[10px] px-1.5 py-0.5 bg-red-500 text-white rounded hover:bg-red-600"
                    >
                      Löschen
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(null)}
                      className="text-[10px] px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded hover:bg-gray-300"
                    >
                      Nein
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmId(alloc.id)}
                    className="p-0.5 text-gray-500 hover:text-red-500 rounded"
                    title="Startwert löschen"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {isLoading && <p className="text-xs text-gray-500 mt-2">Laden...</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task #670 — Restguthaben aus Vorjahr (Carryover, verfällt 30.06.)
//
// Eigene Sektion, getrennt vom Startwert. Carryover ist nur für §45b relevant
// (SGB XI §45b Abs. 3: ungenutzte Beträge übertragen sich ins Folgehalbjahr
// und verfallen am 30.06.). Pro Kunde ein aktiver Eintrag pro Quelljahr —
// Server validiert das via Quelljahr-Dedup in `upsertCarryoverAllocation`.
// ---------------------------------------------------------------------------
interface CarryoverSectionProps {
  customerId: number;
  budgetType: string;
}

function CarryoverSection({ customerId, budgetType }: CarryoverSectionProps) {
  // Carryover ist gem. §45b SGB XI Abs. 3 nur für den Entlastungsbetrag
  // definiert. Der Parent rendert die Sektion bereits nur für §45b — der
  // Guard hier ist defensiv, MUSS aber vor allen Hooks stehen, damit die
  // React-Hook-Reihenfolge bei Fehl-Aufrufen stabil bleibt.
  const enabled = budgetType === "entlastungsbetrag_45b";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const currentYear = new Date().getFullYear();
  const [amount, setAmount] = useState("");
  const [sourceYear, setSourceYear] = useState<number>(currentYear - 1);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const { data: allAllocations, isLoading } = useQuery<InitialBalanceAllocation[]>({
    queryKey: ["initial-balances", customerId, budgetType],
    queryFn: async () => {
      const result = await api.get<InitialBalanceAllocation[]>(`/budget/${customerId}/initial-balances/${budgetType}`);
      return unwrapResult(result);
    },
    staleTime: 30000,
    enabled,
  });

  const carryovers = allAllocations?.filter(a => a.source === "carryover") ?? [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const amountCents = euroStringToCents(amount);
      if (!amountCents || amountCents <= 0) throw new Error("Bitte einen gültigen Betrag eingeben");
      return unwrapResult(await api.post(`/budget/${customerId}/carryover/${budgetType}`, {
        amountCents,
        sourceYear,
      }));
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      invalidateRelated(queryClient, "budget", { customerId });
      toast({ title: "Restguthaben aus Vorjahr gespeichert" });
      setAmount("");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const deleteMutation = useMutation({
    // Delete teilt sich den Initial-Balance-Endpoint — der Server akzeptiert
    // dort sowohl `initial_balance` als auch `carryover`-Allokationen.
    mutationFn: async (allocationId: number) => {
      return unwrapResult(await api.delete(`/budget/${customerId}/initial-balance/${allocationId}`));
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: ["budget-overview", customerId], type: "active" });
      invalidateRelated(queryClient, "budget", { customerId });
      toast({ title: "Restguthaben aus Vorjahr gelöscht" });
      setDeleteConfirmId(null);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  // Task #686: Sobald der Admin den Lösch-Bestätigungs-Modus für eine
  // Allokation öffnet, ziehen wir die Anzahl bereits verbuchter Termine vom
  // Server. Das vermeidet, dass eine Allokation, gegen die schon Termine
  // gebucht wurden, versehentlich entfernt wird (Reversal/Korrektur wird
  // komplizierter, weil der Auto-Pfad nach #684 nichts mehr regeneriert).
  const { data: deleteUsage, isLoading: deleteUsageLoading } = useQuery<{ appointmentCount: number }>({
    queryKey: ["initial-balance-usage", customerId, deleteConfirmId],
    queryFn: async () => unwrapResult(
      await api.get<{ appointmentCount: number }>(`/budget/${customerId}/initial-balance/${deleteConfirmId}/usage`),
    ),
    enabled: deleteConfirmId !== null,
    staleTime: 0,
  });

  const sourceYearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 1 - i);
  const hasValidInput = amount && (euroStringToCents(amount) ?? 0) > 0;
  const existsForSelectedYear = carryovers.some(c => (c.year ?? 0) - 1 === sourceYear);
  const targetYear = sourceYear + 1;

  if (!enabled) return null;

  return (
    <div data-testid={`carryover-section-${budgetType}`}>
      <Label className="text-xs text-gray-500 block mb-1">Restguthaben aus Vorjahr (verfällt 30.06.)</Label>

      {carryovers.length > 0 && (
        <div className="space-y-1 mb-2">
          {carryovers.map((c) => {
            const src = (c.year ?? 0) - 1;
            return (
              <div
                key={c.id}
                className="flex items-center justify-between py-1 px-2 rounded text-sm bg-amber-50"
                data-testid={`text-carryover-${budgetType}-${src}`}
              >
                <span className="text-gray-600 flex items-center gap-1.5">
                  <StatusBadge type="info" value="Übertrag" size="sm" />
                  <span>
                    aus {src}
                    {c.expiresAt ? ` (verfällt ${formatExpiryDE(c.expiresAt)})` : ""}
                  </span>
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-amber-700">{formatCurrency(c.amountCents)}</span>
                  {deleteConfirmId === c.id ? (
                    <div className="flex flex-col items-end gap-1">
                      {deleteUsageLoading ? (
                        <span
                          className="text-[10px] text-gray-500"
                          data-testid={`text-carryover-usage-loading-${budgetType}-${src}`}
                        >
                          Prüfe Buchungen…
                        </span>
                      ) : deleteUsage && deleteUsage.appointmentCount > 0 ? (
                        <span
                          className="text-[10px] text-amber-800 max-w-[260px] text-right"
                          data-testid={`text-carryover-usage-warning-${budgetType}-${src}`}
                        >
                          {deleteUsage.appointmentCount === 1
                            ? "Auf diesem Übertrag läuft bereits 1 verbuchter Termin — Löschen entfernt die Allokation aus dem Topf, die Buchung bleibt bestehen."
                            : `Auf diesem Übertrag laufen bereits ${deleteUsage.appointmentCount} verbuchte Termine — Löschen entfernt die Allokation aus dem Topf, die Buchungen bleiben bestehen.`}
                        </span>
                      ) : null}
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => deleteMutation.mutate(c.id)}
                          disabled={deleteUsageLoading || deleteMutation.isPending}
                          className="text-[10px] px-1.5 py-0.5 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50"
                          data-testid={`btn-confirm-delete-carryover-${budgetType}-${src}`}
                        >
                          {deleteUsage && deleteUsage.appointmentCount > 0 ? "Trotzdem löschen" : "Löschen"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmId(null)}
                          className="text-[10px] px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded hover:bg-gray-300"
                        >
                          Abbrechen
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(c.id)}
                      className="p-0.5 text-gray-500 hover:text-red-500 rounded"
                      title="Restguthaben aus Vorjahr löschen"
                      data-testid={`btn-delete-carryover-${budgetType}-${src}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[11px] text-gray-500">Restguthaben (€)</Label>
            <Input
              type="text"
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => {
                if (isValidEuroInput(e.target.value)) setAmount(e.target.value);
              }}
              className="h-8 text-base"
              data-testid={`input-carryover-amount-${budgetType}`}
            />
          </div>
          <div>
            <Label className="text-[11px] text-gray-500">Bezugsjahr</Label>
            <select
              value={sourceYear}
              onChange={(e) => setSourceYear(parseInt(e.target.value))}
              className="h-8 w-full text-sm border border-gray-200 rounded-md px-2"
              data-testid={`select-carryover-source-year-${budgetType}`}
            >
              {sourceYearOptions.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        {hasValidInput && existsForSelectedYear && (
          <div
            className="flex items-start gap-2 mt-1 p-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800"
            data-testid={`warning-carryover-overwrite-${budgetType}`}
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>Für Bezugsjahr {sourceYear} ist bereits ein Restguthaben hinterlegt. Beim Speichern wird der Wert aktualisiert.</span>
          </div>
        )}

        {hasValidInput && (
          <div className="space-y-2 mt-1">
            <p className="text-xs text-amber-700">
              <Plus className="h-3 w-3 inline" /> {formatCurrency(euroStringToCents(amount) || 0)} Übertrag aus {sourceYear} – gültig 01.01.{targetYear}, verfällt 30.06.{targetYear}
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="w-full h-7 text-xs"
              data-testid={`btn-save-carryover-${budgetType}`}
            >
              <Save className="h-3 w-3 mr-1" />
              {saveMutation.isPending ? "Wird gespeichert..." : (existsForSelectedYear ? "Restguthaben aktualisieren" : "Restguthaben speichern")}
            </Button>
          </div>
        )}
      </div>

      {isLoading && <p className="text-xs text-gray-500 mt-2">Laden...</p>}
    </div>
  );
}
