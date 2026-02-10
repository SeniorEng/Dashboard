import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowUp, ArrowDown, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BUDGET_TYPE_LABELS, type BudgetType } from "@shared/domain/budgets";
import { api, unwrapResult } from "@/lib/api/client";

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

interface BudgetTypeSettingsProps {
  customerId: number;
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

export function BudgetTypeSettings({ customerId }: BudgetTypeSettingsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<BudgetTypeSetting[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

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
      return unwrapResult(await api.put(`/budget/${customerId}/type-settings`, {
        settings: newSettings.map(s => ({
          budgetType: s.budgetType,
          enabled: s.enabled,
          priority: s.priority,
          monthlyLimitCents: s.monthlyLimitCents,
          yearlyLimitCents: s.yearlyLimitCents,
          initialBalanceCents: s.initialBalanceCents,
          initialBalanceMonth: s.initialBalanceMonth,
        })),
      }));
    },
    onSuccess: () => {
      toast({ title: "Budget-Einstellungen gespeichert" });
      queryClient.invalidateQueries({ queryKey: ["budget-type-settings", customerId] });
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

  const updateField = (index: number, field: keyof BudgetTypeSetting, value: any) => {
    const newSettings = [...settings];
    newSettings[index] = { ...newSettings[index], [field]: value };
    setSettings(newSettings);
    setHasChanges(true);
  };

  const updateCentsField = (index: number, field: "monthlyLimitCents" | "yearlyLimitCents" | "initialBalanceCents", value: string) => {
    const parsed = parseFloat(value);
    const cents = value === "" ? null : (isNaN(parsed) ? null : Math.round(parsed * 100));
    const newSettings = [...settings];
    newSettings[index] = { ...newSettings[index], [field]: cents };
    if (field === "initialBalanceCents") {
      if (cents !== null && cents > 0 && !newSettings[index].initialBalanceMonth) {
        newSettings[index] = { ...newSettings[index], initialBalanceMonth: getCurrentYearMonth() };
      }
      if (cents === null || cents === 0) {
        newSettings[index] = { ...newSettings[index], initialBalanceMonth: null };
      }
    }
    setSettings(newSettings);
    setHasChanges(true);
  };

  const isMonthlyBudget = (budgetType: string) =>
    budgetType === "entlastungsbetrag_45b" || budgetType === "umwandlung_45a";

  const isYearlyBudget = (budgetType: string) =>
    budgetType === "ersatzpflege_39_42a";

  const centsToEuro = (cents: number | null) =>
    cents !== null ? (cents / 100).toFixed(2) : "";

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
                            placeholder="Voller Betrag"
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
                            placeholder="Voller Betrag"
                            value={centsToEuro(setting.yearlyLimitCents)}
                            onChange={(e) => updateCentsField(index, "yearlyLimitCents", e.target.value)}
                            className="h-8 mt-1 text-base"
                            data-testid={`input-yearly-limit-${setting.budgetType}`}
                          />
                        </div>
                      )}

                      <div className="border-t border-gray-100 pt-3">
                        <Label className="text-xs text-gray-500">Verfügbarer Startwert (€)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="Kein Startwert"
                          value={centsToEuro(setting.initialBalanceCents)}
                          onChange={(e) => updateCentsField(index, "initialBalanceCents", e.target.value)}
                          className="h-8 mt-1 text-base"
                          data-testid={`input-initial-balance-${setting.budgetType}`}
                        />
                        {setting.initialBalanceCents !== null && setting.initialBalanceCents > 0 && (
                          <div className="mt-2">
                            <Label className="text-xs text-gray-500">Gültig ab</Label>
                            <div className="flex gap-2 mt-1">
                              <select
                                value={setting.initialBalanceMonth?.split("-")[1] || String(new Date().getMonth() + 1).padStart(2, "0")}
                                onChange={(e) => {
                                  const year = setting.initialBalanceMonth?.split("-")[0] || String(new Date().getFullYear());
                                  updateField(index, "initialBalanceMonth", `${year}-${e.target.value}`);
                                }}
                                className="h-8 text-sm border border-gray-200 rounded-md px-2 flex-1"
                                data-testid={`select-balance-month-${setting.budgetType}`}
                              >
                                {MONTH_OPTIONS.map(m => (
                                  <option key={m.value} value={m.value}>{m.label}</option>
                                ))}
                              </select>
                              <select
                                value={setting.initialBalanceMonth?.split("-")[0] || String(new Date().getFullYear())}
                                onChange={(e) => {
                                  const month = setting.initialBalanceMonth?.split("-")[1] || String(new Date().getMonth() + 1).padStart(2, "0");
                                  updateField(index, "initialBalanceMonth", `${e.target.value}-${month}`);
                                }}
                                className="h-8 text-sm border border-gray-200 rounded-md px-2 w-20"
                                data-testid={`select-balance-year-${setting.budgetType}`}
                              >
                                {[new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1].map(y => (
                                  <option key={y} value={String(y)}>{y}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        )}
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
