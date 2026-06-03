import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  formatDateISO,
  formatGermanDate,
  startOfWeekMonday,
  addDaysToDate,
  addWeeksToDate,
  isSameLocalDay,
} from "@shared/utils/datetime";
import { ChevronsLeft, ChevronsRight, CalendarCheck, ChevronDown } from "lucide-react";
import { getHolidayMap } from "@shared/utils/holidays";
import { iconSize } from "@/design-system";
import { useWeekAppointmentCounts } from "@/features/appointments";
import { MonthYearPicker } from "./month-year-picker";
import { DayButton } from "./day-button";

interface WeekStripProps {
  selectedDate: Date;
  setSelectedDate: React.Dispatch<React.SetStateAction<Date>>;
}

export function WeekStrip({ selectedDate, setSelectedDate }: WeekStripProps) {
  const dateString = formatDateISO(selectedDate);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipeTriggeredRef = useRef(false);

  const today = useMemo(() => new Date(), []);
  const todayString = formatDateISO(today);
  const isToday = todayString === dateString;

  const weekDays = useMemo(() => {
    const weekStart = startOfWeekMonday(selectedDate);
    return Array.from({ length: 7 }, (_, i) => addDaysToDate(weekStart, i));
  }, [selectedDate]);

  const weekDateStrings = useMemo(() =>
    weekDays.map(d => formatDateISO(d)),
    [weekDays]
  );

  const { data: weekAppointmentCounts } = useWeekAppointmentCounts(weekDateStrings);

  const holidayMap = useMemo(() => {
    const years = new Set(weekDays.map(d => d.getFullYear()));
    const map = new Map<string, string>();
    for (const year of Array.from(years)) {
      const yearMap = getHolidayMap(year);
      yearMap.forEach((v, k) => map.set(k, v));
    }
    return map;
  }, [weekDays]);

  const goToPreviousWeek = () => setSelectedDate(prev => addWeeksToDate(prev, -1));
  const goToNextWeek = () => setSelectedDate(prev => {
    const weekStart = startOfWeekMonday(prev);
    return addDaysToDate(weekStart, 7);
  });

  const goToToday = () => setSelectedDate(new Date());
  const monthLabel = formatGermanDate(selectedDate, "MMMM yyyy");

  return (
    <div className="mb-6 animate-in fade-in duration-300">
      <div className="flex items-center justify-between mb-2 px-1 min-h-[28px]">
        <Popover open={showMonthPicker} onOpenChange={setShowMonthPicker}>
          <PopoverTrigger asChild>
            <button
              className="text-sm font-medium text-muted-foreground capitalize hover:text-foreground transition-colors -ml-1 px-1 py-0.5 rounded hover:bg-muted/60 inline-flex items-center gap-1"
              data-testid="button-month-label"
              aria-label={`${monthLabel} — Monat ändern`}
            >
              <span data-testid="text-month-label">{monthLabel}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-3" data-testid="popover-month-picker">
            <MonthYearPicker
              initialDate={selectedDate}
              onSelect={(date) => {
                setSelectedDate(date);
                setShowMonthPicker(false);
              }}
            />
          </PopoverContent>
        </Popover>
        {!isToday && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-3 border-primary/30 text-primary font-medium"
            onClick={goToToday}
            data-testid="button-go-today"
          >
            <CalendarCheck className="h-3.5 w-3.5 mr-1" />
            Heute
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0"
          onClick={goToPreviousWeek}
          data-testid="button-prev-week"
          title="Vorherige Woche"
          aria-label="Vorherige Woche"
        >
          <ChevronsLeft className={iconSize.sm} />
        </Button>

        <div
          className="flex gap-1 justify-center flex-1 touch-pan-y"
          onTouchStart={(e) => {
            swipeTriggeredRef.current = false;
            if (e.touches.length !== 1) return;
            swipeStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          }}
          onTouchEnd={(e) => {
            if (!swipeStartRef.current) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - swipeStartRef.current.x;
            const dy = t.clientY - swipeStartRef.current.y;
            swipeStartRef.current = null;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
              swipeTriggeredRef.current = true;
              if (dx < 0) goToNextWeek();
              else goToPreviousWeek();
            }
          }}
          onTouchCancel={() => {
            swipeStartRef.current = null;
          }}
          onClickCapture={(e) => {
            if (swipeTriggeredRef.current) {
              e.stopPropagation();
              e.preventDefault();
              swipeTriggeredRef.current = false;
            }
          }}
          data-testid="weekday-strip"
        >
          {weekDays.map((day, index) => {
            const dayStr = formatDateISO(day);
            const isSelected = dayStr === dateString;
            const isDayToday = isSameLocalDay(day, today);
            const appointmentCount = weekAppointmentCounts?.[dayStr] || 0;
            const holidayName = holidayMap.get(dayStr);

            return (
              <DayButton
                key={dayStr}
                dayStr={dayStr}
                day={day}
                index={index}
                isSelected={isSelected}
                isDayToday={isDayToday}
                appointmentCount={appointmentCount}
                holidayName={holidayName}
                isWeekend={index >= 5}
                onSelect={setSelectedDate}
              />
            );
          })}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0"
          onClick={goToNextWeek}
          data-testid="button-next-week"
          title="Nächste Woche"
          aria-label="Nächste Woche"
        >
          <ChevronsRight className={iconSize.sm} />
        </Button>
      </div>
    </div>
  );
}
