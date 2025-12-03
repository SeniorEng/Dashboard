import { useState } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments, AppointmentList } from "@/features/appointments";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { format, addDays, subDays } from "date-fns";
import { de } from "date-fns/locale";
import { Calendar as CalendarIcon, Plus, ChevronLeft, ChevronRight } from "lucide-react";

export default function Dashboard() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const dateString = format(selectedDate, "yyyy-MM-dd");
  
  const { data: appointments, isLoading, error } = useAppointments(dateString);
  const formattedDate = format(selectedDate, "EEEE, d. MMMM", { locale: de });
  
  const isToday = format(new Date(), "yyyy-MM-dd") === dateString;

  const goToPreviousDay = () => setSelectedDate(prev => subDays(prev, 1));
  const goToNextDay = () => setSelectedDate(prev => addDays(prev, 1));
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
              {!isToday && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="ml-2 text-xs"
                  onClick={goToToday}
                  data-testid="button-go-today"
                >
                  Heute
                </Button>
              )}
            </div>
          </div>
          <Link href="/new-appointment">
            <Button size="sm" className="shadow-lg shadow-primary/20" data-testid="button-new-appointment">
              <Plus className="w-4 h-4 mr-1" /> Neuer Termin
            </Button>
          </Link>
        </div>
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
