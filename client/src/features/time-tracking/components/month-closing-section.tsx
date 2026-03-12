import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock, Unlock } from "lucide-react";
import { useMonthClosingStatus } from "../hooks/use-month-closing";
import { iconSize } from "@/design-system";

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

interface MonthClosingSectionProps {
  year: number;
  month: number;
}

export function MonthClosingSection({ year, month }: MonthClosingSectionProps) {
  const { data: statusData, isLoading: statusLoading } = useMonthClosingStatus(year, month);

  const closing = statusData?.closing;
  const isClosed = closing && !closing.reopenedAt;
  const monthName = MONTH_NAMES[month - 1];

  if (statusLoading) return null;

  return (
    <Card data-testid="card-month-closing">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          {isClosed ? (
            <Lock className={`${iconSize.sm} text-green-600`} />
          ) : (
            <Unlock className={`${iconSize.sm} text-gray-400`} />
          )}
          <CardTitle className="text-sm font-medium text-gray-600">
            Monatsabschluss {monthName} {year}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {isClosed ? (
          <p className="text-sm text-green-700" data-testid="text-month-status-closed">
            Dieser Monat ist abgeschlossen. Einträge sind gesperrt. Bei Bedarf kann ein Admin den Monat wieder öffnen.
          </p>
        ) : (
          <p className="text-sm text-gray-500" data-testid="text-month-status-open">
            Dieser Monat ist noch offen. Der Monatsabschluss wird zentral durch die Administration durchgeführt.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
