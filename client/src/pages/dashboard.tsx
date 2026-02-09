import { useState, useMemo } from "react";
import { Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments, useWeekAppointmentCounts, AppointmentList } from "@/features/appointments";
import { Button } from "@/components/ui/button";
import { format, addDays, startOfWeek, addWeeks, subWeeks, isSameDay } from "date-fns";
import { de } from "date-fns/locale";
import { Plus, ChevronsLeft, ChevronsRight, Loader2 } from "lucide-react";
import { parseLocalDate } from "@shared/utils/datetime";
import { iconSize } from "@/design-system";
import { ErrorState } from "@/components/patterns/error-state";

const WEEKDAY_NAMES_SHORT = ["Mo", "Di", "Mi", "Do", "Fr"];

interface DayButtonProps {
  dayStr: string;
  day: Date;
  index: number;
  isSelected: boolean;
  isDayToday: boolean;
  appointmentCount: number;
  onSelect: (day: Date) => void;
}

function DayButton({ dayStr, day, index, isSelected, isDayToday, appointmentCount, onSelect }: DayButtonProps) {
  const hasAppointments = appointmentCount > 0;

  let bgClass: string;
  if (isSelected) {
    bgClass = "bg-primary text-primary-foreground shadow-md";
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
      className={`relative flex flex-col items-center justify-center flex-1 max-w-[56px] h-14 rounded-lg transition-all ${bgClass}`}
      data-testid={`weekday-${dayStr}`}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
        {WEEKDAY_NAMES_SHORT[index]}
      </span>
      <span className={`text-base font-semibold ${isDayToday && !isSelected ? "text-primary" : ""}`}>
        {format(day, "d")}
      </span>
      {hasAppointments && (
        <span className={`text-[9px] font-semibold leading-none ${isSelected ? "text-primary-foreground/80" : "text-primary"}`}>
          {appointmentCount === 1 ? "1" : appointmentCount}
        </span>
      )}
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
  const [showTwoWeeks, setShowTwoWeeks] = useState(false);
  const dateString = format(selectedDate, "yyyy-MM-dd");
  
  const { data: appointments, isLoading, error, refetch } = useAppointments(dateString);
  
  const today = useMemo(() => new Date(), []);
  const todayString = format(today, "yyyy-MM-dd");
  const isToday = todayString === dateString;

  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const days = Array.from({ length: 5 }, (_, i) => addDays(weekStart, i));
    if (showTwoWeeks) {
      const week2Start = addWeeks(weekStart, 1);
      days.push(...Array.from({ length: 5 }, (_, i) => addDays(week2Start, i)));
    }
    return days;
  }, [selectedDate, showTwoWeeks]);

  const weekDateStrings = useMemo(() => 
    weekDays.map(d => format(d, "yyyy-MM-dd")), 
    [weekDays]
  );
  
  const { data: weekAppointmentCounts } = useWeekAppointmentCounts(weekDateStrings);

  const goToPreviousWeek = () => setSelectedDate(prev => subWeeks(prev, 1));
  const goToNextWeek = () => setSelectedDate(prev => addWeeks(prev, 1));

  const week1Days = weekDays.slice(0, 5);
  const week2Days = showTwoWeeks ? weekDays.slice(5, 10) : [];

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
            <button
              onClick={() => setShowTwoWeeks(false)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                !showTwoWeeks ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="toggle-1-week"
            >
              1 Wo
            </button>
            <button
              onClick={() => setShowTwoWeeks(true)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                showTwoWeeks ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="toggle-2-weeks"
            >
              2 Wo
            </button>
          </div>
          <Link href="/new-appointment">
            <Button size="sm" className="shadow-lg shadow-primary/20" data-testid="button-new-appointment">
              <Plus className={`${iconSize.sm} mr-1`} /> Neuer Termin
            </Button>
          </Link>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={goToPreviousWeek}
            data-testid="button-prev-week"
            title="Vorherige Woche"
          >
            <ChevronsLeft className={iconSize.sm} />
          </Button>
          
          <div className="flex-1 space-y-1">
            <div className="flex gap-1 justify-center">
              {week1Days.map((day, index) => {
                const dayStr = format(day, "yyyy-MM-dd");
                const isSelected = dayStr === dateString;
                const isDayToday = isSameDay(day, today);
                const appointmentCount = weekAppointmentCounts?.[dayStr] || 0;
                
                return (
                  <DayButton
                    key={dayStr}
                    dayStr={dayStr}
                    day={day}
                    index={index}
                    isSelected={isSelected}
                    isDayToday={isDayToday}
                    appointmentCount={appointmentCount}
                    onSelect={setSelectedDate}
                  />
                );
              })}
            </div>
            
            {showTwoWeeks && week2Days.length > 0 && (
              <div className="flex gap-1 justify-center">
                {week2Days.map((day, index) => {
                  const dayStr = format(day, "yyyy-MM-dd");
                  const isSelected = dayStr === dateString;
                  const isDayToday = isSameDay(day, today);
                  const appointmentCount = weekAppointmentCounts?.[dayStr] || 0;
                  
                  return (
                    <DayButton
                      key={dayStr}
                      dayStr={dayStr}
                      day={day}
                      index={index}
                      isSelected={isSelected}
                      isDayToday={isDayToday}
                      appointmentCount={appointmentCount}
                      onSelect={setSelectedDate}
                    />
                  );
                })}
              </div>
            )}
          </div>
          
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={goToNextWeek}
            data-testid="button-next-week"
            title="Nächste Woche"
          >
            <ChevronsRight className={iconSize.sm} />
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground/90" data-testid="text-date">
            {isToday 
              ? `Heute, ${format(selectedDate, "d. MMMM", { locale: de })}` 
              : format(selectedDate, "EEEE, d. MMMM", { locale: de })}
          </h2>
          {!isLoading && appointments && (
            <span className="text-xs font-medium px-2.5 py-1 bg-primary/10 text-primary rounded-full" data-testid="text-visit-count">
              {appointments.length} {appointments.length === 1 ? 'Termin' : 'Termine'}
            </span>
          )}
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
