import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments, useWeekAppointmentCounts, AppointmentList } from "@/features/appointments";
import { Button } from "@/components/ui/button";
import { format, addDays, startOfWeek, addWeeks, subWeeks, isSameDay } from "date-fns";
import { de } from "date-fns/locale";
import { Plus, ChevronsLeft, ChevronsRight, AlertCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

const WEEKDAY_NAMES_SHORT = ["Mo", "Di", "Mi", "Do", "Fr"];

export default function Dashboard() {
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [showTwoWeeks, setShowTwoWeeks] = useState(false);
  const dateString = format(selectedDate, "yyyy-MM-dd");
  
  const { data: appointments, isLoading, error } = useAppointments(dateString);
  
  const today = useMemo(() => new Date(), []);
  const todayString = format(today, "yyyy-MM-dd");
  const isToday = todayString === dateString;

  // Fetch undocumented past appointments
  const { data: undocumentedAppointments } = useQuery({
    queryKey: ["appointments", "undocumented"],
    queryFn: async () => {
      const response = await fetch(`/api/appointments/undocumented`);
      if (!response.ok) {
        throw new Error("Failed to fetch undocumented appointments");
      }
      return response.json();
    },
    staleTime: 60000,
  });
  const undocumentedCount = undocumentedAppointments?.length || 0;

  // Get weekdays only (Monday to Friday) for the week(s) containing selectedDate
  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 }); // Monday
    const days = Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)); // Mo-Fr week 1
    if (showTwoWeeks) {
      const week2Start = addWeeks(weekStart, 1);
      days.push(...Array.from({ length: 5 }, (_, i) => addDays(week2Start, i))); // Mo-Fr week 2
    }
    return days;
  }, [selectedDate, showTwoWeeks]);

  // Get date strings for the week(s) to fetch appointment counts
  const weekDateStrings = useMemo(() => 
    weekDays.map(d => format(d, "yyyy-MM-dd")), 
    [weekDays]
  );
  
  // Fetch appointment counts for the week(s)
  const { data: weekAppointmentCounts } = useWeekAppointmentCounts(weekDateStrings);

  const goToPreviousWeek = () => setSelectedDate(prev => subWeeks(prev, 1));
  const goToNextWeek = () => setSelectedDate(prev => addWeeks(prev, 1));

  // Split week days into rows for display
  const week1Days = weekDays.slice(0, 5);
  const week2Days = showTwoWeeks ? weekDays.slice(5, 10) : [];

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        {/* Undocumented appointments banner */}
        {undocumentedCount > 0 && (
          <Link href="/appointments?filter=undocumented">
            <div 
              className="flex items-center gap-2 px-3 py-2 mb-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 hover:bg-amber-100 transition-colors cursor-pointer"
              data-testid="banner-undocumented"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="text-sm font-medium">
                {undocumentedCount} {undocumentedCount === 1 ? "offene Dokumentation" : "offene Dokumentationen"}
              </span>
            </div>
          </Link>
        )}

        {/* Header with week toggle and new appointment button */}
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
              <Plus className="w-4 h-4 mr-1" /> Neuer Termin
            </Button>
          </Link>
        </div>

        {/* Week Navigation Strip */}
        <div className="flex items-center gap-1">
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
          
          <div className="flex-1 space-y-1">
            {/* Week 1 */}
            <div className="flex gap-1 justify-center">
              {week1Days.map((day, index) => {
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
            
            {/* Week 2 (if showing 2 weeks) */}
            {showTwoWeeks && week2Days.length > 0 && (
              <div className="flex gap-1 justify-center">
                {week2Days.map((day, index) => {
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
