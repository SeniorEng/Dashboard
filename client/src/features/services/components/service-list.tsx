import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Loader2, ClipboardList } from "lucide-react";
import { formatCurrency } from "@shared/utils/format";
import type { ServiceWithPots } from "../types";
import { UNIT_TYPE_LABELS, UNIT_SUFFIX } from "../constants";
import { formatPrice } from "../utils";

interface ServiceListProps {
  services: ServiceWithPots[] | undefined;
  isLoading: boolean;
}

export function ServiceList({ services, isLoading }: ServiceListProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
      </div>
    );
  }

  if (!services?.length) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <ClipboardList className="h-12 w-12 mx-auto mb-4 text-gray-300" />
          <p className="text-gray-500">Keine Dienstleistungen vorhanden</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {services.map((service) => {
        const suffix = UNIT_SUFFIX[service.unitType] || "";
        return (
          <Card
            key={service.id}
            className={`border ${!service.isActive ? "opacity-60" : ""}`}
            data-testid={`card-service-${service.id}`}
          >
            <CardContent className="py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-gray-900 truncate" data-testid={`text-service-name-${service.id}`}>{service.name}</span>
                    {service.isSystem && (
                      <StatusBadge type="system" value="system" size="sm" data-testid={`badge-system-${service.id}`} />
                    )}
                    {service.isDefault && (
                      <StatusBadge type="system" value="default" size="sm" data-testid={`badge-default-${service.id}`} />
                    )}
                    <StatusBadge type="billable" value={service.isBillable ? "billable" : "not-billable"} size="sm" data-testid={`badge-billable-${service.id}`} />
                    {!service.isSystem && (
                      <StatusBadge type="activity" value={service.isActive ? "active" : "inactive"} size="sm" data-testid={`badge-active-${service.id}`} />
                    )}
                  </div>
                  <div className="text-sm text-gray-500 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span data-testid={`text-unit-type-${service.id}`}>{UNIT_TYPE_LABELS[service.unitType] || service.unitType}</span>
                      {service.isBillable && (
                        <>
                          <span className="text-gray-300">·</span>
                          <span data-testid={`text-price-${service.id}`}>{formatPrice(service.defaultPriceCents)} €{suffix}</span>
                          <span className="text-gray-300">·</span>
                          <span data-testid={`text-vat-${service.id}`}>{service.vatRate}% MwSt</span>
                        </>
                      )}
                    </div>
                    {service.employeeRateCents > 0 && (
                      <div data-testid={`text-employee-rate-${service.id}`}>
                        Vergütung: {formatCurrency(service.employeeRateCents)}{suffix}
                      </div>
                    )}
                  </div>
                  {service.description && (
                    <p className="text-xs text-gray-500 mt-1 truncate" data-testid={`text-description-${service.id}`}>{service.description}</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
