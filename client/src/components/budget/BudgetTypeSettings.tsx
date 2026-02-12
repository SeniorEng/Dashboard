import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ArrowUp, ArrowDown, Save, Plus, History, ChevronDown, ChevronUp } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BUDGET_TYPE_LABELS, type BudgetType, BUDGET_45B_MAX_MONTHLY_CENTS, BUDGET_39_42A_MAX_YEARLY_CENTS, BUDGET_45A_MAX_BY_PFLEGEGRAD } from "@shared/domain/budgets";
import { api, unwrapResult } from "@/lib/api/client";
import { formatCurrency } from "@shared/utils/format";

interface BudgetTypeSetting {
  id: number | null;
  customerId: number;
  budgetType: string;
  enabled: boolean;
  priority: number;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
  initialBalanceCents: number | null;
  initialBalanceMonth: string | null;
}

interface InitialBalanceAllocation {
  id: number;
  amountCents: number;
  validFrom: string;
  notes: string | null;
  createdAt: string;
}

interface BudgetTypeSettingsProps {
  customerId: number;
  pflegegrad?: number;
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

export function BudgetTypeSettings({ customerId, pflegegrad }: BudgetTypeSettingsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<BudgetTypeSetting[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
  const [newBalances, setNewBalances] = useState<Record<string, { amount: string; month: string }>>({});

  const { data, isLoading } = useQuery<BudgetTypeSetting[]>({
    queryKey: ["budget-type-settings", customerId],
    queryFn: async () => {
      const response = await fetch(`/api/budget/${customerId}/type-settings`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Laden fehlgeschlagen");
      return response.json();
    },
    staleTime: 60000,
  });

  useEffect(() => {
    if (data) {
      setSettings([...data].sort((a, b) => a.priority - b.priority));
      setHasChanges(false);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (newSettings: BudgetTypeSetting[]) => {
      const settingsPayload = newSettings.map(s => {
        const newBal = newBalances[s.budgetType];
        const hasNewBalance = newBal && newBal.amount && parseFloat(newBal.amount) > 0;
        return {
          budgetType: s.budgetType,
          enabled: s.enabled,
          priority: s.priority,
          monthlyLimitCents: s.monthlyLimitCents,
          yearlyLimitCents: s.yearlyLimitCents,
          initialBalanceCents: hasNewBalance ? Math.round(parseFloat(newBal.amount) * 100) : null,
          initialBalanceMonth: hasNewBalance ? newBal.month : null,
        };
      });
      return unwrapResult(await api.put(`/budget/${customerId}/type-settings`, {
        settings: settingsPayload,
      }));
    },
    onSuccess: () => {
      toast({ title: "Budget-Einstellungen gespeichert" });
      queryClient.invalidateQueries({ queryKey: ["budget-type-settings", customerId] });
      queryClient.invalidateQueries({ queryKey: ["initial-balances", customerId] });
      queryClient.invalidateQueries({ queryKey: ["budget-summary", customerId] });
      setHasChanges(false);
      setNewBalances({});
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const movePriority = (index: number, direction: "up" | "down") => {
    const newSettings = [...settings];
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= newSettings.length) return;

    const tempPriority = newSettings[index].priority;
    newSettings[index] = { ...newSettings[index], priority: newSettings[swapIndex].priority };
    newSettings[swapIndex] = { ...newSettings[swapIndex], priority: tempPriority };

    newSettings.sort((a, b) => a.priority - b.priority);
    setSettings(newSettings);
    setHasChanges(true);
  };

  const toggleEnabled = (index: number) => {
    const newSettings = [...settings];
    newSettings[index] = { ...newSettings[index], enabled: !newSettings[index].enabled };
    setSettings(newSettings);
    setHasChanges(true);
  };

  const updateCentsField = (index: number, field: "monthlyLimitCents" | "yearlyLimitCents", value: string) => {
    const parsed = parseFloat(value);
    const cents = value === "" ? null : (isNaN(parsed) ? null : Math.round(parsed * 100));
    const newSettings = [...settings];
    newSettings[index] = { ...newSettings[index], [field]: cents };
    setSettings(newSettings);
    setHasChanges(true);
  };

  const updateNewBalance = (budgetType: string, field: "amount" | "month", value: string) => {
    setNewBalances(prev => ({
      ...prev,
      [budgetType]: {
        amount: field === "amount" ? value : (prev[budgetType]?.amount || ""),
        month: field === "month" ? value : (prev[budgetType]?.month || getCurrentYearMonth()),
      },
    }));
    setHasChanges(true);
  };

  const isMonthlyBudget = (budgetType: string) =>
    budgetType === "entlastungsbetrag_45b" || budgetType === "umwandlung_45a";

  const isYearlyBudget = (budgetType: string) =>
    budgetType === "ersatzpflege_39_42a";

  const centsToEuro = (cents: number | null) =>
    cents !== null ? (cents / 100).toFixed(2) : "";

  const getMaxPlaceholder = (budgetType: string) => {
    if (budgetType === "entlastungsbetrag_45b") {
      return `Max. ${(BUDGET_45B_MAX_MONTHLY_CENTS / 100).toFixed(0)} €/Monat`;
    }
    if (budgetType === "umwandlung_45a" && pflegegrad) {
      const maxCents = BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? 0;
      return maxCents > 0 ? `Max. ${(maxCents / 100).toFixed(0)} €/Monat (PG ${pflegegrad})` : "Voller Betrag";
    }
    if (budgetType === "ersatzpflege_39_42a") {
      return `Max. ${(BUDGET_39_42A_MAX_YEARLY_CENTS / 100).toFixed(0)} €/Jahr`;
    }
    return "Voller Betrag";
  };

  const toggleHistory = (budgetType: string) => {
    setExpandedHistory(prev => ({ ...prev, [budgetType]: !prev[budgetType] }));
  };

  if (isLoading) {
    return <div className="text-sm text-gray-500">Laden...</div>;
  }

  return (
    <div className="space-y-4" data-testid="budget-type-settings">
      <p className="text-sm text-gray-600">
        Legen Sie fest, welche Budget-Töpfe für diesen Kunden genutzt werden und in welcher Reihenfolge abgerechnet wird.
      </p>

      <div className="space-y-3">
        {settings.map((setting, index) => {
          const label = BUDGET_TYPE_LABELS[setting.budgetType as BudgetType] || setting.budgetType;
          const newBal = newBalances[setting.budgetType];
          const hasNewBalanceInput = newBal && newBal.amount && parseFloat(newBal.amount) > 0;

          return (
            <div
              key={setting.budgetType}
              className={`p-3 rounded-lg border ${setting.enabled ? "bg-white border-gray-200" : "bg-gray-50 border-gray-100 opacity-60"}`}
              data-testid={`budget-type-setting-${setting.budgetType}`}
            >
              <div className="flex items-center gap-2">
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => movePriority(index, "up")}
                    disabled={index === 0}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded disabled:opacity-30 disabled:cursor-not-allowed"
                    data-testid={`btn-priority-up-${setting.budgetType}`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => movePriority(index, "down")}
                    disabled={index === settings.length - 1}
                    className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded disabled:opacity-30 disabled:cursor-not-allowed"
                    data-testid={`btn-priority-down-${setting.budgetType}`}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-medium leading-snug">
                      <span className="text-gray-500">{index + 1}.</span> {label}
                    </span>
                    <Switch
                      checked={setting.enabled}
                      onCheckedChange={() => toggleEnabled(index)}
                      className="shrink-0 mt-0.5"
                      data-testid={`switch-enabled-${setting.budgetType}`}
                    />
                  </div>

                  {setting.enabled && (
                    <div className="mt-3 space-y-3">
                      {isMonthlyBudget(setting.budgetType) && (
                        <div>
                          <Label className="text-xs text-gray-500">Unser Anteil (€/Monat)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder={getMaxPlaceholder(setting.budgetType)}
                            value={centsToEuro(setting.monthlyLimitCents)}
                            onChange={(e) => updateCentsField(index, "monthlyLimitCents", e.target.value)}
                            className="h-8 mt-1 text-base"
                            data-testid={`input-monthly-limit-${setting.budgetType}`}
                          />
                        </div>
                      )}

                      {isYearlyBudget(setting.budgetType) && (
                        <div>
                          <Label className="text-xs text-gray-500">Unser Anteil (€/Jahr)</Label>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder={getMaxPlaceholder(setting.budgetType)}
                            value={centsToEuro(setting.yearlyLimitCents)}
                            onChange={(e) => updateCentsField(index, "yearlyLimitCents", e.target.value)}
                            className="h-8 mt-1 text-base"
                            data-testid={`input-yearly-limit-${setting.budgetType}`}
                          />
                        </div>
                      )}

                      <div className="border-t border-gray-100 pt-3">
                        <InitialBalanceSection
                          customerId={customerId}
                          budgetType={setting.budgetType}
                          newBal={newBal}
                          hasNewBalanceInput={!!hasNewBalanceInput}
                          onUpdateBalance={updateNewBalance}
                          expanded={!!expandedHistory[setting.budgetType]}
                          onToggleHistory={() => toggleHistory(setting.budgetType)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
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
    </div>
  );
}

interface InitialBalanceSectionProps {
  customerId: number;
  budgetType: string;
  newBal: { amount: string; month: string } | undefined;
  hasNewBalanceInput: boolean;
  onUpdateBalance: (budgetType: string, field: "amount" | "month", value: string) => void;
  expanded: boolean;
  onToggleHistory: () => void;
}

function InitialBalanceSection({ customerId, budgetType, newBal, hasNewBalanceInput, onUpdateBalance, expanded, onToggleHistory }: InitialBalanceSectionProps) {
  const { data: allocations, isLoading } = useQuery<InitialBalanceAllocation[]>({
    queryKey: ["initial-balances", customerId, budgetType],
    queryFn: async () => {
      const response = await fetch(`/api/budget/${customerId}/initial-balances/${budgetType}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Laden fehlgeschlagen");
      return response.json();
    },
    staleTime: 30000,
  });

  const latestAllocation = allocations?.[0];
  const hasHistory = allocations && allocations.length > 0;

  return (
    <div>
      {latestAllocation && (
        <div className="flex items-center justify-between mb-3 py-1.5 px-2 rounded bg-teal-50 text-sm" data-testid={`text-current-balance-${budgetType}`}>
          <span className="text-gray-600">
            Aktueller Startwert (ab {formatMonthYear(latestAllocation.validFrom)})
          </span>
          <span className="font-semibold text-teal-700">{formatCurrency(latestAllocation.amountCents)}</span>
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-xs text-gray-500">
          {hasHistory ? "Neuen Startwert hinzufügen" : "Startwert festlegen"}
        </Label>
        <p className="text-[11px] text-gray-400 leading-tight">
          Restguthaben aus Vormonaten, z.B. von einem früheren Anbieter. Wird als einmalige Gutschrift zusätzlich zum laufenden Monatsbetrag verbucht.
        </p>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
          <div>
            <Label className="text-[11px] text-gray-400">Betrag (€)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="0,00"
              value={newBal?.amount || ""}
              onChange={(e) => onUpdateBalance(budgetType, "amount", e.target.value)}
              className="h-9 text-base"
              data-testid={`input-initial-balance-${budgetType}`}
            />
          </div>
          <div>
            <Label className="text-[11px] text-gray-400">Ab Monat</Label>
            <select
              value={(newBal?.month || getCurrentYearMonth()).split("-")[1]}
              onChange={(e) => {
                const year = (newBal?.month || getCurrentYearMonth()).split("-")[0];
                onUpdateBalance(budgetType, "month", `${year}-${e.target.value}`);
              }}
              className="h-9 text-sm border border-gray-200 rounded-md px-2"
              data-testid={`select-balance-month-${budgetType}`}
            >
              {MONTH_OPTIONS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-[11px] text-gray-400">Jahr</Label>
            <select
              value={(newBal?.month || getCurrentYearMonth()).split("-")[0]}
              onChange={(e) => {
                const month = (newBal?.month || getCurrentYearMonth()).split("-")[1];
                onUpdateBalance(budgetType, "month", `${e.target.value}-${month}`);
              }}
              className="h-9 text-sm border border-gray-200 rounded-md px-2 w-20"
              data-testid={`select-balance-year-${budgetType}`}
            >
              {[new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1].map(y => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        {hasNewBalanceInput && (
          <p className="text-xs text-teal-600 mt-1">
            <Plus className="h-3 w-3 inline" /> {formatCurrency(Math.round(parseFloat(newBal!.amount) * 100))} wird als Restguthaben ab {formatMonthYear(newBal!.month || getCurrentYearMonth())} gespeichert
          </p>
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
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  ab {formatMonthYear(alloc.validFrom)}
                </Badge>
                {alloc.notes && <span className="text-gray-400">{alloc.notes}</span>}
              </div>
              <span className="font-medium text-gray-700">{formatCurrency(alloc.amountCents)}</span>
            </div>
          ))}
        </div>
      )}

      {isLoading && <p className="text-xs text-gray-400 mt-2">Laden...</p>}
    </div>
  );
}
