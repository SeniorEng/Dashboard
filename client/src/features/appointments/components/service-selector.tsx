import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DURATION_OPTIONS } from "@shared/types";
import { formatDuration } from "@shared/domain/appointments";

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

export function ServiceSelector({
  hauswirtschaft,
  onHauswirtschaftChange,
  hauswirtschaftDauer,
  onHauswirtschaftDauerChange,
  alltagsbegleitung,
  onAlltagsbegleitungChange,
  alltagsbegleitungDauer,
  onAlltagsbegleitungDauerChange,
  error,
}: ServiceSelectorProps) {
  return (
    <div className="space-y-4">
      <Label>Services (mindestens einer)</Label>
      
      <div className="flex items-center space-x-3 p-4 rounded-lg border">
        <Checkbox
          id="hauswirtschaft"
          checked={hauswirtschaft}
          onCheckedChange={(checked) => onHauswirtschaftChange(!!checked)}
          data-testid="checkbox-hauswirtschaft"
        />
        <div className="flex-1">
          <Label htmlFor="hauswirtschaft" className="cursor-pointer font-medium">
            Hauswirtschaft
          </Label>
        </div>
        {hauswirtschaft && (
          <Select
            value={hauswirtschaftDauer.toString()}
            onValueChange={(v) => onHauswirtschaftDauerChange(parseInt(v))}
          >
            <SelectTrigger className="w-auto min-w-[120px]" data-testid="select-hauswirtschaft-dauer">
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

      <div className="flex items-center space-x-3 p-4 rounded-lg border">
        <Checkbox
          id="alltagsbegleitung"
          checked={alltagsbegleitung}
          onCheckedChange={(checked) => onAlltagsbegleitungChange(!!checked)}
          data-testid="checkbox-alltagsbegleitung"
        />
        <div className="flex-1">
          <Label htmlFor="alltagsbegleitung" className="cursor-pointer font-medium">
            Alltagsbegleitung
          </Label>
        </div>
        {alltagsbegleitung && (
          <Select
            value={alltagsbegleitungDauer.toString()}
            onValueChange={(v) => onAlltagsbegleitungDauerChange(parseInt(v))}
          >
            <SelectTrigger className="w-auto min-w-[120px]" data-testid="select-alltagsbegleitung-dauer">
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

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
