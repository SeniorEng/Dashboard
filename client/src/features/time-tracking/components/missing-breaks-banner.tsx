import { AlertCircle } from "lucide-react";
import { iconSize } from "@/design-system";
import { formatDateForDisplay } from "@shared/utils/date";

interface MissingBreakDay {
  date: string;
  requiredBreakMinutes: number;
  documentedBreakMinutes: number;
}

interface MissingBreaksBannerProps {
  daysWithMissingBreaks: MissingBreakDay[];
  onSelectDate: (date: string, year: number, month: number) => void;
}

export function MissingBreaksBanner({ daysWithMissingBreaks, onSelectDate }: MissingBreaksBannerProps) {
  if (daysWithMissingBreaks.length === 0) return null;

  return (
    <div
      className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg"
      data-testid="banner-missing-breaks-detail"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className={`${iconSize.md} text-blue-600 shrink-0 mt-0.5`} />
        <div>
          <p className="text-sm font-medium text-blue-800 mb-1">
            Fehlende Pausendokumentation
          </p>
          <p className="text-xs text-blue-700 mb-2">
            Nach deutschem Arbeitsrecht (§4 ArbZG) muss bei mehr als 6h Arbeit mind. 30 min Pause, bei mehr als 9h Arbeit mind. 45 min Pause dokumentiert werden.
          </p>
          <div className="flex flex-wrap gap-2">
            {daysWithMissingBreaks.map(day => {
              const missingMinutes = day.requiredBreakMinutes - day.documentedBreakMinutes;
              const [year, month] = day.date.split("-").map(Number);
              return (
                <button
                  key={day.date}
                  onClick={() => onSelectDate(day.date, year, month)}
                  className="px-2 py-1 bg-blue-100 hover:bg-blue-200 rounded text-xs font-medium text-blue-800 transition-colors"
                  data-testid={`missing-break-day-${day.date}`}
                >
                  {formatDateForDisplay(day.date, { day: "numeric", month: "short" })}
                  <span className="text-blue-600 ml-1">
                    (noch {missingMinutes} min)
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
