import type { ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const WORKLOAD_TOOLTIP_TEXT = {
  line1:
    "Ist = Ø der letzten 3 abgeschlossenen Monate. Der laufende Monat zählt nicht.",
  line2:
    "Es zählen nur abgeschlossene/dokumentierte Termine als Hauptverantwortlicher. Vertretungen und geplante Termine fließen nicht ein.",
};

function WorkloadTooltipBody() {
  return (
    <div className="space-y-2 text-xs leading-relaxed">
      <p>{WORKLOAD_TOOLTIP_TEXT.line1}</p>
      <p>{WORKLOAD_TOOLTIP_TEXT.line2}</p>
    </div>
  );
}

interface WorkloadBarTooltipProps {
  children: ReactNode;
}

export function WorkloadBarTooltip({ children }: WorkloadBarTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{children}</div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        className="max-w-xs bg-popover text-popover-foreground border shadow-md"
      >
        <WorkloadTooltipBody />
      </TooltipContent>
    </Tooltip>
  );
}

interface WorkloadInfoTooltipProps {
  testId: string;
  className?: string;
}

export function WorkloadInfoTooltip({
  testId,
  className,
}: WorkloadInfoTooltipProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Erklärung zur Auslastungs-Berechnung"
          className={
            "inline-flex items-center justify-center text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded" +
            (className ? ` ${className}` : "")
          }
          onClick={(e) => e.stopPropagation()}
          data-testid={testId}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        className="w-72"
        onClick={(e) => e.stopPropagation()}
      >
        <WorkloadTooltipBody />
      </PopoverContent>
    </Popover>
  );
}
