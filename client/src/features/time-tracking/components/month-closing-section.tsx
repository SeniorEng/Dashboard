import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock, Unlock } from "lucide-react";
import { useMonthClosingStatus } from "../hooks/use-month-closing";
import { iconSize } from "@/design-system";
import { buildMonthClosingViewModel } from "../lib/month-closing-message";

interface MonthClosingSectionProps {
  year: number;
  month: number;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function MonthClosingSection({ year, month }: MonthClosingSectionProps) {
  const { data: statusData, isLoading: statusLoading } = useMonthClosingStatus(year, month);

  if (statusLoading) return null;

  const closing = statusData?.closing;
  const isClosed = Boolean(closing && !closing.reopenedAt);

  const vm = buildMonthClosingViewModel({
    year,
    month,
    isClosed,
    today: todayIso(),
  });

  if (!vm.show) return null;

  const Icon = vm.iconKind === "lock" ? Lock : Unlock;
  const iconColor =
    vm.variant === "closed"
      ? "text-green-600"
      : vm.variant === "overdue"
        ? "text-amber-700"
        : "text-amber-600";
  const cardClass =
    vm.variant === "closed"
      ? "border-green-200 bg-green-50/40"
      : vm.variant === "overdue"
        ? "border-amber-300 bg-amber-50"
        : "border-amber-200 bg-amber-50/60";

  const messageTestId =
    vm.variant === "closed"
      ? "text-month-status-closed"
      : vm.variant === "overdue"
        ? "text-month-status-overdue"
        : "text-month-status-open";

  return (
    <Card data-testid="card-month-closing" className={cardClass}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Icon className={`${iconSize.sm} ${iconColor}`} />
          <CardTitle className="text-sm font-medium text-gray-700">
            Monatsabschluss {vm.monthLabel}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <p className={`text-sm ${vm.toneClass}`} data-testid={messageTestId}>
          {renderMessageWithBold(vm.message, vm.monthLabel, vm.cutoffFormatted)}
        </p>
      </CardContent>
    </Card>
  );
}

function renderMessageWithBold(message: string, monthLabel: string, cutoffFormatted: string) {
  const tokens = [monthLabel, cutoffFormatted];
  const pattern = new RegExp(
    `(${tokens.map(escapeRegex).join("|")})`,
    "g",
  );
  const parts = message.split(pattern);
  return parts.map((part, idx) =>
    tokens.includes(part) ? (
      <strong key={idx} className="font-semibold">
        {part}
      </strong>
    ) : (
      <span key={idx}>{part}</span>
    ),
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
