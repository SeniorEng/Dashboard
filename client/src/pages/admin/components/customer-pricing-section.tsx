import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { StatusBadge } from "@/components/patterns/status-badge";
import { formatCurrency } from "@shared/utils/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, unwrapResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Pencil, Trash2, Check, X, RotateCcw } from "lucide-react";

interface CatalogService {
  id: number;
  name: string;
  code: string | null;
  unitType: string;
  defaultPriceCents: number;
  vatRate: number;
  isBillable: boolean;
  isActive: boolean;
}

interface CustomerPrice {
  id: number;
  customerId: number;
  serviceId: number;
  priceCents: number;
  validFrom: string;
  validTo: string | null;
  serviceName: string;
  serviceCode: string;
  defaultPriceCents: number;
  unitType: string;
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
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingServiceId, setEditingServiceId] = useState<number | null>(null);
  const [editPrice, setEditPrice] = useState("");

  const { data: services, isLoading: loadingServices } = useQuery<CatalogService[]>({
    queryKey: ["/api/services"],
    staleTime: 60000,
  });

  const { data: customerPrices, isLoading: loadingPrices } = useQuery<CustomerPrice[]>({
    queryKey: ["customer-service-prices", customerId],
    queryFn: async () => {
      const result = await api.get<CustomerPrice[]>(`/customers/${customerId}/service-prices`);
      return unwrapResult(result);
    },
    staleTime: 30000,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ serviceId, priceCents }: { serviceId: number; priceCents: number }) => {
      const result = await api.post(`/customers/${customerId}/service-prices`, { serviceId, priceCents });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-service-prices", customerId] });
      setEditingServiceId(null);
      setEditPrice("");
      toast({ title: "Kundenpreis gespeichert" });
    },
    onError: () => {
      toast({ title: "Fehler beim Speichern", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (priceId: number) => {
      const result = await api.delete(`/customers/${customerId}/service-prices/${priceId}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-service-prices", customerId] });
      toast({ title: "Kundenpreis zurückgesetzt auf Katalogpreis" });
    },
    onError: () => {
      toast({ title: "Fehler beim Löschen", variant: "destructive" });
    },
  });

  if (loadingServices || loadingPrices) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }

  const activeServices = services?.filter(s => s.isActive && s.isBillable) || [];
  const priceMap = new Map<number, CustomerPrice>();
  customerPrices?.forEach(cp => priceMap.set(cp.serviceId, cp));

  if (activeServices.length === 0) {
    return <p className="text-sm text-gray-500 py-4 text-center" data-testid="text-no-prices">Keine Dienstleistungen im Katalog</p>;
  }

  const hasCustomPrices = priceMap.size > 0;

  function startEdit(serviceId: number, currentPriceCents: number) {
    setEditingServiceId(serviceId);
    setEditPrice((currentPriceCents / 100).toFixed(2).replace(".", ","));
  }

  function handleSave(serviceId: number) {
    const normalized = editPrice.replace(",", ".");
    const euros = parseFloat(normalized);
    if (isNaN(euros) || euros < 0) {
      toast({ title: "Ungültiger Preis", variant: "destructive" });
      return;
    }
    saveMutation.mutate({ serviceId, priceCents: Math.round(euros * 100) });
  }

  return (
    <div className="space-y-1" data-testid="pricing-section">
      {hasCustomPrices && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
          <p className="text-xs text-amber-700">Kundenindividuelle Preise aktiv – abweichende Preise sind markiert.</p>
        </div>
      )}
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center px-2 py-1 text-xs text-gray-500 font-medium">
        <span>Dienstleistung</span>
        <span className="text-right w-24">Preis</span>
        <span className="w-16"></span>
      </div>
      {activeServices.map((service) => {
        const unitLabel = UNIT_LABELS[service.unitType] || "€";
        const customPrice = priceMap.get(service.id);
        const effectivePrice = customPrice ? customPrice.priceCents : service.defaultPriceCents;
        const isEditing = editingServiceId === service.id;
        const isCustom = !!customPrice;

        return (
          <div key={service.id} className={`grid grid-cols-[1fr_auto_auto] gap-x-3 items-center px-2 py-2 rounded-lg hover:bg-gray-50 ${isCustom ? 'bg-amber-50/50' : ''}`} data-testid={`pricing-row-${service.id}`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{service.name}</span>
                {isCustom && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">Kundenpreis</span>
                )}
              </div>
              {isCustom && (
                <div className="text-[11px] text-gray-500 mt-0.5">
                  Katalog: {formatCurrency(service.defaultPriceCents)} {unitLabel}
                </div>
              )}
            </div>
            <div className="text-right w-24">
              {isEditing ? (
                <Input
                  type="text"
                  value={editPrice}
                  onChange={e => setEditPrice(e.target.value)}
                  className="h-7 text-sm text-right w-20"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") handleSave(service.id);
                    if (e.key === "Escape") { setEditingServiceId(null); setEditPrice(""); }
                  }}
                  data-testid={`input-price-${service.id}`}
                />
              ) : (
                <>
                  <span className={`text-sm font-semibold ${isCustom ? 'text-amber-700' : ''}`}>{formatCurrency(effectivePrice)}</span>
                  <span className="text-xs text-gray-500 ml-0.5">{unitLabel}</span>
                </>
              )}
            </div>
            <div className="w-16 flex justify-end gap-1">
              {isEditing ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => handleSave(service.id)}
                    disabled={saveMutation.isPending}
                    data-testid={`btn-save-price-${service.id}`}
                  >
                    <Check className="h-3.5 w-3.5 text-green-600" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => { setEditingServiceId(null); setEditPrice(""); }}
                    data-testid={`btn-cancel-price-${service.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => startEdit(service.id, effectivePrice)}
                    data-testid={`btn-edit-price-${service.id}`}
                  >
                    <Pencil className="h-3.5 w-3.5 text-gray-400" />
                  </Button>
                  {isCustom && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => deleteMutation.mutate(customPrice.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`btn-reset-price-${service.id}`}
                    >
                      <RotateCcw className="h-3.5 w-3.5 text-gray-400" />
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-gray-500 px-2 pt-2">
        Preise zzgl. MwSt. Klicken Sie auf den Stift, um einen kundenindividuellen Preis zu setzen. {hasCustomPrices ? "Der Pfeil setzt den Preis auf den Katalogpreis zurück." : ""}
      </p>
    </div>
  );
}
