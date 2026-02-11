import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DURATION_OPTIONS, formatDuration } from "@shared/types";
import type { Service } from "@shared/schema";
import { Loader2, Plus, X } from "lucide-react";
import { iconSize } from "@/design-system";

export interface ServiceEntry {
  serviceId: number;
  durationMinutes: number;
}

interface ServiceSelectorProps {
  services: ServiceEntry[];
  onChange: (services: ServiceEntry[]) => void;
  error?: string;
}

const EXCLUDED_CODES = ["erstberatung", "kilometer"];

export function ServiceSelector({ services, onChange, error }: ServiceSelectorProps) {
  const [showAdditionalPicker, setShowAdditionalPicker] = useState(false);

  const { data: catalogServices, isLoading } = useQuery<Service[]>({
    queryKey: ["/api/services"],
    staleTime: 60_000,
  });

  const selectableServices = (catalogServices || []).filter(
    s => s.isActive && s.unitType === "hours" && (!s.code || !EXCLUDED_CODES.includes(s.code))
  );

  const defaultServices = selectableServices.filter(s => s.isDefault);
  const additionalServices = selectableServices.filter(s => !s.isDefault);

  const selectedMap = new Map(services.map(s => [s.serviceId, s]));

  const selectedAdditionalIds = new Set(
    services.map(s => s.serviceId).filter(id => additionalServices.some(a => a.id === id))
  );

  const availableAdditional = additionalServices.filter(s => !selectedAdditionalIds.has(s.id));

  const handleToggle = (service: Service, checked: boolean) => {
    if (checked) {
      onChange([...services, { serviceId: service.id, durationMinutes: service.minDurationMinutes || 60 }]);
    } else {
      onChange(services.filter(s => s.serviceId !== service.id));
    }
  };

  const handleDurationChange = (serviceId: number, durationMinutes: number) => {
    onChange(services.map(s =>
      s.serviceId === serviceId ? { ...s, durationMinutes } : s
    ));
  };

  const handleAddAdditional = (serviceId: string) => {
    const service = additionalServices.find(s => s.id === parseInt(serviceId));
    if (service) {
      onChange([...services, { serviceId: service.id, durationMinutes: service.minDurationMinutes || 60 }]);
    }
    setShowAdditionalPicker(false);
  };

  const handleRemoveAdditional = (serviceId: number) => {
    onChange(services.filter(s => s.serviceId !== serviceId));
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm text-muted-foreground">Dienstleistungen laden...</span>
      </div>
    );
  }

  if (selectableServices.length === 0) {
    return (
      <div className="space-y-4">
        <Label>Services (mindestens einer)</Label>
        <p className="text-sm text-muted-foreground">Keine Dienstleistungen verfügbar. Bitte im Admin-Bereich anlegen.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Label>Services (mindestens einer)</Label>

      {defaultServices.map((service) => {
        const entry = selectedMap.get(service.id);
        const isActive = !!entry;

        return (
          <div
            key={service.id}
            className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${isActive ? "border-primary/30 bg-primary/5" : ""}`}
            data-testid={`service-row-${service.id}`}
          >
            <Switch
              checked={isActive}
              onCheckedChange={(checked) => handleToggle(service, !!checked)}
              data-testid={`toggle-service-${service.id}`}
            />
            <div className="flex-1 min-w-0">
              <span className={`text-sm font-medium ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                {service.name}
              </span>
              {service.description && (
                <p className="text-xs text-muted-foreground truncate">{service.description}</p>
              )}
            </div>
            {isActive && (
              <Select
                value={String(entry!.durationMinutes)}
                onValueChange={(v) => handleDurationChange(service.id, parseInt(v))}
              >
                <SelectTrigger className="w-auto min-w-[110px]" data-testid={`duration-select-${service.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {formatDuration(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}

      {services
        .filter(s => additionalServices.some(a => a.id === s.serviceId))
        .map((entry) => {
          const service = additionalServices.find(a => a.id === entry.serviceId);
          if (!service) return null;
          return (
            <div
              key={service.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-primary/30 bg-primary/5"
              data-testid={`service-row-${service.id}`}
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground">
                  {service.name}
                </span>
                {service.description && (
                  <p className="text-xs text-muted-foreground truncate">{service.description}</p>
                )}
              </div>
              <Select
                value={String(entry.durationMinutes)}
                onValueChange={(v) => handleDurationChange(service.id, parseInt(v))}
              >
                <SelectTrigger className="w-auto min-w-[110px]" data-testid={`duration-select-${service.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {formatDuration(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                onClick={() => handleRemoveAdditional(service.id)}
                className="text-muted-foreground hover:text-destructive transition-colors p-1"
                data-testid={`remove-service-${service.id}`}
              >
                <X className={iconSize.sm} />
              </button>
            </div>
          );
        })}

      {availableAdditional.length > 0 && (
        <>
          {showAdditionalPicker ? (
            <div className="flex items-center gap-2">
              <Select onValueChange={handleAddAdditional}>
                <SelectTrigger className="text-base flex-1" data-testid="select-additional-service">
                  <SelectValue placeholder="Leistung auswählen..." />
                </SelectTrigger>
                <SelectContent>
                  {availableAdditional.map((service) => (
                    <SelectItem key={service.id} value={String(service.id)} data-testid={`option-additional-service-${service.id}`}>
                      {service.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setShowAdditionalPicker(false)}
                data-testid="button-cancel-add-service"
              >
                <X className={iconSize.sm} />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowAdditionalPicker(true)}
              className="w-full text-muted-foreground"
              data-testid="button-add-service"
            >
              <Plus className={`${iconSize.sm} mr-1`} />
              Weitere Leistung hinzufügen
            </Button>
          )}
        </>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
