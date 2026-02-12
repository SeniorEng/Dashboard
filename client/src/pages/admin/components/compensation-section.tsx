import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/patterns/status-badge";
import { DatePicker } from "@/components/ui/date-picker";
import { iconSize } from "@/design-system";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Euro } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatDateDisplay } from "@shared/utils/format";
import { todayISO } from "@shared/utils/datetime";
import { CompensationData } from "./user-types";

export function CompensationSection({ userId, userName }: { userId: number; userName: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newHourlyRateHauswirtschaft, setNewHourlyRateHauswirtschaft] = useState("");
  const [newHourlyRateAlltagsbegleitung, setNewHourlyRateAlltagsbegleitung] = useState("");
  const [newTravelCostType, setNewTravelCostType] = useState<"kilometergeld" | "pauschale" | "">("");
  const [newKilometerRate, setNewKilometerRate] = useState("");
  const [newMonthlyTravelAllowance, setNewMonthlyTravelAllowance] = useState("");
  const todayDate = todayISO();
  const [newValidFrom, setNewValidFrom] = useState(todayDate);

  const { data: compensationHistory, isLoading } = useQuery<CompensationData[]>({
    queryKey: ["admin", "users", userId, "compensation"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/users/${userId}/compensation`, { credentials: "include" });
      if (!res.ok) throw new Error("Vergütungshistorie konnte nicht geladen werden");
      return res.json();
    },
  });

  const addCompensationMutation = useMutation({
    mutationFn: async (data: {
      hourlyRateHauswirtschaftCents?: number;
      hourlyRateAlltagsbegleitungCents?: number;
      travelCostType?: string;
      kilometerRateCents?: number;
      monthlyTravelAllowanceCents?: number;
      validFrom: string;
    }) => {
      const result = await api.post(`/admin/users/${userId}/compensation`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users", userId, "compensation"] });
      setIsAddOpen(false);
      setNewHourlyRateHauswirtschaft("");
      setNewHourlyRateAlltagsbegleitung("");
      setNewTravelCostType("");
      setNewKilometerRate("");
      setNewMonthlyTravelAllowance("");
      setNewValidFrom(todayISO());
      toast({ title: "Vergütung hinzugefügt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addCompensationMutation.mutate({
      hourlyRateHauswirtschaftCents: newHourlyRateHauswirtschaft ? Math.round(parseFloat(newHourlyRateHauswirtschaft) * 100) : undefined,
      hourlyRateAlltagsbegleitungCents: newHourlyRateAlltagsbegleitung ? Math.round(parseFloat(newHourlyRateAlltagsbegleitung) * 100) : undefined,
      travelCostType: newTravelCostType || undefined,
      kilometerRateCents: newTravelCostType === "kilometergeld" && newKilometerRate ? Math.round(parseFloat(newKilometerRate) * 100) : undefined,
      monthlyTravelAllowanceCents: newTravelCostType === "pauschale" && newMonthlyTravelAllowance ? Math.round(parseFloat(newMonthlyTravelAllowance) * 100) : undefined,
      validFrom: newValidFrom,
    });
  };

  const formatCompensationValue = (cents: number | null) => {
    if (cents === null || cents === undefined) return "-";
    return `${(cents / 100).toFixed(2)} €`;
  };

  const currentCompensation = compensationHistory?.find(c => !c.validTo);

  return (
    <div className="mt-6 pt-6 border-t">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <Euro className={iconSize.sm} />
          Vergütung
        </h3>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => setIsAddOpen(!isAddOpen)}
          data-testid="button-add-compensation"
        >
          <Plus className={`${iconSize.sm} mr-1`} />
          Neue Vergütung
        </Button>
      </div>

      {isAddOpen && (
        <form onSubmit={handleAddSubmit} className="mb-4 p-4 bg-gray-50 rounded-lg space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-hourly-rate-hauswirtschaft">Stundenlohn Hauswirtschaft</Label>
              <div className="relative">
                <Input
                  id="new-hourly-rate-hauswirtschaft"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newHourlyRateHauswirtschaft}
                  onChange={(e) => setNewHourlyRateHauswirtschaft(e.target.value)}
                  placeholder="z.B. 15.50"
                  className="pr-8"
                  data-testid="input-new-hourly-rate-hauswirtschaft"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-hourly-rate-alltagsbegleitung">Stundenlohn Alltagsbegleitung</Label>
              <div className="relative">
                <Input
                  id="new-hourly-rate-alltagsbegleitung"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newHourlyRateAlltagsbegleitung}
                  onChange={(e) => setNewHourlyRateAlltagsbegleitung(e.target.value)}
                  placeholder="z.B. 16.00"
                  className="pr-8"
                  data-testid="input-new-hourly-rate-alltagsbegleitung"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-travel-cost-type">Fahrtkostenmodell</Label>
            <Select
              value={newTravelCostType}
              onValueChange={(value: "kilometergeld" | "pauschale" | "") => {
                setNewTravelCostType(value);
                if (value === "kilometergeld") {
                  setNewMonthlyTravelAllowance("");
                } else if (value === "pauschale") {
                  setNewKilometerRate("");
                }
              }}
            >
              <SelectTrigger data-testid="select-new-travel-cost-type">
                <SelectValue placeholder="Bitte wählen..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kilometergeld">Kilometergeld</SelectItem>
                <SelectItem value="pauschale">Monatliche Pauschale</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {newTravelCostType === "kilometergeld" && (
            <div className="space-y-2">
              <Label htmlFor="new-kilometer-rate">Kilometergeld</Label>
              <div className="relative">
                <Input
                  id="new-kilometer-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newKilometerRate}
                  onChange={(e) => setNewKilometerRate(e.target.value)}
                  placeholder="z.B. 0.30"
                  className="pr-12"
                  data-testid="input-new-kilometer-rate"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/km</span>
              </div>
            </div>
          )}

          {newTravelCostType === "pauschale" && (
            <div className="space-y-2">
              <Label htmlFor="new-monthly-travel-allowance">Monatliche Pauschale</Label>
              <div className="relative">
                <Input
                  id="new-monthly-travel-allowance"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newMonthlyTravelAllowance}
                  onChange={(e) => setNewMonthlyTravelAllowance(e.target.value)}
                  placeholder="z.B. 150.00"
                  className="pr-14"
                  data-testid="input-new-monthly-travel-allowance"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/Monat</span>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Gültig ab *</Label>
            <DatePicker
              value={newValidFrom || null}
              onChange={(val) => setNewValidFrom(val || "")}
              minDate={new Date(todayDate)}
              data-testid="input-new-valid-from"
            />
            <p className="text-xs text-gray-500">Nur ab heute oder in der Zukunft möglich</p>
          </div>

          <div className="flex gap-2">
            <Button 
              type="submit" 
              disabled={addCompensationMutation.isPending}
              data-testid="button-submit-compensation"
            >
              {addCompensationMutation.isPending ? (
                <><Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />Speichern...</>
              ) : "Speichern"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>
              Abbrechen
            </Button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : compensationHistory && compensationHistory.length > 0 ? (
        <div className="space-y-3">
          {currentCompensation && (
            <div className="p-3 bg-teal-50 border border-teal-200 rounded-lg">
              <div className="flex items-center gap-2 mb-3">
                <StatusBadge type="info" value="Aktuell" />
                <span className="text-sm text-gray-500">seit {formatDateDisplay(currentCompensation.validFrom)}</span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-gray-500 text-xs">Hauswirtschaft</div>
                  <div className="font-medium">{formatCompensationValue(currentCompensation.hourlyRateHauswirtschaftCents)}/h</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Alltagsbegleitung</div>
                  <div className="font-medium">{formatCompensationValue(currentCompensation.hourlyRateAlltagsbegleitungCents)}/h</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">Fahrtkosten</div>
                  <div className="font-medium">
                    {currentCompensation.travelCostType === "kilometergeld" 
                      ? `${formatCompensationValue(currentCompensation.kilometerRateCents)}/km`
                      : currentCompensation.travelCostType === "pauschale"
                      ? `${formatCompensationValue(currentCompensation.monthlyTravelAllowanceCents)}/Mo`
                      : "-"}
                  </div>
                </div>
              </div>
            </div>
          )}

          {compensationHistory.filter(c => c.validTo).length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-medium text-gray-500 mb-2">Vergangene Vergütungen</h4>
              <div className="space-y-2">
                {compensationHistory.filter(c => c.validTo).map((comp) => (
                  <div key={comp.id} className="p-2 bg-gray-50 rounded text-sm">
                    <div className="text-gray-500 text-xs mb-1">
                      {formatDateDisplay(comp.validFrom)} - {formatDateDisplay(comp.validTo!)}
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-xs">
                      <span>HW: {formatCompensationValue(comp.hourlyRateHauswirtschaftCents)}/h</span>
                      <span>AB: {formatCompensationValue(comp.hourlyRateAlltagsbegleitungCents)}/h</span>
                      <span>
                        {comp.travelCostType === "kilometergeld" 
                          ? `${formatCompensationValue(comp.kilometerRateCents)}/km`
                          : comp.travelCostType === "pauschale"
                          ? `${formatCompensationValue(comp.monthlyTravelAllowanceCents)}/Mo`
                          : "-"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500 py-4 text-center">Noch keine Vergütung hinterlegt</p>
      )}
    </div>
  );
}
