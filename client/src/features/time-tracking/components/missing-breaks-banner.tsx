import { AlertCircle, Plus } from "lucide-react";
import { iconSize } from "@/design-system";
import { formatDateForDisplay } from "@shared/utils/datetime";
import type { MissingBreakDay } from "@shared/types";

interface MissingBreaksBannerProps {
  daysWithMissingBreaks: MissingBreakDay[];
  onSelectDate: (date: string, year: number, month: number) => void;
  onAddBreak?: (date: string) => void;
}

export function MissingBreaksBanner({ daysWithMissingBreaks, onSelectDate, onAddBreak }: MissingBreaksBannerProps) {
  if (daysWithMissingBreaks.length === 0) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
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
                <div key={day.date} className="flex items-center gap-1">
                  <button
                    onClick={() => onSelectDate(day.date, year, month)}
                    className="px-2 py-1 bg-blue-100 hover:bg-blue-200 rounded text-xs font-medium text-blue-800 transition-colors min-h-[44px] flex items-center"
                    data-testid={`missing-break-day-${day.date}`}
                  >
                    {formatDateForDisplay(day.date, { day: "numeric", month: "short" })}
                    <span className="text-blue-600 ml-1">
                      (noch {missingMinutes} min)
                    </span>
                  </button>
                  {onAddBreak && (
                    <button
                      onClick={() => onAddBreak(day.date)}
                      className="px-2 py-1 bg-teal-100 hover:bg-teal-200 rounded text-xs font-medium text-teal-700 transition-colors min-h-[44px] flex items-center gap-1"
                      data-testid={`add-break-${day.date}`}
                      title="Pause nachtragen"
                    >
                      <Plus className="w-3 h-3" />
                      Nachtragen
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
