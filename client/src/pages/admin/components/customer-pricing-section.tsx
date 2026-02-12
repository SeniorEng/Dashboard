import { useQuery } from "@tanstack/react-query";
import { StatusBadge } from "@/components/patterns/status-badge";
import { formatCurrency } from "@shared/utils/format";
import { Loader2 } from "lucide-react";

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
  const { data: services, isLoading } = useQuery<CatalogService[]>({
    queryKey: ["/api/services"],
    staleTime: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }

  const activeServices = services?.filter(s => s.isActive) || [];

  if (activeServices.length === 0) {
    return <p className="text-sm text-gray-500 py-4 text-center" data-testid="text-no-prices">Keine Dienstleistungen im Katalog</p>;
  }

  return (
    <div className="space-y-1" data-testid="pricing-section">
      <div className="grid grid-cols-[1fr_auto] gap-x-3 items-center px-2 py-1 text-xs text-gray-500 font-medium">
        <span>Dienstleistung</span>
        <span className="text-right w-24">Preis</span>
      </div>
      {activeServices.map((service) => {
        const unitLabel = UNIT_LABELS[service.unitType] || "€";
        return (
          <div key={service.id} className="grid grid-cols-[1fr_auto] gap-x-3 items-center px-2 py-2 rounded-lg hover:bg-gray-50" data-testid={`pricing-row-${service.id}`}>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{service.name}</span>
                {service.isBillable ? (
                  <StatusBadge type="billable" value="billable" size="sm" />
                ) : (
                  <StatusBadge type="billable" value="not-billable" size="sm" />
                )}
              </div>
            </div>
            <div className="text-right w-24">
              {service.isBillable ? (
                <>
                  <span className="text-sm font-semibold">{formatCurrency(service.defaultPriceCents)}</span>
                  <span className="text-xs text-gray-500 ml-0.5">{unitLabel}</span>
                </>
              ) : (
                <span className="text-sm text-gray-400">—</span>
              )}
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-gray-400 px-2 pt-2">
        Alle Preise zzgl. MwSt. aus dem Dienstleistungskatalog.
      </p>
    </div>
  );
}
