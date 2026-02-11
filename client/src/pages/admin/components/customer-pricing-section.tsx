import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { todayISO } from "@shared/utils/datetime";
import { formatCurrency } from "@shared/utils/format";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";
import { Loader2, Pencil, Check, X } from "lucide-react";

interface ServicePrice {
  service: {
    id: number;
    name: string;
    code: string | null;
    unitType: string;
    defaultPriceCents: number;
    vatRate: number;
    billingCategory: string;
  };
  priceCents: number;
  isOverride: boolean;
}

const UNIT_LABELS: Record<string, string> = {
  hours: "€/Std.",
  kilometers: "€/km",
  flat: "€ pauschal",
};

export interface PricingSectionProps {
  customerId: number;
  customerName: string;
  onRefresh: () => void;
}

export function PricingSection({ customerId, customerName, onRefresh }: PricingSectionProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingServiceId, setEditingServiceId] = useState<number | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const [editValidFrom, setEditValidFrom] = useState(todayISO());

  const { data: prices, isLoading } = useQuery<ServicePrice[]>({
    queryKey: ["customer-service-prices", customerId],
    queryFn: async () => {
      const response = await fetch(`/api/services/customer/${customerId}/prices`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Preise konnten nicht geladen werden");
      return response.json();
    },
    staleTime: 60000,
  });

  const updatePriceMutation = useMutation({
    mutationFn: async (data: { serviceId: number; priceCents: number; validFrom: string }) => {
      return unwrapResult(await api.post(`/services/customer/${customerId}/overrides`, {
        serviceId: data.serviceId,
        priceCents: data.priceCents,
        validFrom: data.validFrom,
      }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-service-prices", customerId] });
      setEditingServiceId(null);
      setEditPrice("");
      setEditValidFrom(todayISO());
      onRefresh();
      toast({ title: "Preis aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleEditSubmit = (serviceId: number) => {
    const cents = Math.round(parseFloat(editPrice) * 100);
    if (isNaN(cents) || cents < 0) {
      toast({ title: "Fehler", description: "Bitte gültigen Preis eingeben", variant: "destructive" });
      return;
    }
    updatePriceMutation.mutate({ serviceId, priceCents: cents, validFrom: editValidFrom });
  };

  const startEdit = (sp: ServicePrice) => {
    setEditingServiceId(sp.service.id);
    setEditPrice((sp.priceCents / 100).toFixed(2));
    setEditValidFrom(todayISO());
  };

  const cancelEdit = () => {
    setEditingServiceId(null);
    setEditPrice("");
  };

  if (isLoading) {
    return <div className="text-sm text-gray-500 py-4 text-center">Laden...</div>;
  }

  if (!prices || prices.length === 0) {
    return <p className="text-sm text-gray-500 py-4 text-center" data-testid="text-no-prices">Keine Dienstleistungen im Katalog</p>;
  }

  return (
    <div className="space-y-1" data-testid="pricing-section">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center px-2 py-1 text-xs text-gray-500 font-medium">
        <span>Dienstleistung</span>
        <span className="text-right w-20">Preis</span>
        <span className="w-11"></span>
      </div>
      {prices.map((sp) => {
        const unitLabel = UNIT_LABELS[sp.service.unitType] || "€";
        const isEditing = editingServiceId === sp.service.id;
        const defaultPrice = sp.service.defaultPriceCents;
        const hasOverride = sp.isOverride;

        return (
          <div key={sp.service.id} data-testid={`pricing-row-${sp.service.id}`}>
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center px-2 py-2 rounded-lg hover:bg-gray-50">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{sp.service.name}</span>
                  {hasOverride && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0 bg-amber-50 text-amber-700 border-amber-200">
                      Individuell
                    </Badge>
                  )}
                </div>
                {hasOverride && (
                  <span className="text-[11px] text-gray-400">
                    Standard: {formatCurrency(defaultPrice)} {unitLabel}
                  </span>
                )}
              </div>
              <div className="text-right w-20">
                <span className="text-sm font-semibold">{formatCurrency(sp.priceCents)}</span>
                <span className="text-xs text-gray-500 ml-0.5">{unitLabel}</span>
              </div>
              <div className="w-11 flex justify-end">
                <button
                  type="button"
                  onClick={() => startEdit(sp)}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-gray-400 hover:text-gray-700"
                  data-testid={`btn-edit-price-${sp.service.id}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {isEditing && (
              <div className="px-2 pb-3 pt-1">
                <div className="p-3 bg-gray-50 rounded-lg space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Neuer Preis ({unitLabel})</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editPrice}
                      onChange={(e) => setEditPrice(e.target.value)}
                      className="h-8 text-base"
                      autoFocus
                      data-testid={`input-edit-price-${sp.service.id}`}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Gültig ab</Label>
                    <DatePicker
                      value={editValidFrom || null}
                      onChange={(val) => setEditValidFrom(val || "")}
                      data-testid={`input-edit-valid-from-${sp.service.id}`}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleEditSubmit(sp.service.id)}
                      disabled={updatePriceMutation.isPending}
                      data-testid={`btn-save-price-${sp.service.id}`}
                    >
                      {updatePriceMutation.isPending ? (
                        <Loader2 className={`${iconSize.sm} animate-spin`} />
                      ) : (
                        <><Check className={`${iconSize.sm} mr-1`} />Speichern</>
                      )}
                    </Button>
                    <Button size="sm" variant="outline" onClick={cancelEdit}>
                      <X className={`${iconSize.sm} mr-1`} />Abbrechen
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[11px] text-gray-400 px-2 pt-2">
        Alle Preise zzgl. MwSt. Individuelle Preise überschreiben den Katalog-Standardpreis.
      </p>
    </div>
  );
}
