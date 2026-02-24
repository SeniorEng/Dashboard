import { useState, useMemo } from "react";
import { Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments, useWeekAppointmentCounts, AppointmentList } from "@/features/appointments";
import { Button } from "@/components/ui/button";
import { format, addDays, startOfWeek, subWeeks, isSameDay } from "date-fns";
import { de } from "date-fns/locale";
import { Plus, ChevronsLeft, ChevronsRight, CalendarCheck } from "lucide-react";
import { parseLocalDate } from "@shared/utils/datetime";
import { getHolidayMap } from "@shared/utils/holidays";
import { iconSize } from "@/design-system";

const WEEKDAY_NAMES_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

interface DayButtonProps {
  dayStr: string;
  day: Date;
  index: number;
  isSelected: boolean;
  isDayToday: boolean;
  appointmentCount: number;
  holidayName?: string;
  onSelect: (day: Date) => void;
}

function DayButton({ dayStr, day, index, isSelected, isDayToday, appointmentCount, holidayName, onSelect }: DayButtonProps) {
  const hasAppointments = appointmentCount > 0;

  let bgClass: string;
  if (isSelected) {
    bgClass = holidayName
      ? "bg-red-600 text-white shadow-md"
      : "bg-primary text-primary-foreground shadow-md";
  } else if (holidayName) {
    bgClass = "bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100";
  } else if (isDayToday) {
    bgClass = hasAppointments ? "bg-primary/15 text-primary ring-1 ring-primary/30" : "bg-primary/10 text-primary hover:bg-primary/20";
  } else if (hasAppointments) {
    bgClass = "bg-primary/8 ring-1 ring-primary/20 hover:bg-primary/15";
  } else {
    bgClass = "bg-background hover:bg-muted";
  }

  return (
    <button
      onClick={() => onSelect(day)}
      className={`relative flex flex-col items-center justify-center flex-1 max-w-[44px] h-14 rounded-lg transition-all ${bgClass}`}
      data-testid={`weekday-${dayStr}`}
      title={holidayName || undefined}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
        {WEEKDAY_NAMES_SHORT[index]}
      </span>
      <span className={`text-base font-semibold ${isDayToday && !isSelected && !holidayName ? "text-primary" : ""}`}>
        {format(day, "d")}
      </span>
      <span className={`text-[9px] font-semibold leading-none h-[10px] flex items-center justify-center ${
        hasAppointments
          ? isSelected ? "text-white/80" : holidayName ? "text-red-600" : "text-primary"
          : holidayName
            ? isSelected ? "text-white/70" : "text-red-400"
            : "opacity-0"
      }`} aria-hidden={!hasAppointments && !holidayName}>
        {hasAppointments ? appointmentCount : holidayName ? "●" : "\u00A0"}
      </span>
    </button>
  );
}

export default function Dashboard() {
  const searchString = useSearch();
  const [selectedDate, setSelectedDate] = useState(() => {
    const params = new URLSearchParams(searchString);
    const dateParam = params.get("date");
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      const parsed = parseLocalDate(dateParam);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  });
  const dateString = format(selectedDate, "yyyy-MM-dd");
  
  const { data: appointments, isLoading, error, refetch } = useAppointments(dateString);
  
  const today = useMemo(() => new Date(), []);
  const todayString = format(today, "yyyy-MM-dd");
  const isToday = todayString === dateString;

  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [selectedDate]);

  const weekDateStrings = useMemo(() => 
    weekDays.map(d => format(d, "yyyy-MM-dd")), 
    [weekDays]
  );
  
  const { data: weekAppointmentCounts } = useWeekAppointmentCounts(weekDateStrings);

  const holidayMap = useMemo(() => {
    const years = new Set(weekDays.map(d => d.getFullYear()));
    const map = new Map<string, string>();
    for (const year of years) {
      const yearMap = getHolidayMap(year);
      yearMap.forEach((v, k) => map.set(k, v));
    }
    return map;
  }, [weekDays]);

  const selectedHoliday = holidayMap.get(dateString);

  const goToPreviousWeek = () => setSelectedDate(prev => subWeeks(prev, 1));
  const goToNextWeek = () => setSelectedDate(prev => {
    const weekStart = startOfWeek(prev, { weekStartsOn: 1 });
    return addDays(weekStart, 7);
  });

  const goToToday = () => setSelectedDate(new Date());
  const monthLabel = format(selectedDate, "MMMM yyyy", { locale: de });

  return (
    <Layout>
      <div className="mb-6 animate-in fade-in duration-300">
        <div className="flex items-center justify-between mb-2 px-1">
          <span className="text-sm font-medium text-muted-foreground capitalize" data-testid="text-month-label">
            {monthLabel}
          </span>
          <Button
            variant={isToday ? "ghost" : "outline"}
            size="sm"
            className={`h-7 text-xs px-3 ${isToday ? "text-muted-foreground/50 cursor-default" : "border-primary/30 text-primary font-medium"}`}
            onClick={goToToday}
            disabled={isToday}
            data-testid="button-go-today"
          >
            <CalendarCheck className="h-3.5 w-3.5 mr-1" />
            Heute
          </Button>
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
          
          <div className="flex gap-1 justify-center flex-1">
            {weekDays.map((day, index) => {
              const dayStr = format(day, "yyyy-MM-dd");
              const isSelected = dayStr === dateString;
              const isDayToday = isSameDay(day, today);
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

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground/90" data-testid="text-date">
              {isToday 
                ? `Heute, ${format(selectedDate, "d. MMMM", { locale: de })}` 
                : format(selectedDate, "EEEE, d. MMMM", { locale: de })}
            </h2>
            {selectedHoliday && (
              <p className="text-sm font-medium text-red-600" data-testid="text-holiday">
                {selectedHoliday}
              </p>
            )}
          </div>
          <Link href="/new-appointment">
            <Button size="sm" className="shadow-lg shadow-primary/20" data-testid="button-new-appointment">
              <Plus className={`${iconSize.sm} mr-1`} /> Neuer Termin
            </Button>
          </Link>
        </div>

        <AppointmentList 
          appointments={appointments} 
          isLoading={isLoading} 
          error={error}
          onRetry={() => refetch()}
        />
      </div>
    </Layout>
  );
}
