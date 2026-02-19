import { useMemo } from "react";
import { Coffee, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { iconSize } from "@/design-system";
import { WEEKDAY_NAMES } from "../constants";
import { formatDateISO } from "@shared/utils/datetime";

interface CalendarDay {
  date: string;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
}

interface CalendarGridProps {
  selectedYear: number;
  selectedMonth: number;
  selectedDate: string | null;
  entriesByDate: Record<string, unknown[]>;
  appointmentsByDate: Record<string, unknown[]>;
  missingBreakDates: Set<string>;
  isLoading: boolean;
  onDayClick: (date: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
}

export function CalendarGrid({
  selectedYear,
  selectedMonth,
  selectedDate,
  entriesByDate,
  appointmentsByDate,
  missingBreakDates,
  isLoading,
  onDayClick,
  onPrevMonth,
  onNextMonth,
}: CalendarGridProps) {
  const todayStr = useMemo(() => formatDateISO(new Date()), []);

  const calendarDays = useMemo(() => {
    const firstDay = new Date(selectedYear, selectedMonth - 1, 1);
    const lastDay = new Date(selectedYear, selectedMonth, 0);
    const daysInMonth = lastDay.getDate();
    const startDayOfWeek = firstDay.getDay();

    const days: CalendarDay[] = [];

    const prevMonthLastDay = new Date(selectedYear, selectedMonth - 1, 0).getDate();
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const day = prevMonthLastDay - i;
      const date = new Date(selectedYear, selectedMonth - 2, day);
      days.push({
        date: formatDateISO(date),
        day,
        isCurrentMonth: false,
        isToday: false,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
      });
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(selectedYear, selectedMonth - 1, day);
      const dateStr = formatDateISO(date);
      days.push({
        date: dateStr,
        day,
        isCurrentMonth: true,
        isToday: dateStr === todayStr,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
      });
    }

    const remainingDays = 42 - days.length;
    for (let day = 1; day <= remainingDays; day++) {
      const date = new Date(selectedYear, selectedMonth, day);
      days.push({
        date: formatDateISO(date),
        day,
        isCurrentMonth: false,
        isToday: false,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
      });
    }

    return days;
  }, [selectedYear, selectedMonth, todayStr]);

  return (
    <Card className="lg:col-span-2">
      <CardContent className="pt-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-7 gap-1 mb-2">
              {WEEKDAY_NAMES.map((day) => (
                <div key={day} className="text-center text-xs font-medium text-gray-500 py-2">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {calendarDays.map(({ date, day, isCurrentMonth, isToday, isWeekend }) => {
                const hasAppointments = (appointmentsByDate[date]?.length || 0) > 0;
                const hasOtherEntries = (entriesByDate[date]?.length || 0) > 0;
                const isSelected = date === selectedDate;
                const hasMissingBreak = missingBreakDates.has(date);

                return (
                  <button
                    key={date}
                    onClick={() => onDayClick(date)}
                    disabled={isWeekend && isCurrentMonth}
                    className={`
                      relative p-2 min-h-[60px] rounded-lg text-sm transition-colors
                      ${isCurrentMonth ? "bg-white" : "bg-gray-50 text-gray-400"}
                      ${isWeekend && isCurrentMonth ? "bg-gray-100 opacity-50 cursor-not-allowed" : ""}
                      ${isWeekend && !isCurrentMonth ? "opacity-30" : ""}
                      ${isToday ? "ring-2 ring-teal-500" : ""}
                      ${isSelected && !isWeekend ? "ring-2 ring-teal-600" : !isWeekend ? "hover:bg-gray-100" : ""}
                      ${hasMissingBreak ? "bg-blue-50 border-2 border-blue-300" : ""}
                    `}
                    data-testid={`calendar-day-${date}`}
                    title={isWeekend && isCurrentMonth ? "Wochenende – keine Einträge möglich" : hasMissingBreak ? "Fehlende Pausendokumentation" : undefined}
                  >
                    <span className={`font-medium ${isToday ? "text-teal-700" : ""} ${hasMissingBreak ? "text-blue-800" : ""} ${isWeekend && isCurrentMonth ? "text-gray-400" : ""}`}>{day}</span>
                    {hasMissingBreak && (
                      <div className="absolute top-1 right-1">
                        <Coffee className={`${iconSize.xs} text-blue-500`} />
                      </div>
                    )}
                    {(hasAppointments || hasOtherEntries) && (
                      <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-0.5">
                        {hasAppointments && (
                          <div className="w-1.5 h-1.5 rounded-full bg-teal-500" title="Kundentermine" />
                        )}
                        {hasOtherEntries && (
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Andere Einträge" />
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
