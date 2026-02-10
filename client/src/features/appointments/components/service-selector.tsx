import { useQuery } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DURATION_OPTIONS, formatDuration } from "@shared/types";
import type { Service } from "@shared/schema";
import { Loader2 } from "lucide-react";

interface ServiceSelectorProps {
  hauswirtschaft: boolean;
  onHauswirtschaftChange: (checked: boolean) => void;
  hauswirtschaftDauer: number;
  onHauswirtschaftDauerChange: (value: number) => void;
  alltagsbegleitung: boolean;
  onAlltagsbegleitungChange: (checked: boolean) => void;
  alltagsbegleitungDauer: number;
  onAlltagsbegleitungDauerChange: (value: number) => void;
  error?: string;
}

const CODE_MAP: Record<string, { checkedKey: keyof ServiceSelectorProps; dauerKey: keyof ServiceSelectorProps; onChangeKey: keyof ServiceSelectorProps; onDauerChangeKey: keyof ServiceSelectorProps }> = {
  hauswirtschaft: { checkedKey: "hauswirtschaft", dauerKey: "hauswirtschaftDauer", onChangeKey: "onHauswirtschaftChange", onDauerChangeKey: "onHauswirtschaftDauerChange" },
  alltagsbegleitung: { checkedKey: "alltagsbegleitung", dauerKey: "alltagsbegleitungDauer", onChangeKey: "onAlltagsbegleitungChange", onDauerChangeKey: "onAlltagsbegleitungDauerChange" },
};

export function ServiceSelector(props: ServiceSelectorProps) {
  const { error } = props;

  const { data: catalogServices, isLoading } = useQuery<Service[]>({
    queryKey: ["/api/services"],
    staleTime: 60_000,
  });

  const BOOKABLE_CODES = Object.keys(CODE_MAP);
  const selectableServices = (catalogServices || []).filter(
    s => s.isActive && s.code && BOOKABLE_CODES.includes(s.code)
  );

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
    <div className="space-y-4">
      <Label>Services (mindestens einer)</Label>

      {selectableServices.map((service) => {
        const mapping = CODE_MAP[service.code!];
        const isChecked = props[mapping.checkedKey] as boolean;
        const dauer = props[mapping.dauerKey] as number;
        const onChange = props[mapping.onChangeKey] as (checked: boolean) => void;
        const onDauerChange = props[mapping.onDauerChangeKey] as (value: number) => void;

        return (
          <div key={service.id} className="flex items-center space-x-3 p-4 rounded-lg border" data-testid={`service-row-${service.code}`}>
            <Checkbox
              id={`service-${service.code}`}
              checked={isChecked}
              onCheckedChange={(checked) => onChange(!!checked)}
              data-testid={`checkbox-${service.code}`}
            />
            <div className="flex-1">
              <Label htmlFor={`service-${service.code}`} className="cursor-pointer font-medium">
                {service.name}
              </Label>
              {service.description && (
                <p className="text-xs text-muted-foreground">{service.description}</p>
              )}
            </div>
            {isChecked && (
              <Select
                value={dauer.toString()}
                onValueChange={(v) => onDauerChange(parseInt(v))}
              >
                <SelectTrigger className="w-auto min-w-[120px]" data-testid={`select-${service.code}-dauer`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((d) => (
                    <SelectItem key={d} value={d.toString()}>
                      {formatDuration(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
