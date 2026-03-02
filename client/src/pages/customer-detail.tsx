import { useState, useCallback, useMemo } from "react";
import { useRoute, Link, useSearch, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/patterns/status-badge";
import { AppointmentCard } from "@/features/appointments/components/appointment-card";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { 
  ArrowLeft, MapPin, Phone, Mail, Plus, Trash2,
  Calendar, Loader2, AlertCircle, FileSignature, ChevronRight, X, Wallet,
  Cake, PhoneCall, Shield, PawPrint, ClipboardList, Stethoscope, Users, UserSearch,
  UserCheck, XCircle, Pencil, Check, Save,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { ErrorState } from "@/components/patterns/error-state";
import type { Customer, CustomerContact } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { UNDOCUMENTED_STATUSES } from "@shared/domain/appointments";
import { CONTACT_TYPE_LABELS, CONTACT_TYPE_SELECT_OPTIONS } from "@shared/domain/customers";
import { formatAddress } from "@shared/utils/format";
import { CustomerDocumentsSection } from "@/features/customers/components/customer-documents-section";

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

  type EditSection = "contact" | "pflegegrad" | "pet" | "medical" | "services" | "emergencyContacts" | null;
  const [editingSection, setEditingSection] = useState<EditSection>(null);

  const [contactForm, setContactForm] = useState({
    strasse: "", nr: "", plz: "", stadt: "",
    telefon: "", festnetz: "", email: "",
  });

  const [pflegegradForm, setPflegegradForm] = useState({ pflegegrad: "1", seitDatum: todayISO() });

  const [petForm, setPetForm] = useState({ haustierVorhanden: false, haustierDetails: "" });

  const [medicalForm, setMedicalForm] = useState("");

  const [servicesForm, setServicesForm] = useState("");

  const emptyContactForm = { vorname: "", nachname: "", telefon: "", email: "", contactType: "familie" as string, isPrimary: false, notes: "" };
  const [editingContactId, setEditingContactId] = useState<number | null>(null);
  const [emergencyContactForm, setEmergencyContactForm] = useState(emptyContactForm);
  const [showAddContact, setShowAddContact] = useState(false);

  const startEditing = useCallback((section: EditSection) => {
    if (!customer) return;
    if (section === "contact") {
      setContactForm({
        strasse: customer.strasse || "",
        nr: customer.nr || "",
        plz: customer.plz || "",
        stadt: customer.stadt || "",
        telefon: customer.telefon || "",
        festnetz: customer.festnetz || "",
        email: customer.email || "",
      });
    } else if (section === "pflegegrad") {
      setPflegegradForm({
        pflegegrad: String(customer.pflegegrad || 1),
        seitDatum: todayISO(),
      });
    } else if (section === "pet") {
      setPetForm({
        haustierVorhanden: customer.haustierVorhanden ?? false,
        haustierDetails: customer.haustierDetails || "",
      });
    } else if (section === "medical") {
      setMedicalForm(customer.vorerkrankungen || "");
    } else if (section === "services") {
      setServicesForm(details?.contract?.vereinbarteLeistungen || "");
    }
    setEditingSection(section);
  }, [customer, details]);

  const cancelEditing = useCallback(() => setEditingSection(null), []);

  const updateCustomerMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.patch(`/customers/${customerId}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setEditingSection(null);
      toast({ title: "Kundendaten aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateCareLevelMutation = useMutation({
    mutationFn: async (data: { pflegegrad: number; seitDatum: string }) => {
      const result = await api.post(`/customers/${customerId}/care-level`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setEditingSection(null);
      toast({ title: "Pflegegrad aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateContractMutation = useMutation({
    mutationFn: async (data: { vereinbarteLeistungen: string | null }) => {
      const result = await api.patch(`/customers/${customerId}/contract`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-details", customerId] });
      setEditingSection(null);
      toast({ title: "Vereinbarte Leistungen aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleSaveContact = useCallback(() => {
    updateCustomerMutation.mutate({
      strasse: contactForm.strasse || undefined,
      nr: contactForm.nr || undefined,
      plz: contactForm.plz || undefined,
      stadt: contactForm.stadt || undefined,
      telefon: contactForm.telefon || null,
      festnetz: contactForm.festnetz || null,
      email: contactForm.email || null,
    });
  }, [contactForm, updateCustomerMutation]);

  const handleSavePflegegrad = useCallback(() => {
    updateCareLevelMutation.mutate({
      pflegegrad: parseInt(pflegegradForm.pflegegrad),
      seitDatum: pflegegradForm.seitDatum,
    });
  }, [pflegegradForm, updateCareLevelMutation]);

  const handleSavePet = useCallback(() => {
    updateCustomerMutation.mutate({
      haustierVorhanden: petForm.haustierVorhanden,
      haustierDetails: petForm.haustierVorhanden ? (petForm.haustierDetails || null) : null,
    });
  }, [petForm, updateCustomerMutation]);

  const handleSaveMedical = useCallback(() => {
    updateCustomerMutation.mutate({ vorerkrankungen: medicalForm || null });
  }, [medicalForm, updateCustomerMutation]);

  const handleSaveServices = useCallback(() => {
    updateContractMutation.mutate({ vereinbarteLeistungen: servicesForm || null });
  }, [servicesForm, updateContractMutation]);

  const addContactMutation = useMutation({
    mutationFn: async (data: typeof emptyContactForm) => {
      const result = await api.post(`/customers/${customerId}/contacts`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-details", customerId] });
      setShowAddContact(false);
      setEmergencyContactForm(emptyContactForm);
      toast({ title: "Notfallkontakt hinzugefügt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateContactMutation = useMutation({
    mutationFn: async ({ contactId, data }: { contactId: number; data: Partial<typeof emptyContactForm> }) => {
      const result = await api.patch(`/customers/${customerId}/contacts/${contactId}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-details", customerId] });
      setEditingContactId(null);
      setEmergencyContactForm(emptyContactForm);
      toast({ title: "Notfallkontakt aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteContactMutation = useMutation({
    mutationFn: async (contactId: number) => {
      const result = await api.delete(`/customers/${customerId}/contacts/${contactId}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-details", customerId] });
      toast({ title: "Notfallkontakt entfernt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const startEditContact = useCallback((contact: CustomerContact) => {
    setEditingContactId(contact.id);
    setEmergencyContactForm({
      vorname: contact.vorname,
      nachname: contact.nachname,
      telefon: contact.telefon || "",
      email: contact.email || "",
      contactType: contact.contactType,
      isPrimary: contact.isPrimary ?? false,
      notes: contact.notes || "",
    });
    setShowAddContact(false);
  }, []);

  const cancelEditContact = useCallback(() => {
    setEditingContactId(null);
    setShowAddContact(false);
    setEmergencyContactForm(emptyContactForm);
  }, []);

  const handleSaveEmergencyContact = useCallback(() => {
    if (editingContactId) {
      updateContactMutation.mutate({ contactId: editingContactId, data: emergencyContactForm });
    } else {
      addContactMutation.mutate(emergencyContactForm);
    }
  }, [editingContactId, emergencyContactForm, updateContactMutation, addContactMutation]);

  const contactSaving = addContactMutation.isPending || updateContactMutation.isPending || deleteContactMutation.isPending;

  const isSaving = updateCustomerMutation.isPending || updateCareLevelMutation.isPending || updateContractMutation.isPending || contactSaving;

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
    ? formatDateForDisplay(customer.geburtsdatum)
    : null;

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

        {/* Pflegegrad */}
        <Card className="mb-4" data-testid="card-pflegegrad">
          <CardContent className="p-4">
            {editingSection === "pflegegrad" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Pflegegrad ändern</h2>
                </div>
                <p className="text-xs text-amber-600">Änderungen werden mit Datum historisiert und sind abrechnungsrelevant.</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Pflegegrad</Label>
                    <Select value={pflegegradForm.pflegegrad} onValueChange={(v) => setPflegegradForm(f => ({ ...f, pflegegrad: v }))}>
                      <SelectTrigger data-testid="select-pflegegrad">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1,2,3,4,5].map(g => (
                          <SelectItem key={g} value={String(g)}>Pflegegrad {g}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Gültig seit</Label>
                    <Input
                      type="date"
                      value={pflegegradForm.seitDatum}
                      onChange={(e) => setPflegegradForm(f => ({ ...f, seitDatum: e.target.value }))}
                      data-testid="input-pflegegrad-seit"
                    />
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleSavePflegegrad} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-pflegegrad">
                    {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-pflegegrad">
                    Abbrechen
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  {hasPflegegrad ? (
                    <StatusBadge type="pflegegrad" value={customer.pflegegrad!} data-testid="badge-pflegegrad" />
                  ) : (
                    <span className="text-xs text-muted-foreground/60">Kein Pflegegrad</span>
                  )}
                </div>
                <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => startEditing("pflegegrad")} data-testid="button-edit-pflegegrad">
                  <Pencil className="h-3.5 w-3.5 text-gray-400" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Persönliche Daten & Kontakt */}
        <Card className="mb-4" data-testid="card-personal-info">
          <CardContent className="p-4">
            {editingSection === "contact" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Kontaktdaten bearbeiten</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <Label>Straße</Label>
                    <Input value={contactForm.strasse} onChange={(e) => setContactForm(f => ({ ...f, strasse: e.target.value }))} data-testid="input-strasse" />
                  </div>
                  <div>
                    <Label>Nr.</Label>
                    <Input value={contactForm.nr} onChange={(e) => setContactForm(f => ({ ...f, nr: e.target.value }))} data-testid="input-nr" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <Label>PLZ</Label>
                    <Input value={contactForm.plz} onChange={(e) => setContactForm(f => ({ ...f, plz: e.target.value }))} maxLength={5} data-testid="input-plz" />
                  </div>
                  <div className="col-span-2">
                    <Label>Stadt</Label>
                    <Input value={contactForm.stadt} onChange={(e) => setContactForm(f => ({ ...f, stadt: e.target.value }))} data-testid="input-stadt" />
                  </div>
                </div>
                <div>
                  <Label>Mobilnummer</Label>
                  <Input value={contactForm.telefon} onChange={(e) => setContactForm(f => ({ ...f, telefon: e.target.value }))} placeholder="+49 151 ..." data-testid="input-telefon" />
                </div>
                <div>
                  <Label>Festnetz</Label>
                  <Input value={contactForm.festnetz} onChange={(e) => setContactForm(f => ({ ...f, festnetz: e.target.value }))} placeholder="+49 351 ..." data-testid="input-festnetz" />
                </div>
                <div>
                  <Label>E-Mail</Label>
                  <Input type="email" value={contactForm.email} onChange={(e) => setContactForm(f => ({ ...f, email: e.target.value }))} data-testid="input-email" />
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleSaveContact} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-contact">
                    {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-contact">
                    Abbrechen
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-700">Kontakt & Adresse</span>
                  <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => startEditing("contact")} data-testid="button-edit-contact">
                    <Pencil className="h-3.5 w-3.5 text-gray-400" />
                  </Button>
                </div>
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2 text-sm" data-testid="text-geburtsdatum">
                    <Cake className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                    <span className="text-muted-foreground">{geburtsdatum || "Kein Geburtsdatum"}</span>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <MapPin className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-primary/60`} />
                    <span className="text-muted-foreground" data-testid="text-address">{address || "Keine Adresse"}</span>
                  </div>
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
                  <div className="flex items-center gap-2 text-sm">
                    <PhoneCall className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                    {phoneFestnetz ? (
                      <a href={`tel:${customer.festnetz}`} className="text-primary hover:underline" data-testid="link-phone-festnetz">
                        {phoneFestnetz}
                      </a>
                    ) : (
                      <span className="text-muted-foreground/60">Kein Festnetz</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                    {customer.email ? (
                      <a href={`mailto:${customer.email}`} className="text-primary hover:underline" data-testid="link-email">
                        {customer.email}
                      </a>
                    ) : (
                      <span className="text-muted-foreground/60">Keine E-Mail</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Haustier */}
        <Card className="mb-4" data-testid="card-pet">
          <CardContent className="p-4">
            {editingSection === "pet" ? (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <PawPrint className={`${iconSize.sm} text-amber-600`} />
                  Haustier bearbeiten
                </h2>
                <div className="flex items-center gap-3">
                  <Switch
                    checked={petForm.haustierVorhanden}
                    onCheckedChange={(checked) => setPetForm(f => ({ ...f, haustierVorhanden: checked }))}
                    data-testid="switch-pet"
                  />
                  <Label>{petForm.haustierVorhanden ? "Haustier vorhanden" : "Kein Haustier"}</Label>
                </div>
                {petForm.haustierVorhanden && (
                  <div>
                    <Label>Details (Art, Name, Hinweise)</Label>
                    <Input
                      value={petForm.haustierDetails}
                      onChange={(e) => setPetForm(f => ({ ...f, haustierDetails: e.target.value }))}
                      placeholder="z.B. Hund, freundlich"
                      data-testid="input-pet-details"
                    />
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleSavePet} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-pet">
                    {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-pet">
                    Abbrechen
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <PawPrint className={`${iconSize.sm} text-amber-600`} />
                    Haustier
                  </h2>
                  <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => startEditing("pet")} data-testid="button-edit-pet">
                    <Pencil className="h-3.5 w-3.5 text-gray-400" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground" data-testid="text-pet-details">
                  {customer.haustierVorhanden
                    ? (customer.haustierDetails || "Ja, keine weiteren Details")
                    : "Kein Haustier"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Notfallkontakte */}
        <Card className="mb-4" data-testid="card-emergency-contacts">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Users className={`${iconSize.sm} text-red-500`} />
                Notfallkontakte
              </h2>
              {!showAddContact && editingContactId === null && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  onClick={() => { setShowAddContact(true); setEmergencyContactForm(emptyContactForm); }}
                  data-testid="button-add-contact"
                >
                  <Plus className="h-3.5 w-3.5" /> Hinzufügen
                </Button>
              )}
            </div>

            {details?.contacts && details.contacts.length > 0 && (
              <div className="space-y-3 mb-3">
                {details.contacts.map((contact) => (
                  editingContactId === contact.id ? (
                    <div key={contact.id} className="space-y-2 border rounded-lg p-3 bg-muted/30" data-testid={`contact-edit-form-${contact.id}`}>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs">Vorname</Label>
                          <Input value={emergencyContactForm.vorname} onChange={(e) => setEmergencyContactForm(f => ({ ...f, vorname: e.target.value }))} className="h-9" data-testid="input-contact-vorname" />
                        </div>
                        <div>
                          <Label className="text-xs">Nachname</Label>
                          <Input value={emergencyContactForm.nachname} onChange={(e) => setEmergencyContactForm(f => ({ ...f, nachname: e.target.value }))} className="h-9" data-testid="input-contact-nachname" />
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs">Telefon</Label>
                        <Input value={emergencyContactForm.telefon} onChange={(e) => setEmergencyContactForm(f => ({ ...f, telefon: e.target.value }))} className="h-9" data-testid="input-contact-telefon" />
                      </div>
                      <div>
                        <Label className="text-xs">E-Mail</Label>
                        <Input value={emergencyContactForm.email} onChange={(e) => setEmergencyContactForm(f => ({ ...f, email: e.target.value }))} className="h-9" data-testid="input-contact-email" />
                      </div>
                      <div>
                        <Label className="text-xs">Beziehung</Label>
                        <Select value={emergencyContactForm.contactType} onValueChange={(v) => setEmergencyContactForm(f => ({ ...f, contactType: v }))}>
                          <SelectTrigger className="h-9" data-testid="select-contact-type">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CONTACT_TYPE_SELECT_OPTIONS.map(opt => (
                              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">Notizen</Label>
                        <Input value={emergencyContactForm.notes} onChange={(e) => setEmergencyContactForm(f => ({ ...f, notes: e.target.value }))} className="h-9" placeholder="Optional" data-testid="input-contact-notes" />
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={emergencyContactForm.isPrimary} onCheckedChange={(v) => setEmergencyContactForm(f => ({ ...f, isPrimary: v }))} data-testid="switch-contact-primary" />
                        <Label className="text-xs">Primärer Kontakt</Label>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" onClick={handleSaveEmergencyContact} disabled={contactSaving} className="min-h-[36px]" data-testid="button-save-contact">
                          {contactSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                        </Button>
                        <Button size="sm" variant="outline" onClick={cancelEditContact} disabled={contactSaving} className="min-h-[36px]" data-testid="button-cancel-contact">
                          Abbrechen
                        </Button>
                      </div>
                    </div>
                  ) : (
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
                      <div className="flex items-center gap-1 shrink-0">
                        <a
                          href={`tel:${contact.telefon}`}
                          className="text-primary hover:underline flex items-center gap-1 text-sm"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`link-contact-phone-${contact.id}`}
                        >
                          <Phone className={iconSize.xs} />
                          {formatPhoneForDisplay(contact.telefon)}
                        </a>
                        <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => startEditContact(contact)} data-testid={`button-edit-contact-${contact.id}`}>
                          <Pencil className="h-3 w-3 text-gray-400" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => deleteContactMutation.mutate(contact.id)} disabled={contactSaving} data-testid={`button-delete-contact-${contact.id}`}>
                          <Trash2 className="h-3 w-3 text-gray-400" />
                        </Button>
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}

            {!details?.contacts?.length && !showAddContact && (
              <p className="text-sm text-muted-foreground/60">Keine Notfallkontakte hinterlegt</p>
            )}

            {showAddContact && (
              <div className="space-y-2 border rounded-lg p-3 bg-muted/30" data-testid="contact-add-form">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Vorname</Label>
                    <Input value={emergencyContactForm.vorname} onChange={(e) => setEmergencyContactForm(f => ({ ...f, vorname: e.target.value }))} className="h-9" data-testid="input-new-contact-vorname" />
                  </div>
                  <div>
                    <Label className="text-xs">Nachname</Label>
                    <Input value={emergencyContactForm.nachname} onChange={(e) => setEmergencyContactForm(f => ({ ...f, nachname: e.target.value }))} className="h-9" data-testid="input-new-contact-nachname" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Telefon</Label>
                  <Input value={emergencyContactForm.telefon} onChange={(e) => setEmergencyContactForm(f => ({ ...f, telefon: e.target.value }))} className="h-9" data-testid="input-new-contact-telefon" />
                </div>
                <div>
                  <Label className="text-xs">E-Mail</Label>
                  <Input value={emergencyContactForm.email} onChange={(e) => setEmergencyContactForm(f => ({ ...f, email: e.target.value }))} className="h-9" placeholder="Optional" data-testid="input-new-contact-email" />
                </div>
                <div>
                  <Label className="text-xs">Beziehung</Label>
                  <Select value={emergencyContactForm.contactType} onValueChange={(v) => setEmergencyContactForm(f => ({ ...f, contactType: v }))}>
                    <SelectTrigger className="h-9" data-testid="select-new-contact-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTACT_TYPE_SELECT_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Notizen</Label>
                  <Input value={emergencyContactForm.notes} onChange={(e) => setEmergencyContactForm(f => ({ ...f, notes: e.target.value }))} className="h-9" placeholder="Optional" data-testid="input-new-contact-notes" />
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={emergencyContactForm.isPrimary} onCheckedChange={(v) => setEmergencyContactForm(f => ({ ...f, isPrimary: v }))} data-testid="switch-new-contact-primary" />
                  <Label className="text-xs">Primärer Kontakt</Label>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleSaveEmergencyContact} disabled={contactSaving || !emergencyContactForm.vorname || !emergencyContactForm.nachname || !emergencyContactForm.telefon} className="min-h-[36px]" data-testid="button-save-new-contact">
                    {contactSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEditContact} disabled={contactSaving} className="min-h-[36px]" data-testid="button-cancel-new-contact">
                    Abbrechen
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Versicherung */}
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

        {/* Vorerkrankungen */}
        <Card className="mb-4" data-testid="card-medical-history">
          <CardContent className="p-4">
            {editingSection === "medical" ? (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Stethoscope className={`${iconSize.sm} text-rose-500`} />
                  Vorerkrankungen bearbeiten
                </h2>
                <Textarea
                  value={medicalForm}
                  onChange={(e) => setMedicalForm(e.target.value)}
                  placeholder="Bekannte Vorerkrankungen..."
                  rows={4}
                  data-testid="textarea-medical"
                />
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleSaveMedical} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-medical">
                    {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-medical">
                    Abbrechen
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <Stethoscope className={`${iconSize.sm} text-rose-500`} />
                    Vorerkrankungen
                  </h2>
                  <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => startEditing("medical")} data-testid="button-edit-medical">
                    <Pencil className="h-3.5 w-3.5 text-gray-400" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground whitespace-pre-line" data-testid="text-medical-history">
                  {customer.vorerkrankungen || "Keine Angabe"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Vereinbarte Leistungen */}
        <Card className="mb-4" data-testid="card-agreed-services">
          <CardContent className="p-4">
            {editingSection === "services" ? (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <ClipboardList className={`${iconSize.sm} text-green-600`} />
                  Vereinbarte Leistungen bearbeiten
                </h2>
                <Textarea
                  value={servicesForm}
                  onChange={(e) => setServicesForm(e.target.value)}
                  placeholder="Vereinbarte Leistungen..."
                  rows={4}
                  data-testid="textarea-services"
                />
                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleSaveServices} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-services">
                    {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                  </Button>
                  <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-services">
                    Abbrechen
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <ClipboardList className={`${iconSize.sm} text-green-600`} />
                    Vereinbarte Leistungen
                  </h2>
                  <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => startEditing("services")} data-testid="button-edit-services">
                    <Pencil className="h-3.5 w-3.5 text-gray-400" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground whitespace-pre-line" data-testid="text-agreed-services">
                  {details?.contract?.vereinbarteLeistungen || "Keine Angabe"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

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
                          {(b.availableCents / 100).toFixed(2).replace(".", ",")} € verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-primary rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{(b.totalUsedCents / 100).toFixed(2).replace(".", ",")} € von {(b.totalAllocatedCents / 100).toFixed(2).replace(".", ",")} € verbraucht</span>
                        <span>Monat: {(b.currentMonthUsedCents / 100).toFixed(2).replace(".", ",")} €</span>
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
                          {(b.currentMonthAvailableCents / 100).toFixed(2).replace(".", ",")} € verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-purple-500 rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{(b.currentMonthUsedCents / 100).toFixed(2).replace(".", ",")} € von {(b.currentMonthAllocatedCents / 100).toFixed(2).replace(".", ",")} € verbraucht</span>
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
                          {(b.currentYearAvailableCents / 100).toFixed(2).replace(".", ",")} € verfügbar
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2 mb-1">
                        <div
                          className="bg-blue-500 rounded-full h-2 transition-all"
                          style={{ width: `${usedPercent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{(b.currentYearUsedCents / 100).toFixed(2).replace(".", ",")} € von {(b.currentYearAllocatedCents / 100).toFixed(2).replace(".", ",")} € verbraucht</span>
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

        {/* Dokumente */}
        <Card className="mt-4" data-testid="card-customer-documents">
          <CardContent className="p-4">
            <CustomerDocumentsSection customerId={customerId!} customerName={customer?.name || ""} />
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
