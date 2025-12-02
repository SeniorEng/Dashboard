import { Layout } from "@/components/layout";
import { AppointmentCard } from "@/components/appointment-card";
import { useAppointments } from "@/lib/api";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { Calendar as CalendarIcon, Loader2 } from "lucide-react";

export default function Dashboard() {
  const { data: appointments, isLoading, error } = useAppointments();
  const today = new Date();
  const formattedDate = format(today, "EEEE, d. MMMM", { locale: de });
  
  // Sort appointments: in-progress first, then by time
  const sortedAppointments = appointments ? [...appointments].sort((a, b) => {
    if (a.status === 'in-progress') return -1;
    if (b.status === 'in-progress') return 1;
    return a.time.localeCompare(b.time);
  }) : [];

  return (
    <Layout>
      <div className="mb-8 animate-in slide-in-from-top-4 duration-500">
        <h1 className="text-3xl font-bold text-foreground tracking-tight mb-1">Hello, Sarah!</h1>
        <div className="flex items-center text-muted-foreground">
          <CalendarIcon className="w-4 h-4 mr-2 text-primary" />
          <span className="capitalize font-medium">{formattedDate}</span>
        </div>
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground/90">Your Schedule</h2>
          {!isLoading && (
            <span className="text-xs font-medium px-2.5 py-1 bg-primary/10 text-primary rounded-full">
              {sortedAppointments.length} visits
            </span>
          )}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {error && (
          <div className="text-center py-12 text-destructive">
            <p>Failed to load appointments. Please try again.</p>
          </div>
        )}

        {!isLoading && !error && (
          <div className="space-y-4 animate-in slide-in-from-bottom-4 duration-700 fade-in fill-mode-backwards">
            {sortedAppointments.map((apt) => (
              <AppointmentCard key={apt.id} appointment={apt} />
            ))}
          </div>
        )}

        {!isLoading && !error && sortedAppointments.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <p>No appointments scheduled for today.</p>
          </div>
        )}
      </div>
    </Layout>
  );
}
