import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments, useWeekAppointmentCounts, AppointmentList } from "@/features/appointments";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { format, addDays, startOfWeek, addWeeks, subWeeks, isSameDay } from "date-fns";
import { de } from "date-fns/locale";
import { Plus, ChevronsLeft, ChevronsRight } from "lucide-react";

const WEEKDAY_NAMES_SHORT = ["Mo", "Di", "Mi", "Do", "Fr"];

export default function Dashboard() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const dateString = format(selectedDate, "yyyy-MM-dd");
  
  const { data: appointments, isLoading, error } = useAppointments(dateString);
  
  const today = useMemo(() => new Date(), []);
  const isToday = format(today, "yyyy-MM-dd") === dateString;

  // Get weekdays only (Monday to Friday) for the week containing selectedDate
  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 }); // Monday
    return Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)); // Mo-Fr only
  }, [selectedDate]);

  // Get date strings for the week to fetch appointment counts
  const weekDateStrings = useMemo(() => 
    weekDays.map(d => format(d, "yyyy-MM-dd")), 
    [weekDays]
  );
  
  // Fetch appointment counts for the week
  const { data: weekAppointmentCounts } = useWeekAppointmentCounts(weekDateStrings);

  const goToPreviousWeek = () => setSelectedDate(prev => subWeeks(prev, 1));
  const goToNextWeek = () => setSelectedDate(prev => addWeeks(prev, 1));

  return (
    <Layout>
      <div className="mb-8 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground tracking-tight" data-testid="text-greeting">
            Hallo, {user?.displayName?.split(" ")[0] || "Mitarbeiter"}!
          </h1>
          <Link href="/new-appointment">
            <Button size="sm" className="shadow-lg shadow-primary/20" data-testid="button-new-appointment">
              <Plus className="w-4 h-4 mr-1" /> Neuer Termin
            </Button>
          </Link>
        </div>

        {/* Week Navigation Strip - Mo-Fr only */}
        <div className="flex items-center gap-1 mt-4">
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
              const appointmentCount = weekAppointmentCounts?.[dayStr] || 0;
              
              return (
                <button
                  key={dayStr}
                  onClick={() => setSelectedDate(day)}
                  className={`
                    relative flex flex-col items-center justify-center flex-1 max-w-[56px] h-12 rounded-lg transition-all
                    ${isSelected 
                      ? "bg-primary text-primary-foreground shadow-md" 
                      : isDayToday 
                        ? "bg-primary/10 text-primary hover:bg-primary/20" 
                        : "bg-background hover:bg-muted"
                    }
                  `}
                  data-testid={`weekday-${dayStr}`}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
                    {WEEKDAY_NAMES_SHORT[index]}
                  </span>
                  <span className={`text-base font-semibold ${isDayToday && !isSelected ? "text-primary" : ""}`}>
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
        />
      </div>
    </Layout>
  );
}
