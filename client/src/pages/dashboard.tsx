import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments, useWeekAppointmentCounts, AppointmentList } from "@/features/appointments";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { format, addDays, subDays, startOfWeek, addWeeks, subWeeks, isSameDay } from "date-fns";
import { de } from "date-fns/locale";
import { Calendar as CalendarIcon, Plus, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

const WEEKDAY_NAMES_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export default function Dashboard() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const dateString = format(selectedDate, "yyyy-MM-dd");
  
  const { data: appointments, isLoading, error } = useAppointments(dateString);
  const formattedDate = format(selectedDate, "EEEE, d. MMMM", { locale: de });
  
  const today = useMemo(() => new Date(), []);
  const isToday = format(today, "yyyy-MM-dd") === dateString;

  // Get week days (Monday to Sunday) for the week containing selectedDate
  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 }); // Monday
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [selectedDate]);

  // Get date strings for the week to fetch appointment counts
  const weekDateStrings = useMemo(() => 
    weekDays.map(d => format(d, "yyyy-MM-dd")), 
    [weekDays]
  );
  
  // Fetch appointment counts for the week
  const { data: weekAppointmentCounts } = useWeekAppointmentCounts(weekDateStrings);

  const goToPreviousDay = () => setSelectedDate(prev => subDays(prev, 1));
  const goToNextDay = () => setSelectedDate(prev => addDays(prev, 1));
  const goToPreviousWeek = () => setSelectedDate(prev => subWeeks(prev, 1));
  const goToNextWeek = () => setSelectedDate(prev => addWeeks(prev, 1));
  const goToToday = () => setSelectedDate(new Date());

  return (
    <Layout>
      <div className="mb-8 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground tracking-tight mb-1" data-testid="text-greeting">
              Hallo, {user?.displayName?.split(" ")[0] || "Mitarbeiter"}!
            </h1>
            <div className="flex items-center gap-2 mt-2">
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8"
                onClick={goToPreviousDay}
                data-testid="button-prev-day"
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <div 
                className="flex items-center text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                onClick={goToToday}
                data-testid="button-today"
              >
                <CalendarIcon className="w-4 h-4 mr-2 text-primary" />
                <span className="capitalize font-medium" data-testid="text-date">{formattedDate}</span>
              </div>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8"
                onClick={goToNextDay}
                data-testid="button-next-day"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <Link href="/new-appointment">
            <Button size="sm" className="shadow-lg shadow-primary/20" data-testid="button-new-appointment">
              <Plus className="w-4 h-4 mr-1" /> Neuer Termin
            </Button>
          </Link>
        </div>

        {/* Week Navigation Strip */}
        <div className="flex items-center gap-1 mt-4 overflow-x-auto pb-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={goToPreviousWeek}
            data-testid="button-prev-week"
            title="Vorherige Woche"
          >
            <ChevronsLeft className="w-4 h-4" />
          </Button>
          
          <div className="flex gap-1 flex-1 justify-center">
            {weekDays.map((day, index) => {
              const dayStr = format(day, "yyyy-MM-dd");
              const isSelected = dayStr === dateString;
              const isDayToday = isSameDay(day, today);
              const isWeekend = index >= 5;
              const appointmentCount = weekAppointmentCounts?.[dayStr] || 0;
              
              return (
                <button
                  key={dayStr}
                  onClick={() => setSelectedDate(day)}
                  className={`
                    relative flex flex-col items-center justify-center min-w-[44px] h-14 px-2 rounded-lg transition-all
                    ${isSelected 
                      ? "bg-primary text-primary-foreground shadow-md" 
                      : isDayToday 
                        ? "bg-primary/10 text-primary hover:bg-primary/20" 
                        : isWeekend 
                          ? "bg-muted/50 text-muted-foreground hover:bg-muted" 
                          : "bg-background hover:bg-muted"
                    }
                  `}
                  data-testid={`weekday-${dayStr}`}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
                    {WEEKDAY_NAMES_SHORT[index]}
                  </span>
                  <span className={`text-lg font-semibold ${isDayToday && !isSelected ? "text-primary" : ""}`}>
                    {format(day, "d")}
                  </span>
                  {appointmentCount > 0 && (
                    <div 
                      className={`absolute -bottom-0.5 left-1/2 -translate-x-1/2 flex gap-0.5 ${isSelected ? "opacity-80" : ""}`}
                    >
                      {appointmentCount <= 3 ? (
                        Array.from({ length: appointmentCount }).map((_, i) => (
                          <div 
                            key={i}
                            className={`w-1 h-1 rounded-full ${isSelected ? "bg-primary-foreground" : "bg-primary"}`} 
                          />
                        ))
                      ) : (
                        <div className={`text-[8px] font-bold ${isSelected ? "text-primary-foreground" : "text-primary"}`}>
                          {appointmentCount}
                        </div>
                      )}
                    </div>
                  )}
                </button>
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
          >
            <ChevronsRight className="w-4 h-4" />
          </Button>
        </div>

        {/* Quick "Today" button when not on current week */}
        {!weekDays.some(d => isSameDay(d, today)) && (
          <div className="flex justify-center mt-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={goToToday}
              data-testid="button-go-today"
            >
              <CalendarIcon className="w-3 h-3 mr-1" />
              Zurück zu Heute
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground/90">
            {isToday ? "Dein Tagesplan" : `Termine am ${format(selectedDate, "d. MMMM", { locale: de })}`}
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
        />
      </div>
    </Layout>
  );
}
