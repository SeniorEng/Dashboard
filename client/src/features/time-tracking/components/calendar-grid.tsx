import { useMemo } from "react";
import { Coffee, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { iconSize } from "@/design-system";
import { WEEKDAY_NAMES } from "../constants";
import { formatDateISO } from "@shared/utils/datetime";
import { getHolidayMap } from "@shared/utils/holidays";

interface CalendarDay {
  date: string;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  holidayName?: string;
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
}: CalendarGridProps) {
  const todayStr = useMemo(() => formatDateISO(new Date()), []);

  const holidayMap = useMemo(() => {
    const years = new Set([selectedYear]);
    if (selectedMonth === 1) years.add(selectedYear - 1);
    if (selectedMonth === 12) years.add(selectedYear + 1);
    const map = new Map<string, string>();
    for (const year of Array.from(years)) {
      const yearMap = getHolidayMap(year);
      yearMap.forEach((v, k) => map.set(k, v));
    }
    return map;
  }, [selectedYear, selectedMonth]);

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
      const dateStr = formatDateISO(date);
      days.push({
        date: dateStr,
        day,
        isCurrentMonth: false,
        isToday: false,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
        holidayName: holidayMap.get(dateStr),
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
        holidayName: holidayMap.get(dateStr),
      });
    }

    const remainingDays = 42 - days.length;
    for (let day = 1; day <= remainingDays; day++) {
      const date = new Date(selectedYear, selectedMonth, day);
      const dateStr = formatDateISO(date);
      days.push({
        date: dateStr,
        day,
        isCurrentMonth: false,
        isToday: false,
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
        holidayName: holidayMap.get(dateStr),
      });
    }

    return days;
  }, [selectedYear, selectedMonth, todayStr, holidayMap]);

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
              {calendarDays.map(({ date, day, isCurrentMonth, isToday, isWeekend, holidayName }) => {
                const hasAppointments = (appointmentsByDate[date]?.length || 0) > 0;
                const dateEntries = entriesByDate[date] as Array<{ entryType?: string }> | undefined;
                const hasOtherEntries = dateEntries ? dateEntries.some(e => e.entryType !== "verfuegbar") : false;
                const hasAvailability = dateEntries ? dateEntries.some(e => e.entryType === "verfuegbar") : false;
                const isSelected = date === selectedDate;
                const hasMissingBreak = missingBreakDates.has(date);
                const isHoliday = !!holidayName && isCurrentMonth;

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
                      ${isHoliday && !isSelected ? "bg-red-50 ring-1 ring-red-200" : ""}
                      ${isToday && !isHoliday ? "ring-2 ring-teal-500" : ""}
                      ${isToday && isHoliday ? "ring-2 ring-red-400" : ""}
                      ${isSelected && !isWeekend && isHoliday ? "ring-2 ring-red-500 bg-red-100" : ""}
                      ${isSelected && !isWeekend && !isHoliday ? "ring-2 ring-teal-600" : ""}
                      ${!isSelected && !isWeekend && !isHoliday ? "hover:bg-gray-100" : ""}
                      ${!isSelected && isHoliday ? "hover:bg-red-100" : ""}
                      ${hasMissingBreak && !isHoliday ? "bg-blue-50 border-2 border-blue-300" : ""}
                    `}
                    data-testid={`calendar-day-${date}`}
                    title={isWeekend && isCurrentMonth ? "Wochenende – keine Einträge möglich" : holidayName ? `Feiertag: ${holidayName}` : hasMissingBreak ? "Fehlende Pausendokumentation" : undefined}
                  >
                    <span className={`font-medium ${isHoliday ? "text-red-700" : ""} ${isToday && !isHoliday ? "text-teal-700" : ""} ${hasMissingBreak && !isHoliday ? "text-blue-800" : ""} ${isWeekend && isCurrentMonth ? "text-gray-400" : ""}`}>{day}</span>
                    {hasMissingBreak && !isHoliday && (
                      <div className="absolute top-1 right-1">
                        <Coffee className={`${iconSize.xs} text-blue-500`} />
                      </div>
                    )}
                    {isHoliday && (
                      <div className="absolute bottom-1 left-1/2 -translate-x-1/2">
                        <div className="w-1.5 h-1.5 rounded-full bg-red-400" />
                      </div>
                    )}
                    {!isHoliday && (hasAppointments || hasOtherEntries || hasAvailability) && (
                      <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-0.5">
                        {hasAppointments && (
                          <div className="w-1.5 h-1.5 rounded-full bg-teal-500" title="Kundentermine" />
                        )}
                        {hasOtherEntries && (
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Andere Einträge" />
                        )}
                        {hasAvailability && (
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="Verfügbar" />
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
