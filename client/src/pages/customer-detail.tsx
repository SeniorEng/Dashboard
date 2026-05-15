import { useMemo, useState } from "react";
import { useRoute, Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowLeft, Calendar, AlertCircle, FileSignature, ChevronRight, X, Wallet, Shield, Wrench, Loader2,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { ErrorState } from "@/components/patterns/error-state";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { CustomerContactSection } from "@/features/customers/components/customer-contact-section";
import { CustomerMedicalSection } from "@/features/customers/components/customer-medical-section";
import { CustomerEmergencySection } from "@/features/customers/components/customer-emergency-section";
import { CustomerAssignmentSection } from "@/features/customers/components/customer-assignment-section";
import { CustomerPetsSection } from "@/features/customers/components/customer-pets-section";
import { CustomerDocumentsSection } from "@/features/customers/components/customer-documents-section";
import { useCustomerDetailForm } from "@/features/customers/hooks/use-customer-detail-form";
import { api, unwrapResult } from "@/lib/api/client";
import { todayISO } from "@shared/utils/datetime";
import { formatEuroDE } from "@shared/utils/money";
import { UNDOCUMENTED_STATUSES } from "@shared/domain/appointments";
import type { Customer, CustomerContact } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";

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
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const filterUndocumented = searchParams.get("filter") === "undocumented";

  const { data: customer, isLoading: customerLoading, error: customerError, refetch: refetchCustomer } = useQuery<Customer>({
    queryKey: ["customer", customerId],
    queryFn: async () => {
      const result = await api.get<Customer>(`/customers/${customerId}`);
      return unwrapResult(result);
    },
    enabled: !!customerId,
  });

  const { data: details } = useQuery<CustomerDetails>({
    queryKey: ["customer-details", customerId],
    queryFn: async () => {
      const result = await api.get<CustomerDetails>(`/customers/${customerId}/details`);
      return unwrapResult(result);
    },
    enabled: !!customerId,
  });

  const { data: budgetOverview } = useQuery<{
    entlastungsbetrag45b: {
      totalAllocatedCents: number;
      totalUsedCents: number;
      availableCents: number;
      currentMonthUsedCents: number;
      currentMonthAvailableCents: number;
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
      const result = await api.get<{
        entlastungsbetrag45b: {
          totalAllocatedCents: number;
          totalUsedCents: number;
          availableCents: number;
          currentMonthUsedCents: number;
          currentMonthAvailableCents: number;
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
      }>(`/budget/${customerId}/overview`);
      return unwrapResult(result);
    },
    enabled: !!customerId,
  });

  const { data: appointments = [], isLoading: appointmentsLoading } = useQuery<AppointmentWithCustomer[]>({
    queryKey: ["appointments", "customer", customerId],
    queryFn: async () => {
      const result = await api.get<AppointmentWithCustomer[]>(`/appointments?customerId=${customerId}`);
      return unwrapResult(result);
    },
    enabled: !!customerId,
  });

  const form = useCustomerDetailForm(customerId, customer, details);
  const { toast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.isSuperAdmin ?? false;

  interface ReconcileApptResult {
    appointmentId: number;
    date: string;
    currentMinutes: number;
    originalMinutes: number;
    status: "ok" | "insufficient" | "skipped";
    detail: string;
  }
  interface ReconcileSummary {
    customerId: number;
    customerName: string;
    carryoverNormalized: number;
    results: ReconcileApptResult[];
    restored: number;
    insufficient: number;
    skipped: number;
  }

  const [reconcilePreview, setReconcilePreview] = useState<ReconcileSummary | null>(null);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [reconcileApplying, setReconcileApplying] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<ReconcileSummary | null>(null);

  const runReconcile = async (apply: boolean) => {
    if (!customerId) return;
    if (apply) setReconcileApplying(true); else setReconcileLoading(true);
    try {
      const result = await api.post<ReconcileSummary>(
        "/admin/import-appointments/reconcile-trimmed",
        { customerId, apply },
      );
      const summary = unwrapResult(result);
      if (apply) {
        setReconcileResult(summary);
        setReconcilePreview(null);
        toast({
          title: "Reparatur abgeschlossen",
          description: `${summary.restored} Termin(e) wiederhergestellt, ${summary.insufficient} unzureichend, ${summary.skipped} übersprungen.`,
        });
      } else {
        setReconcilePreview(summary);
        setReconcileResult(null);
      }
    } catch (e) {
      toast({
        title: "Fehler",
        description: e instanceof Error ? e.message : "Reparatur fehlgeschlagen.",
        variant: "destructive",
      });
    } finally {
      setReconcileLoading(false);
      setReconcileApplying(false);
    }
  };

  const today = todayISO();
  
  const undocumentedAppointments = useMemo(() => 
    appointments.filter(apt => 
      UNDOCUMENTED_STATUSES.includes(apt.status as typeof UNDOCUMENTED_STATUSES[number])
    ), [appointments]);
  
  const displayAppointments = filterUndocumented ? undocumentedAppointments : appointments;
  
  const upcomingAppointments = useMemo(() => 
    displayAppointments
      .filter(apt => apt.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date)),
    [displayAppointments, today]);
  
  const pastAppointments = useMemo(() => 
    displayAppointments
      .filter(apt => apt.date < today)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, filterUndocumented ? 50 : 5),
    [displayAppointments, today, filterUndocumented]);

  if (customerLoading) {
    return (
      <Layout>
        <div className="min-h-[50vh] p-4 space-y-6">
          <div className="flex items-center gap-3">
            <div className="animate-pulse h-8 w-8 rounded-full bg-muted" />
            <div className="animate-pulse h-6 w-48 bg-muted rounded" />
          </div>
          <div className="animate-pulse h-32 w-full bg-muted rounded-xl" />
          <div className="grid grid-cols-2 gap-4">
            <div className="animate-pulse h-24 bg-muted rounded-xl" />
            <div className="animate-pulse h-24 bg-muted rounded-xl" />
          </div>
          <div className="animate-pulse h-48 w-full bg-muted rounded-xl" />
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

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/customers">
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="Zurück" data-testid="button-back">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <h1 className={componentStyles.pageTitle} data-testid="text-customer-name">
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

        <CustomerMedicalSection
          customer={customer}
          editingSection={form.editingSection}
          pflegegradForm={form.pflegegradForm}
          setPflegegradForm={form.setPflegegradForm}
          handleSavePflegegrad={form.handleSavePflegegrad}
          medicalForm={form.medicalForm}
          setMedicalForm={form.setMedicalForm}
          handleSaveMedical={form.handleSaveMedical}
          servicesForm={form.servicesForm}
          setServicesForm={form.setServicesForm}
          handleSaveServices={form.handleSaveServices}
          isSaving={form.isSaving}
          cancelEditing={form.cancelEditing}
          startEditing={form.startEditing}
          vereinbarteLeistungen={details?.contract?.vereinbarteLeistungen}
        />

        <CustomerContactSection
          customer={customer}
          editingSection={form.editingSection}
          contactForm={form.contactForm}
          setContactForm={form.setContactForm}
          contactFormErrors={form.contactFormErrors}
          setContactFormErrors={form.setContactFormErrors}
          plzLoading={form.plzLoading}
          isSaving={form.isSaving}
          handleSaveContact={form.handleSaveContact}
          cancelEditing={form.cancelEditing}
          startEditing={form.startEditing}
          validatePhone={form.validatePhone}
          validateEmail={form.validateEmail}
        />

        {customerId && (
          <CustomerAssignmentSection customer={customer} customerId={customerId} />
        )}

        <CustomerPetsSection
          customer={customer}
          editingSection={form.editingSection}
          petForm={form.petForm}
          setPetForm={form.setPetForm}
          handleSavePet={form.handleSavePet}
          isSaving={form.isSaving}
          cancelEditing={form.cancelEditing}
          startEditing={form.startEditing}
        />

        <CustomerEmergencySection
          contacts={details?.contacts}
          editingContactId={form.editingContactId}
          showAddContact={form.showAddContact}
          emergencyContactForm={form.emergencyContactForm}
          setEmergencyContactForm={form.setEmergencyContactForm}
          emergencyFormErrors={form.emergencyFormErrors}
          setEmergencyFormErrors={form.setEmergencyFormErrors}
          contactSaving={form.contactSaving}
          handleSaveEmergencyContact={form.handleSaveEmergencyContact}
          startEditContact={form.startEditContact}
          cancelEditContact={form.cancelEditContact}
          handleStartAddContact={form.handleStartAddContact}
          deleteContactMutation={form.deleteContactMutation}
          validatePhone={form.validatePhone}
          validateEmail={form.validateEmail}
        />

        <Card className="mb-4" data-testid="card-insurance">
          <CardContent className="p-4">
            <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Shield className={`${iconSize.sm} text-blue-500`} />
              Pflegekasse
            </h2>
            {details?.insurance ? (
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
            ) : (
              <p className="text-sm text-muted-foreground/60">Keine Pflegekasse zugeordnet</p>
            )}
          </CardContent>
        </Card>

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
                          {formatEuroDE(b.currentMonthAvailableCents)} verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-primary rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{formatEuroDE(b.totalUsedCents)} von {formatEuroDE(b.totalAllocatedCents)} verbraucht</span>
                        <span>Monat: {formatEuroDE(b.currentMonthUsedCents)}</span>
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
                          {formatEuroDE(b.currentMonthAvailableCents)} verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-purple-500 rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{formatEuroDE(b.currentMonthUsedCents)} von {formatEuroDE(b.currentMonthAllocatedCents)} verbraucht</span>
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
                          {formatEuroDE(b.currentYearAvailableCents)} verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-blue-500 rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{formatEuroDE(b.currentYearUsedCents)} von {formatEuroDE(b.currentYearAllocatedCents)} verbraucht</span>
                        <span>Jahresbudget</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </CardContent>
          </Card>
        )}

        {isSuperAdmin && (
          <Card className="mb-4" data-testid="card-reconcile-trimmed">
            <CardContent className="p-4">
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Wrench className={`${iconSize.sm} text-amber-600`} />
                Importierte Kürzungen prüfen
              </h2>
              <p className="text-xs text-muted-foreground mb-3">
                Sucht historische Importe, die fälschlich auf 0 oder weniger Minuten gekürzt wurden, und stellt die Originalminuten wieder her — sofern das §45b-Budget (inkl. Übertrag) ausreicht.
              </p>

              {!reconcilePreview && !reconcileResult && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => runReconcile(false)}
                  disabled={reconcileLoading}
                  data-testid="button-reconcile-preview"
                >
                  {reconcileLoading && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
                  Importierte Kürzungen prüfen
                </Button>
              )}

              {reconcilePreview && (
                <div className="space-y-3" data-testid="reconcile-preview">
                  <div className="text-sm">
                    <strong>Vorschau:</strong>{" "}
                    {reconcilePreview.restored} wiederherstellbar,{" "}
                    {reconcilePreview.insufficient} unzureichend,{" "}
                    {reconcilePreview.skipped} übersprungen
                    {reconcilePreview.carryoverNormalized > 0 && (
                      <> · {reconcilePreview.carryoverNormalized} Übertrag(e) werden normalisiert</>
                    )}
                  </div>
                  {reconcilePreview.results.length === 0 && (
                    <p className="text-sm text-muted-foreground" data-testid="reconcile-empty">
                      Keine fehlerhaft gekürzten Importe gefunden.
                    </p>
                  )}
                  {reconcilePreview.results.length > 0 && (
                    <div className="border rounded-md max-h-64 overflow-auto text-xs">
                      <table className="w-full">
                        <thead className="bg-muted sticky top-0">
                          <tr className="text-left">
                            <th className="px-2 py-1">Termin</th>
                            <th className="px-2 py-1">Datum</th>
                            <th className="px-2 py-1">Aktuell</th>
                            <th className="px-2 py-1">Original</th>
                            <th className="px-2 py-1">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reconcilePreview.results.map((r) => (
                            <tr key={r.appointmentId} className="border-t" data-testid={`row-reconcile-${r.appointmentId}`}>
                              <td className="px-2 py-1">#{r.appointmentId}</td>
                              <td className="px-2 py-1">{r.date}</td>
                              <td className="px-2 py-1">{r.currentMinutes} Min</td>
                              <td className="px-2 py-1">{r.originalMinutes} Min</td>
                              <td className="px-2 py-1">
                                <span className={
                                  r.status === "ok" ? "text-green-600" :
                                  r.status === "insufficient" ? "text-red-600" :
                                  "text-muted-foreground"
                                }>
                                  {r.detail}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setReconcilePreview(null)}
                      disabled={reconcileApplying}
                      data-testid="button-reconcile-cancel"
                    >
                      Abbrechen
                    </Button>
                    {reconcilePreview.restored > 0 && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            disabled={reconcileApplying}
                            data-testid="button-reconcile-apply"
                          >
                            {reconcileApplying && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
                            Reparatur durchführen
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Reparatur bestätigen</AlertDialogTitle>
                            <AlertDialogDescription>
                              {reconcilePreview.restored} Termin(e) werden auf ihre Originalminuten zurückgesetzt und neu gegen das §45b-Budget gebucht. Bestehende Buchungen werden storniert. Pro Termin wird ein Audit-Eintrag geschrieben. Fortfahren?
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel data-testid="button-confirm-cancel">Abbrechen</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => runReconcile(true)}
                              data-testid="button-confirm-apply"
                            >
                              Reparatur durchführen
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
              )}

              {reconcileResult && (
                <div className="space-y-2" data-testid="reconcile-result">
                  <div className="text-sm">
                    <strong>Ergebnis:</strong>{" "}
                    {reconcileResult.restored} wiederhergestellt,{" "}
                    {reconcileResult.insufficient} unzureichend,{" "}
                    {reconcileResult.skipped} übersprungen
                    {reconcileResult.carryoverNormalized > 0 && (
                      <> · {reconcileResult.carryoverNormalized} Übertrag(e) normalisiert</>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReconcileResult(null)}
                    data-testid="button-reconcile-close"
                  >
                    Schließen
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

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

        <Card className="mt-4" data-testid="card-customer-documents">
          <CardContent className="p-4">
            <CustomerDocumentsSection customerId={customerId!} customerName={customer?.name || ""} />
          </CardContent>
        </Card>

      </div>
    </Layout>
  );
}
