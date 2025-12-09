import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { 
  ArrowLeft, MapPin, Phone, Mail, User, Heart, 
  Calendar, Loader2, AlertCircle
} from "lucide-react";
import { iconSize } from "@/design-system";
import type { Customer } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { format, parseISO, isAfter, isBefore, startOfToday } from "date-fns";
import { de } from "date-fns/locale";

function formatAddress(customer: Customer): string {
  if (customer.strasse && customer.nr && customer.plz && customer.stadt) {
    return `${customer.strasse} ${customer.nr}, ${customer.plz} ${customer.stadt}`;
  }
  return customer.address || "";
}

function getPflegegradLabel(pflegegrad: number | null): string | null {
  if (!pflegegrad) return null;
  return `Pflegegrad ${pflegegrad}`;
}

function getPflegegradColor(pflegegrad: number | null): string {
  if (!pflegegrad) return "bg-gray-100 text-gray-600";
  if (pflegegrad <= 2) return "bg-green-100 text-green-700";
  if (pflegegrad <= 3) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

export default function CustomerDetailPage() {
  const [, params] = useRoute("/customer/:id");
  const customerId = params?.id ? parseInt(params.id, 10) : null;

  const { data: customer, isLoading: customerLoading, error: customerError } = useQuery<Customer>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}`);
      if (!res.ok) throw new Error("Kunde konnte nicht geladen werden");
      return res.json();
    },
    enabled: !!customerId,
  });

  const { data: appointments = [], isLoading: appointmentsLoading } = useQuery<AppointmentWithCustomer[]>({
    queryKey: ["appointments", "customer", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/appointments?customerId=${customerId}`);
      if (!res.ok) throw new Error("Termine konnten nicht geladen werden");
      return res.json();
    },
    enabled: !!customerId,
  });

  const today = startOfToday();
  const upcomingAppointments = appointments
    .filter(apt => isAfter(parseISO(apt.date), today) || apt.date === format(today, "yyyy-MM-dd"))
    .sort((a, b) => a.date.localeCompare(b.date));
  
  const pastAppointments = appointments
    .filter(apt => isBefore(parseISO(apt.date), today) && apt.date !== format(today, "yyyy-MM-dd"))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  if (customerLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (customerError || !customer) {
    return (
      <Layout>
        <div className="text-center py-12">
          <AlertCircle className={`${iconSize["2xl"]} text-destructive mx-auto mb-4`} />
          <p className="text-destructive font-medium">Kunde nicht gefunden</p>
          <Link href="/customers">
            <Button variant="outline" className="mt-4">
              Zurück zur Kundenliste
            </Button>
          </Link>
        </div>
      </Layout>
    );
  }

  const address = formatAddress(customer);
  const phone = customer.telefon ? formatPhoneForDisplay(customer.telefon) : null;
  const pflegegradLabel = getPflegegradLabel(customer.pflegegrad);

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/customers">
            <Button variant="ghost" size="icon" className="shrink-0" data-testid="button-back">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <h1 className="text-xl font-semibold text-foreground" data-testid="text-customer-name">
            {customer.name}
          </h1>
        </div>

        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <User className={`${iconSize.lg} text-primary`} />
              </div>
              <div className="flex-1 min-w-0 space-y-3">
                {pflegegradLabel && (
                  <Badge 
                    variant="secondary" 
                    className={`${getPflegegradColor(customer.pflegegrad)}`}
                  >
                    {pflegegradLabel}
                  </Badge>
                )}

                {address && (
                  <div className="flex items-start gap-2 text-sm">
                    <MapPin className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-primary/60`} />
                    <span className="text-muted-foreground">{address}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm">
                  <Phone className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                  {phone ? (
                    <a href={`tel:${customer.telefon}`} className="text-primary hover:underline">
                      {phone}
                    </a>
                  ) : (
                    <span className="text-muted-foreground/60">Keine Telefonnummer</span>
                  )}
                </div>

                {customer.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                    <a href={`mailto:${customer.email}`} className="text-primary hover:underline">
                      {customer.email}
                    </a>
                  </div>
                )}

                {customer.needs && customer.needs.length > 0 && (
                  <div className="flex items-start gap-2 pt-1">
                    <Heart className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-rose-400`} />
                    <div className="flex flex-wrap gap-1">
                      {customer.needs.map((need, index) => (
                        <Badge 
                          key={index} 
                          variant="outline" 
                          className="text-xs bg-rose-50 text-rose-700 border-rose-200"
                        >
                          {need}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {upcomingAppointments.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Calendar className={`${iconSize.md} text-primary`} />
              Anstehende Termine
            </h2>
            <div className="space-y-3">
              {upcomingAppointments.map((apt) => (
                <AppointmentCard key={apt.id} appointment={apt} showDate />
              ))}
            </div>
          </div>
        )}

        {pastAppointments.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-3 text-muted-foreground">
              Letzte Termine
            </h2>
            <div className="space-y-3 opacity-75">
              {pastAppointments.map((apt) => (
                <AppointmentCard key={apt.id} appointment={apt} showDate />
              ))}
            </div>
          </div>
        )}

        {upcomingAppointments.length === 0 && pastAppointments.length === 0 && !appointmentsLoading && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <Calendar className={`${iconSize.xl} text-muted-foreground/40 mb-3`} />
              <p className="text-muted-foreground">Keine Termine vorhanden</p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
