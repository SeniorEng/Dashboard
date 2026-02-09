import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { formatCurrency } from "@shared/utils/format";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";
import { Loader2, Euro, Plus } from "lucide-react";
import type { CustomerPricingInfo } from "@/lib/api/types";

function formatCentsOrDash(cents: number | null): string {
  if (cents === null) return "-";
  return formatCurrency(cents);
}

export interface PricingSectionProps {
  customerId: number;
  customerName: string;
  pricingHistory: CustomerPricingInfo[];
  currentPricing: CustomerPricingInfo | null;
  onRefresh: () => void;
}

export function PricingSection({ customerId, customerName, pricingHistory, currentPricing, onRefresh }: PricingSectionProps) {
  const { toast } = useToast();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newHauswirtschaftRate, setNewHauswirtschaftRate] = useState("");
  const [newAlltagsbegleitungRate, setNewAlltagsbegleitungRate] = useState("");
  const [newKilometerRate, setNewKilometerRate] = useState("");
  const todayDate = todayISO();
  const [newValidFrom, setNewValidFrom] = useState(todayDate);

  const addPricingMutation = useMutation({
    mutationFn: async (data: {
      hauswirtschaftRateCents?: number;
      alltagsbegleitungRateCents?: number;
      kilometerRateCents?: number;
      validFrom: string;
    }) => {
      const result = await api.post(`/admin/customers/${customerId}/pricing`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      onRefresh();
      setIsAddOpen(false);
      setNewHauswirtschaftRate("");
      setNewAlltagsbegleitungRate("");
      setNewKilometerRate("");
      setNewValidFrom(todayISO());
      toast({ title: "Preise hinzugefügt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addPricingMutation.mutate({
      hauswirtschaftRateCents: newHauswirtschaftRate ? Math.round(parseFloat(newHauswirtschaftRate) * 100) : undefined,
      alltagsbegleitungRateCents: newAlltagsbegleitungRate ? Math.round(parseFloat(newAlltagsbegleitungRate) * 100) : undefined,
      kilometerRateCents: newKilometerRate ? Math.round(parseFloat(newKilometerRate) * 100) : undefined,
      validFrom: newValidFrom,
    });
  };

  return (
    <div className="mt-6 pt-6 border-t">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <Euro className={iconSize.sm} />
          Preise
        </h3>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => setIsAddOpen(!isAddOpen)}
          data-testid="button-add-pricing"
        >
          <Plus className={`${iconSize.sm} mr-1`} />
          Neue Preise
        </Button>
      </div>

      {isAddOpen && (
        <form onSubmit={handleAddSubmit} className="mb-4 p-4 bg-gray-50 rounded-lg space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-hauswirtschaft-rate">Hauswirtschaft</Label>
              <div className="relative">
                <Input
                  id="new-hauswirtschaft-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newHauswirtschaftRate}
                  onChange={(e) => setNewHauswirtschaftRate(e.target.value)}
                  placeholder="z.B. 35.00"
                  className="pr-10"
                  data-testid="input-new-hauswirtschaft-rate"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-alltagsbegleitung-rate">Alltagsbegleitung</Label>
              <div className="relative">
                <Input
                  id="new-alltagsbegleitung-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newAlltagsbegleitungRate}
                  onChange={(e) => setNewAlltagsbegleitungRate(e.target.value)}
                  placeholder="z.B. 35.00"
                  className="pr-10"
                  data-testid="input-new-alltagsbegleitung-rate"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/h</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-kilometer-rate">Kilometerpreis</Label>
              <div className="relative">
                <Input
                  id="new-kilometer-rate"
                  type="number"
                  step="0.01"
                  min="0"
                  value={newKilometerRate}
                  onChange={(e) => setNewKilometerRate(e.target.value)}
                  placeholder="z.B. 0.50"
                  className="pr-12"
                  data-testid="input-new-kilometer-rate"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">€/km</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Gültig ab *</Label>
            <DatePicker
              value={newValidFrom || null}
              onChange={(val) => setNewValidFrom(val || "")}
              minDate={new Date(todayDate)}
              data-testid="input-new-pricing-valid-from"
            />
            <p className="text-xs text-gray-500">Nur ab heute oder in der Zukunft möglich</p>
          </div>

          <div className="flex gap-2">
            <Button 
              type="submit" 
              disabled={addPricingMutation.isPending}
              data-testid="button-submit-pricing"
            >
              {addPricingMutation.isPending ? (
                <><Loader2 className={`mr-2 ${iconSize.sm} animate-spin`} />Speichern...</>
              ) : "Speichern"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setIsAddOpen(false)}>
              Abbrechen
            </Button>
          </div>
        </form>
      )}

      {pricingHistory && pricingHistory.length > 0 ? (
        <div className="space-y-3">
          {currentPricing && (
            <div className="p-3 bg-teal-50 border border-teal-200 rounded-lg">
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="secondary" className="bg-teal-100 text-teal-800">Aktuell</Badge>
                <span className="text-sm text-gray-500">seit {formatDateForDisplay(currentPricing.validFrom)}</span>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <div className="min-w-[100px]">
                  <div className="text-gray-500 text-xs">Hauswirtschaft</div>
                  <div className="font-medium">{formatCentsOrDash(currentPricing.hauswirtschaftRateCents)}/h</div>
                </div>
                <div className="min-w-[100px]">
                  <div className="text-gray-500 text-xs">Alltagsbegleitung</div>
                  <div className="font-medium">{formatCentsOrDash(currentPricing.alltagsbegleitungRateCents)}/h</div>
                </div>
                <div className="min-w-[80px]">
                  <div className="text-gray-500 text-xs">Kilometer</div>
                  <div className="font-medium">{formatCentsOrDash(currentPricing.kilometerRateCents)}/km</div>
                </div>
              </div>
            </div>
          )}

          {pricingHistory.filter(p => p.validTo).length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-medium text-gray-500 mb-2">Vergangene Preise</h4>
              <div className="space-y-2">
                {pricingHistory.filter(p => p.validTo).map((pricing) => (
                  <div key={pricing.id} className="p-2 bg-gray-50 rounded text-sm">
                    <div className="text-gray-500 text-xs mb-1">
                      {formatDateForDisplay(pricing.validFrom)} - {formatDateForDisplay(pricing.validTo!)}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span>HW: {formatCentsOrDash(pricing.hauswirtschaftRateCents)}/h</span>
                      <span>AB: {formatCentsOrDash(pricing.alltagsbegleitungRateCents)}/h</span>
                      <span>Km: {formatCentsOrDash(pricing.kilometerRateCents)}/km</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500 py-4 text-center">Noch keine Preise hinterlegt</p>
      )}
    </div>
  );
}
