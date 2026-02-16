import { useRoute, Link, useSearch, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/patterns/status-badge";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { 
  ArrowLeft, MapPin, Phone, Mail, User, Heart, 
  Calendar, Loader2, AlertCircle, FileSignature, ChevronRight, X, Wallet,
  Cake, PhoneCall, Shield, PawPrint, ClipboardList, Stethoscope, Users, UserSearch,
  UserCheck, XCircle,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { ErrorState } from "@/components/patterns/error-state";
import type { Customer, CustomerContact } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { format, parseISO, isAfter, isBefore, startOfToday } from "date-fns";
import { de } from "date-fns/locale";
import { UNDOCUMENTED_STATUSES } from "@shared/domain/appointments";
import { CONTACT_TYPE_LABELS } from "@shared/domain/customers";
import { formatAddress } from "@shared/utils/format";

interface CustomerDetails {
  contacts: CustomerContact[];
  insurance: {
    providerName: string;
    ikNummer?: string;
    versichertennummer: string;
  } | null;
  contract: {
    vereinbarteLeistungen: string | null;
    contractStart: string;
    status: string;
  } | null;
}

export default function CustomerDetailPage() {
  const [, params] = useRoute("/customer/:id");
  const customerId = params?.id ? parseInt(params.id, 10) : null;
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const filterUndocumented = searchParams.get("filter") === "undocumented";
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canConvert = user?.isAdmin || user?.roles?.includes("erstberatung");

  const { data: customer, isLoading: customerLoading, error: customerError, refetch: refetchCustomer } = useQuery<Customer>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}`);
      if (!res.ok) throw new Error("Kunde konnte nicht geladen werden");
      return res.json();
    },
    enabled: !!customerId,
  });

  const { data: details } = useQuery<CustomerDetails>({
    queryKey: ["customer-details", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers/${customerId}/details`);
      if (!res.ok) throw new Error("Details konnten nicht geladen werden");
      return res.json();
    },
    enabled: !!customerId,
  });

  const { data: budgetOverview } = useQuery<{
    entlastungsbetrag45b: {
      totalAllocatedCents: number;
      totalUsedCents: number;
      availableCents: number;
      currentMonthUsedCents: number;
      monthlyLimitCents: number | null;
    };
    umwandlung45a: { 
      monthlyBudgetCents: number; 
      currentMonthAllocatedCents: number;
      currentMonthUsedCents: number;
      currentMonthAvailableCents: number;
      label: string;
    };
    ersatzpflege39_42a: { 
      yearlyBudgetCents: number;
      currentYearAllocatedCents: number;
      currentYearUsedCents: number;
      currentYearAvailableCents: number;
      label: string;
    };
  }>({
    queryKey: ["budget-overview", customerId],
    queryFn: async () => {
      const res = await fetch(`/api/budget/${customerId}/overview`);
      if (!res.ok) throw new Error("Budget konnte nicht geladen werden");
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

  const rejectMutation = useMutation({
    mutationFn: async () => {
      const result = await api.post(`/customers/${customerId}/reject`, {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: "Kunde als inaktiv markiert" });
      setLocation("/customers");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const today = startOfToday();
  
  const undocumentedAppointments = appointments.filter(apt => 
    UNDOCUMENTED_STATUSES.includes(apt.status as typeof UNDOCUMENTED_STATUSES[number])
  );
  
  const displayAppointments = filterUndocumented ? undocumentedAppointments : appointments;
  
  const upcomingAppointments = displayAppointments
    .filter(apt => isAfter(parseISO(apt.date), today) || apt.date === format(today, "yyyy-MM-dd"))
    .sort((a, b) => a.date.localeCompare(b.date));
  
  const pastAppointments = displayAppointments
    .filter(apt => isBefore(parseISO(apt.date), today) && apt.date !== format(today, "yyyy-MM-dd"))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, filterUndocumented ? 50 : 5);

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
        <div className="flex items-center justify-center min-h-[50vh]">
          <ErrorState
            title="Kunde konnte nicht geladen werden"
            description={customerError instanceof Error ? customerError.message : "Der Kunde wurde nicht gefunden oder es ist ein Fehler aufgetreten."}
            onRetry={() => refetchCustomer()}
          />
        </div>
      </Layout>
    );
  }

  const address = formatAddress(customer);
  const phoneMobil = customer.telefon ? formatPhoneForDisplay(customer.telefon) : null;
  const phoneFestnetz = customer.festnetz ? formatPhoneForDisplay(customer.festnetz) : null;
  const hasPflegegrad = customer.pflegegrad && customer.pflegegrad > 0;
  const geburtsdatum = customer.geburtsdatum 
    ? format(parseISO(customer.geburtsdatum), "dd.MM.yyyy", { locale: de })
    : null;

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

        {filterUndocumented && (
          <Card className="mb-4 border-amber-200 bg-amber-50/50">
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <AlertCircle className={`${iconSize.sm} text-amber-600`} />
                  <span className="text-sm font-medium text-amber-700">
                    {undocumentedAppointments.length} {undocumentedAppointments.length === 1 ? "offener Termin" : "offene Termine"}
                  </span>
                </div>
                <Link href={`/customer/${customerId}`}>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-amber-700 hover:text-amber-900">
                    <X className={iconSize.sm} />
                    <span className="sr-only">Filter entfernen</span>
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        )}

        {customer.status === "erstberatung" && (
          <Card className="mb-4 border-blue-200 bg-blue-50/50" data-testid="card-erstberatung-hint">
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <UserSearch className={`${iconSize.sm} text-blue-600`} />
                  <span className="text-sm font-medium text-blue-700">Erstberatungskunde</span>
                </div>
                {canConvert && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                      onClick={() => {
                        if (confirm("Diesen Kunden wirklich als 'Kein Interesse' markieren?")) {
                          rejectMutation.mutate();
                        }
                      }}
                      disabled={rejectMutation.isPending}
                      data-testid="button-reject-customer"
                    >
                      {rejectMutation.isPending ? (
                        <Loader2 className={`${iconSize.sm} animate-spin`} />
                      ) : (
                        <>
                          <XCircle className={`${iconSize.sm} mr-1`} />
                          Kein Interesse
                        </>
                      )}
                    </Button>
                    <Link href={`/customer/${customerId}/convert`}>
                      <Button
                        size="sm"
                        className="bg-teal-600 hover:bg-teal-700"
                        data-testid="button-convert-customer"
                      >
                        <UserCheck className={`${iconSize.sm} mr-1`} />
                        Kunde übernehmen
                      </Button>
                    </Link>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Persönliche Daten & Kontakt */}
        <Card className="mb-4" data-testid="card-personal-info">
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <User className={`${iconSize.lg} text-primary`} />
              </div>
              <div className="flex-1 min-w-0 space-y-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  {hasPflegegrad && (
                    <StatusBadge type="pflegegrad" value={customer.pflegegrad!} data-testid="badge-pflegegrad" />
                  )}
                </div>

                {geburtsdatum && (
                  <div className="flex items-center gap-2 text-sm" data-testid="text-geburtsdatum">
                    <Cake className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                    <span className="text-muted-foreground">{geburtsdatum}</span>
                  </div>
                )}

                {address && (
                  <div className="flex items-start gap-2 text-sm">
                    <MapPin className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-primary/60`} />
                    <span className="text-muted-foreground" data-testid="text-address">{address}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm">
                  <Phone className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                  {phoneMobil ? (
                    <a href={`tel:${customer.telefon}`} className="text-primary hover:underline" data-testid="link-phone-mobil">
                      {phoneMobil}
                    </a>
                  ) : (
                    <span className="text-muted-foreground/60">Kein Mobiltelefon</span>
                  )}
                </div>

                {phoneFestnetz && (
                  <div className="flex items-center gap-2 text-sm">
                    <PhoneCall className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                    <a href={`tel:${customer.festnetz}`} className="text-primary hover:underline" data-testid="link-phone-festnetz">
                      {phoneFestnetz}
                    </a>
                  </div>
                )}

                {customer.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                    <a href={`mailto:${customer.email}`} className="text-primary hover:underline" data-testid="link-email">
                      {customer.email}
                    </a>
                  </div>
                )}

                {customer.needs && customer.needs.length > 0 && (
                  <div className="flex items-start gap-2 pt-1">
                    <Heart className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-rose-400`} />
                    <div className="flex flex-wrap gap-1">
                      {customer.needs.map((need, index) => (
                        <StatusBadge key={index} type="need" value={need} size="sm" />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Haustier */}
        {customer.haustierVorhanden && (
          <Card className="mb-4" data-testid="card-pet">
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <PawPrint className={`${iconSize.sm} text-amber-600`} />
                Haustier
              </h2>
              <p className="text-sm text-muted-foreground" data-testid="text-pet-details">
                {customer.haustierDetails || "Ja, keine weiteren Details"}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Notfallkontakte */}
        {details?.contacts && details.contacts.length > 0 && (
          <Card className="mb-4" data-testid="card-emergency-contacts">
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Users className={`${iconSize.sm} text-red-500`} />
                Notfallkontakte
              </h2>
              <div className="space-y-3">
                {details.contacts.map((contact) => (
                  <div key={contact.id} className="flex items-start justify-between gap-3 text-sm" data-testid={`contact-${contact.id}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{contact.vorname} {contact.nachname}</span>
                        {contact.isPrimary && (
                          <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">Primär</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {CONTACT_TYPE_LABELS[contact.contactType] ?? contact.contactType}
                      </span>
                    </div>
                    <a 
                      href={`tel:${contact.telefon}`} 
                      className="text-primary hover:underline shrink-0 flex items-center gap-1"
                      data-testid={`link-contact-phone-${contact.id}`}
                    >
                      <Phone className={iconSize.xs} />
                      {formatPhoneForDisplay(contact.telefon)}
                    </a>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Versicherung */}
        {details?.insurance && (
          <Card className="mb-4" data-testid="card-insurance">
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Shield className={`${iconSize.sm} text-blue-500`} />
                Pflegekasse
              </h2>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Kasse</span>
                  <span className="font-medium" data-testid="text-insurance-provider">{details.insurance.providerName}</span>
                </div>
                {details.insurance.ikNummer && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">IK-Nummer</span>
                    <span className="font-medium" data-testid="text-insurance-ik">{details.insurance.ikNummer}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Versichertennr.</span>
                  <span className="font-medium" data-testid="text-insurance-vnr">{details.insurance.versichertennummer}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Vorerkrankungen */}
        {customer.vorerkrankungen && (
          <Card className="mb-4" data-testid="card-medical-history">
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Stethoscope className={`${iconSize.sm} text-rose-500`} />
                Vorerkrankungen
              </h2>
              <p className="text-sm text-muted-foreground whitespace-pre-line" data-testid="text-medical-history">
                {customer.vorerkrankungen}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Vereinbarte Leistungen */}
        {details?.contract?.vereinbarteLeistungen && (
          <Card className="mb-4" data-testid="card-agreed-services">
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <ClipboardList className={`${iconSize.sm} text-green-600`} />
                Vereinbarte Leistungen
              </h2>
              <p className="text-sm text-muted-foreground whitespace-pre-line" data-testid="text-agreed-services">
                {details.contract.vereinbarteLeistungen}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Budget Übersicht */}
        {budgetOverview && (
          budgetOverview.entlastungsbetrag45b.totalAllocatedCents > 0 ||
          budgetOverview.umwandlung45a.monthlyBudgetCents > 0 ||
          budgetOverview.ersatzpflege39_42a.yearlyBudgetCents > 0
        ) && (
          <Card className="mb-4" data-testid="budget-overview">
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Wallet className={`${iconSize.sm} text-primary`} />
                Budgets
              </h2>
              <div className="space-y-4">
                {budgetOverview.entlastungsbetrag45b.totalAllocatedCents > 0 && (() => {
                  const b = budgetOverview.entlastungsbetrag45b;
                  const usedPercent = b.totalAllocatedCents > 0 ? Math.min(100, Math.round((b.totalUsedCents / b.totalAllocatedCents) * 100)) : 0;
                  return (
                    <div data-testid="budget-45b">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">§45b Entlastungsbetrag</span>
                        <span className="text-sm text-muted-foreground">
                          {(b.availableCents / 100).toFixed(2)} € verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-primary rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{(b.totalUsedCents / 100).toFixed(2)} € von {(b.totalAllocatedCents / 100).toFixed(2)} € verbraucht</span>
                        <span>Monat: {(b.currentMonthUsedCents / 100).toFixed(2)} €</span>
                      </div>
                    </div>
                  );
                })()}

                {budgetOverview.umwandlung45a.monthlyBudgetCents > 0 && (() => {
                  const b = budgetOverview.umwandlung45a;
                  const usedPercent = b.currentMonthAllocatedCents > 0 ? Math.min(100, Math.round((b.currentMonthUsedCents / b.currentMonthAllocatedCents) * 100)) : 0;
                  return (
                    <div data-testid="budget-45a">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">§45a Umwandlungsanspruch</span>
                        <span className="text-sm text-muted-foreground">
                          {(b.currentMonthAvailableCents / 100).toFixed(2)} € verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-purple-500 rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{(b.currentMonthUsedCents / 100).toFixed(2)} € von {(b.currentMonthAllocatedCents / 100).toFixed(2)} € verbraucht</span>
                        <span>nur aktueller Monat</span>
                      </div>
                    </div>
                  );
                })()}

                {budgetOverview.ersatzpflege39_42a.yearlyBudgetCents > 0 && (() => {
                  const b = budgetOverview.ersatzpflege39_42a;
                  const usedPercent = b.currentYearAllocatedCents > 0 ? Math.min(100, Math.round((b.currentYearUsedCents / b.currentYearAllocatedCents) * 100)) : 0;
                  return (
                    <div data-testid="budget-39-42a">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">§39/§42a Gemeinsamer Jahresbetrag</span>
                        <span className="text-sm text-muted-foreground">
                          {(b.currentYearAvailableCents / 100).toFixed(2)} € verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-blue-500 rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{(b.currentYearUsedCents / 100).toFixed(2)} € von {(b.currentYearAllocatedCents / 100).toFixed(2)} € verbraucht</span>
                        <span>Jahresbudget</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Termine */}
        {upcomingAppointments.length > 0 && (
          <div className="mb-4">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Calendar className={`${iconSize.sm} text-primary`} />
              Anstehende Termine
            </h2>
            <div className="flex flex-col gap-3">
              {upcomingAppointments.map((apt) => (
                <AppointmentCard key={apt.id} appointment={apt} showDate />
              ))}
            </div>
          </div>
        )}

        {pastAppointments.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold mb-3 text-muted-foreground">
              Letzte Termine
            </h2>
            <div className="flex flex-col gap-3 opacity-75">
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

        {/* Leistungsnachweise Link */}
        <div className="mt-4">
          <Link href={`/service-records?customerId=${customerId}`}>
            <Card>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <FileSignature className={`${iconSize.md} text-primary`} />
                  </div>
                  <div>
                    <h3 className="font-medium">Leistungsnachweise</h3>
                    <p className="text-sm text-muted-foreground">Monatliche Unterschriften und Dokumentation</p>
                  </div>
                </div>
                <ChevronRight className={`${iconSize.md} text-muted-foreground`} />
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>
    </Layout>
  );
}
