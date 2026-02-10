import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DURATION_OPTIONS, formatDuration } from "@shared/types";
import type { Service } from "@shared/schema";
import { Loader2, Plus, X } from "lucide-react";

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
  const { data: catalogServices, isLoading } = useQuery<Service[]>({
    queryKey: ["/api/services"],
    staleTime: 60_000,
  });

  const selectableServices = (catalogServices || []).filter(
    s => s.isActive && s.unitType === "hours" && (!s.code || !EXCLUDED_CODES.includes(s.code))
  );

  const selectedIds = new Set(services.map(s => s.serviceId));

  const getFirstAvailable = () => {
    return selectableServices.find(s => !selectedIds.has(s.id));
  };

  const handleAddService = () => {
    const first = getFirstAvailable();
    if (!first) return;
    onChange([...services, { serviceId: first.id, durationMinutes: 60 }]);
  };

  const handleRemoveService = (index: number) => {
    onChange(services.filter((_, i) => i !== index));
  };

  const handleServiceChange = (index: number, serviceId: number) => {
    const updated = [...services];
    updated[index] = { ...updated[index], serviceId };
    onChange(updated);
  };

  const handleDurationChange = (index: number, durationMinutes: number) => {
    const updated = [...services];
    updated[index] = { ...updated[index], durationMinutes };
    onChange(updated);
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

  const rows = services.length > 0
    ? services
    : [{ serviceId: 0, durationMinutes: 60 }];

  const hasMoreAvailable = selectableServices.length > services.length;

  return (
    <div className="space-y-4">
      <Label>Services (mindestens einer)</Label>

      {rows.map((entry, index) => {
        const isPlaceholder = entry.serviceId === 0;
        return (
          <div key={index} className="flex items-center gap-2" data-testid={`service-row-${index}`}>
            <Select
              value={isPlaceholder ? "" : String(entry.serviceId)}
              onValueChange={(v) => {
                const id = parseInt(v);
                if (services.length === 0) {
                  onChange([{ serviceId: id, durationMinutes: 60 }]);
                } else {
                  handleServiceChange(index, id);
                }
              }}
            >
              <SelectTrigger className="flex-1" data-testid={`service-select-${index}`}>
                <SelectValue placeholder="Service wählen..." />
              </SelectTrigger>
              <SelectContent>
                {selectableServices.map((s) => (
                  <SelectItem
                    key={s.id}
                    value={String(s.id)}
                    disabled={selectedIds.has(s.id) && s.id !== entry.serviceId}
                  >
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={String(entry.durationMinutes)}
              onValueChange={(v) => {
                if (services.length === 0) {
                  return;
                }
                handleDurationChange(index, parseInt(v));
              }}
            >
              <SelectTrigger className="w-auto min-w-[120px]" data-testid={`duration-select-${index}`}>
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

            {services.length > 1 && index > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleRemoveService(index)}
                data-testid={`remove-service-${index}`}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
            {(services.length <= 1 || index === 0) && services.length > 0 && (
              <div className="w-9" />
            )}
          </div>
        );
      })}

      {hasMoreAvailable && services.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddService}
          data-testid="add-service-button"
        >
          <Plus className="h-4 w-4 mr-1" />
          Service hinzufügen
        </Button>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
