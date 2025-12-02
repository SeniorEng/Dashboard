import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointments, AppointmentList } from "@/features/appointments";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { Calendar as CalendarIcon, Plus } from "lucide-react";

export default function Dashboard() {
  const { data: appointments, isLoading, error } = useAppointments();
  const today = new Date();
  const formattedDate = format(today, "EEEE, d. MMMM", { locale: de });

  return (
    <Layout>
      <div className="mb-8 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground tracking-tight mb-1" data-testid="text-greeting">
              Hallo, Sarah!
            </h1>
            <div className="flex items-center text-muted-foreground">
              <CalendarIcon className="w-4 h-4 mr-2 text-primary" />
              <span className="capitalize font-medium" data-testid="text-date">{formattedDate}</span>
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
          <h2 className="text-lg font-semibold text-foreground/90">Dein Tagesplan</h2>
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
