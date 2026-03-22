import { Card, CardContent } from "@/components/ui/card";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";

interface CockpitKPIProps {
  title: string;
  icon: React.ReactNode;
  value: string;
  percent: number;
  thresholds: { green: number; yellow: number };
  prevValue: number | null;
  prevLabel: string;
  metrics: { label: string; value: string }[];
  testId: string;
}

export function CockpitKPI({ title, icon, value, percent, thresholds, prevValue, prevLabel, metrics, testId }: CockpitKPIProps) {
  const color = percent >= thresholds.green
    ? { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", bar: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-800" }
    : percent >= thresholds.yellow
    ? { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", bar: "bg-amber-500", badge: "bg-amber-100 text-amber-800" }
    : { bg: "bg-red-50", border: "border-red-200", text: "text-red-700", bar: "bg-red-500", badge: "bg-red-100 text-red-800" };

  const trend = prevValue !== null ? percent - prevValue : null;

  return (
    <Card className={`${color.border} ${color.bg}`} data-testid={testId}>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <div className={color.text}>{icon}</div>
          <span className="font-semibold text-sm">{title}</span>
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium ${color.badge}`}>
            {percent >= thresholds.green ? "Gut" : percent >= thresholds.yellow ? "Achtung" : "Kritisch"}
          </span>
        </div>

        <div className="flex items-end gap-3 mb-3">
          <span className={`text-2xl sm:text-3xl font-bold ${color.text}`} data-testid={`${testId}-value`}>{value}</span>
          {trend !== null && (
            <div className={`flex items-center gap-0.5 text-sm mb-1 ${trend > 0 ? "text-emerald-600" : trend < 0 ? "text-red-600" : "text-gray-500"}`} data-testid={`${testId}-trend`}>
              {trend > 0 ? <ArrowUpRight className="w-4 h-4" /> : trend < 0 ? <ArrowDownRight className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
              <span className="font-medium">{trend > 0 ? "+" : ""}{trend}%</span>
              <span className="text-xs text-muted-foreground ml-0.5">{prevLabel}</span>
            </div>
          )}
        </div>

        <div className="w-full bg-white/60 rounded-full h-2 mb-3">
          <div className={`h-2 rounded-full ${color.bar} transition-all`} style={{ width: `${Math.min(percent, 100)}%` }} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          {metrics.map(m => (
            <div key={m.label} className="text-center">
              <div className="text-xs text-muted-foreground">{m.label}</div>
              <div className="text-sm font-semibold">{m.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
