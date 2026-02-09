import { Clock } from "lucide-react";
import { iconSize } from "@/design-system";
import { formatDuration } from "@shared/types";

interface AppointmentSummaryProps {
  startTime: string;
  endTime: string;
  services: { name: string; duration: number }[];
  totalFormatted: string;
}

export function AppointmentSummary({
  startTime,
  endTime,
  services,
  totalFormatted,
}: AppointmentSummaryProps) {
  return (
    <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3" data-testid="summary-panel">
      <div className="flex items-center gap-2 text-primary font-semibold">
        <Clock className={iconSize.sm} />
        <span>Terminübersicht</span>
      </div>
      
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Von</span>
          <p className="font-medium text-lg">{startTime} Uhr</p>
        </div>
        <div>
          <span className="text-muted-foreground">Bis</span>
          <p className="font-medium text-lg">{endTime} Uhr</p>
        </div>
      </div>

      <div className="border-t border-primary/10 pt-3 space-y-1">
        {services.map((s, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span>{s.name}</span>
            <span className="text-muted-foreground">{formatDuration(s.duration)}</span>
          </div>
        ))}
        <div className="flex justify-between font-medium pt-1 border-t border-primary/10">
          <span>Gesamt</span>
          <span className="text-primary">{totalFormatted}</span>
        </div>
      </div>
    </div>
  );
}
