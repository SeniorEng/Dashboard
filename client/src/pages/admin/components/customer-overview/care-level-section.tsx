import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { PFLEGEGRAD_SELECT_OPTIONS } from "@shared/domain/customers";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { iconSize, componentStyles } from "@/design-system";
import { EditButton } from "./section-helpers";
import { Shield, History, Save, X, Loader2 } from "lucide-react";
import type { SectionProps } from "./types";

export function CareLevelSection({ customer, customerId, editingSection, setEditingSection, saving, invalidateCustomer }: SectionProps) {
  const { toast } = useToast();

  const [newPflegegrad, setNewPflegegrad] = useState<string>("");
  const [pflegegradSeit, setPflegegradSeit] = useState<string>(todayISO());

  const currentCareLevel = customer.careLevelHistory?.find((e) => !e.validTo);

  const changeCareLevelMutation = useMutation({
    mutationFn: async (data: { pflegegrad: number; validFrom: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/care-level`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Pflegegrad aktualisiert", description: "Der Pflegegrad wurde mit Historisierung gespeichert." });
      invalidateCustomer();
      setEditingSection(null);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const startEditing = () => {
    setNewPflegegrad("");
    setPflegegradSeit(todayISO());
    setEditingSection("pflegegrad");
  };

  return (
    <>
      <SectionCard
        title="Pflegegrad"
        icon={<Shield className={iconSize.sm} />}
        actions={editingSection !== "pflegegrad" ? <EditButton section="pflegegrad" editingSection={editingSection} startEditing={startEditing} /> : undefined}
      >
        {editingSection === "pflegegrad" ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
              <span className="text-sm text-gray-600">Aktueller Pflegegrad:</span>
              {customer.pflegegrad != null && customer.pflegegrad > 0 ? (
                <>
                  <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                  {currentCareLevel?.validFrom && (
                    <span className="text-xs text-gray-500">
                      seit {formatDateForDisplay(currentCareLevel.validFrom)}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-sm text-gray-500">Nicht festgelegt</span>
              )}
            </div>

            <p className="text-xs text-gray-500">
              Der bisherige Pflegegrad wird mit Enddatum gespeichert und bleibt für Budgets und Rechnungen nachvollziehbar.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Neuer Pflegegrad</Label>
                <Select value={newPflegegrad} onValueChange={setNewPflegegrad}>
                  <SelectTrigger data-testid="select-new-pflegegrad">
                    <SelectValue placeholder="Auswählen" />
                  </SelectTrigger>
                  <SelectContent>
                    {PFLEGEGRAD_SELECT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Gültig ab</Label>
                <DatePicker
                  value={pflegegradSeit}
                  onChange={(val) => setPflegegradSeit(val || todayISO())}
                  data-testid="input-pflegegrad-seit"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 pt-3">
              <Button
                className={componentStyles.btnPrimary}
                onClick={() => {
                  if (!newPflegegrad) {
                    toast({ title: "Bitte Pflegegrad auswählen", variant: "destructive" });
                    return;
                  }
                  changeCareLevelMutation.mutate({
                    pflegegrad: parseInt(newPflegegrad),
                    validFrom: pflegegradSeit,
                  });
                }}
                disabled={changeCareLevelMutation.isPending || !newPflegegrad}
                data-testid="button-save-pflegegrad"
              >
                {changeCareLevelMutation.isPending ? (
                  <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                ) : (
                  <Save className={`${iconSize.sm} mr-2`} />
                )}
                Speichern
              </Button>
              <Button
                variant="outline"
                onClick={() => setEditingSection(null)}
                disabled={changeCareLevelMutation.isPending}
                data-testid="button-cancel-pflegegrad"
              >
                <X className={`${iconSize.sm} mr-2`} />
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {customer.pflegegrad != null && customer.pflegegrad > 0 ? (
              <>
                <div className="flex items-center gap-3">
                  <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                </div>
                {currentCareLevel?.validFrom && (
                  <p className="text-sm text-gray-500">
                    Seit {formatDateForDisplay(currentCareLevel.validFrom)}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500" data-testid="text-pflegegrad-empty">Nicht festgelegt</p>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Pflegegrad-Verlauf"
        icon={<History className={iconSize.sm} />}
      >
        {customer.careLevelHistory && customer.careLevelHistory.length > 0 ? (
          <div className="relative">
            <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
            <div className="space-y-3">
              {customer.careLevelHistory
                .filter((entry) => !entry.validTo || entry.validTo >= entry.validFrom)
                .map((entry, index) => (
                <div key={entry.id} className="relative pl-10">
                  <div
                    className={`absolute left-2.5 w-3 h-3 rounded-full ${
                      index === 0 ? "bg-teal-500" : "bg-gray-300"
                    }`}
                  />
                  <div className="p-3 rounded-lg bg-gray-50">
                    <div className="flex items-center justify-between">
                      <StatusBadge type="pflegegrad" value={entry.pflegegrad} />
                      <span className="text-xs text-gray-500">
                        {entry.validTo
                          ? `${formatDateForDisplay(entry.validFrom)} - ${formatDateForDisplay(entry.validTo)}`
                          : `seit ${formatDateForDisplay(entry.validFrom)}`}
                      </span>
                    </div>
                    {entry.notes && (
                      <p className="text-sm text-gray-600 mt-2">{entry.notes}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500" data-testid="text-care-history-empty">Kein Verlauf vorhanden</p>
        )}
      </SectionCard>
    </>
  );
}
