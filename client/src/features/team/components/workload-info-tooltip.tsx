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
    "Alle Werte sind Ø der letzten 3 abgeschlossenen Monate (laufender Monat zählt nicht), geteilt durch die Beschäftigungsmonate im Zeitraum.",
  line2:
    "Auslastung = (geleistete produktive Zeit + Fahrt/Büro) ÷ Soll. Produktive Zeit zählt in JEDER Rolle (eigene HV-Kunden UND Vertretungen). Krank/Urlaub reduziert die freie Zeit, zählt aber nicht in die Auslastung.",
  line3:
    "Kapazität pro Kunde wird je Mitarbeiter aus seinen EIGENEN HV-Stunden berechnet (Ø HV-Stunden ÷ HV-Kunden) plus 1 h Fahrt-/Rüst-Puffer.",
};

const WORKLOAD_ROLE_LEGEND = [
  { key: "HV", label: "HV — Hauptverantwortlich (eigene Stammkunden)", dot: "bg-teal-600" },
  { key: "V1", label: "V1 — 1. Vertretung", dot: "bg-sky-600" },
  { key: "V2", label: "V2 — 2. Vertretung", dot: "bg-violet-600" },
];

const WORKLOAD_SEGMENT_LEGEND = [
  { key: "prod", label: "Produktiv (HW + Alltagsbegleitung)", dot: "bg-teal-600" },
  { key: "overhead", label: "Fahrt / Büro / Sonstiges", dot: "bg-sky-500" },
  { key: "sickvac", label: "Krank / Urlaub", dot: "bg-amber-500" },
  { key: "free", label: "Frei bis Soll", dot: "bg-emerald-500" },
];

function WorkloadTooltipBody() {
  return (
    <div className="space-y-2 text-xs leading-relaxed">
      <p>{WORKLOAD_TOOLTIP_TEXT.line1}</p>
      <p>{WORKLOAD_TOOLTIP_TEXT.line2}</p>
      <p>{WORKLOAD_TOOLTIP_TEXT.line3}</p>
      <div className="pt-1 border-t border-border space-y-1">
        <p className="font-medium">Balken-Segmente</p>
        {WORKLOAD_SEGMENT_LEGEND.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-sm ${s.dot}`} aria-hidden="true" />
            <span>{s.label}</span>
          </div>
        ))}
      </div>
      <div className="pt-1 border-t border-border space-y-1">
        <p className="font-medium">Rollen</p>
        {WORKLOAD_ROLE_LEGEND.map((r) => (
          <div key={r.key} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${r.dot}`} aria-hidden="true" />
            <span>{r.label}</span>
          </div>
        ))}
      </div>
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
