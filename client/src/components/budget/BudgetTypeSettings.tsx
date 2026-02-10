import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowUp, ArrowDown, Save } from "lucide-react";
import { toast } from "sonner";
import { BUDGET_TYPE_LABELS, type BudgetType } from "@shared/domain/budgets";
import { api } from "@/lib/api/client";

interface BudgetTypeSetting {
  id: number | null;
  customerId: number;
  budgetType: string;
  enabled: boolean;
  priority: number;
  monthlyLimitCents: number | null;
}

interface BudgetTypeSettingsProps {
  customerId: number;
}

export function BudgetTypeSettings({ customerId }: BudgetTypeSettingsProps) {
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
      return await api.put(`/budget/${customerId}/type-settings`, {
        settings: newSettings.map(s => ({
          budgetType: s.budgetType,
          enabled: s.enabled,
          priority: s.priority,
          monthlyLimitCents: s.monthlyLimitCents,
        })),
      });
    },
    onSuccess: () => {
      toast.success("Budget-Einstellungen gespeichert");
      queryClient.invalidateQueries({ queryKey: ["budget-type-settings", customerId] });
      setHasChanges(false);
    },
    onError: (error: Error) => {
      toast.error(error.message);
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

  const updateMonthlyLimit = (index: number, value: string) => {
    const newSettings = [...settings];
    const cents = value === "" ? null : Math.round(parseFloat(value) * 100);
    newSettings[index] = { ...newSettings[index], monthlyLimitCents: cents };
    setSettings(newSettings);
    setHasChanges(true);
  };

  const isMonthlyBudget = (budgetType: string) =>
    budgetType === "entlastungsbetrag_45b" || budgetType === "umwandlung_45a";

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
          const limitEuro = setting.monthlyLimitCents !== null
            ? (setting.monthlyLimitCents / 100).toFixed(2)
            : "";

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

                  {isMonthlyBudget(setting.budgetType) && setting.enabled && (
                    <div className="mt-2">
                      <Label className="text-xs text-gray-500">Unser Anteil (€/Monat)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Voller Betrag"
                        value={limitEuro}
                        onChange={(e) => updateMonthlyLimit(index, e.target.value)}
                        className="h-8 mt-1 text-base"
                        data-testid={`input-monthly-limit-${setting.budgetType}`}
                      />
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
