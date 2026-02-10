import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DatePicker } from "@/components/ui/date-picker";
import { ChevronLeft, Loader2, Calendar, Clock, User, Home, Plus, Users, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { iconSize, componentStyles } from "@/design-system";
import { useCustomerList, useAdminEmployees, useCreateKundentermin, useCreateErstberatung, ServiceSelector, AppointmentSummary } from "@/features/appointments";
import { DURATION_OPTIONS, PFLEGEGRAD_OPTIONS, formatDuration } from "@shared/types";
import type { Service } from "@shared/schema";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";
import { timeToMinutes, minutesToTimeDisplay, formatDurationDisplay, todayISO } from "@shared/utils/datetime";

export default function NewAppointment() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<string>("kundentermin");

  const isAdmin = user?.isAdmin ?? false;

  const { data: customers = [], isLoading: customersLoading } = useCustomerList();
  const { data: employees = [] } = useAdminEmployees({ enabled: isAdmin });

  const createKundenterminMutation = useCreateKundentermin();
  const createErstberatungMutation = useCreateErstberatung();

  const { data: catalogServices = [] } = useQuery<Service[]>({
    queryKey: ["/api/services"],
    staleTime: 60_000,
  });

  // Kundentermin state
  const [ktCustomerId, setKtCustomerId] = useState<string>("");
  const [ktDate, setKtDate] = useState<string>(todayISO());
  const [ktTime, setKtTime] = useState<string>("09:00");
  const [ktServices, setKtServices] = useState<Array<{ serviceId: number; durationMinutes: number }>>([]);
  const [ktNotes, setKtNotes] = useState<string>("");
  const [ktAssignedEmployeeId, setKtAssignedEmployeeId] = useState<string>("");

  // Erstberatung state
  const [ebVorname, setEbVorname] = useState<string>("");
  const [ebNachname, setEbNachname] = useState<string>("");
  const [ebTelefon, setEbTelefon] = useState<string>("");
  const [ebStrasse, setEbStrasse] = useState<string>("");
  const [ebNr, setEbNr] = useState<string>("");
  const [ebPlz, setEbPlz] = useState<string>("");
  const [ebStadt, setEbStadt] = useState<string>("");
  const [ebPflegegrad, setEbPflegegrad] = useState<string>("1");
  const [ebDate, setEbDate] = useState<string>(todayISO());
  const [ebStartTime, setEbStartTime] = useState<string>("09:00");
  const [ebErstberatungDauer, setEbErstberatungDauer] = useState<number>(60);
  const [ebNotes, setEbNotes] = useState<string>("");
  const [ebAssignedEmployeeId, setEbAssignedEmployeeId] = useState<string>("");

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  const budgetEstimateParams = useMemo(() => {
    if (!ktCustomerId || ktServices.length === 0) return null;
    const params = new URLSearchParams();
    for (const s of ktServices) {
      const catalog = catalogServices.find(c => c.id === s.serviceId);
      if (catalog?.code === 'hauswirtschaft') params.set("hauswirtschaftMinutes", String(s.durationMinutes));
      if (catalog?.code === 'alltagsbegleitung') params.set("alltagsbegleitungMinutes", String(s.durationMinutes));
    }
    if (params.toString() === '') return null;
    params.set("date", ktDate);
    return params.toString();
  }, [ktCustomerId, ktServices, catalogServices, ktDate]);

  const { data: costEstimate } = useQuery<{
    totalCents: number;
    warning: string | null;
    noPricing?: boolean;
    availableCents?: number;
    currentMonthUsedCents?: number;
    monthlyLimitCents?: number | null;
    projectedMonthUsedCents?: number;
    isHardBlock?: boolean;
    acceptsPrivatePayment?: boolean;
  }>({
    queryKey: ["/api/budget", ktCustomerId, "cost-estimate", budgetEstimateParams],
    queryFn: async () => {
      const res = await fetch(`/api/budget/${ktCustomerId}/cost-estimate?${budgetEstimateParams}`);
      if (!res.ok) return { totalCents: 0, warning: null };
      return res.json();
    },
    enabled: !!ktCustomerId && !!budgetEstimateParams,
    staleTime: 30_000,
  });

  // Computed summary for Kundentermin
  const ktSummary = useMemo(() => {
    const servicesList = ktServices.map(s => {
      const catalog = catalogServices.find(c => c.id === s.serviceId);
      return { name: catalog?.name || "Service", duration: s.durationMinutes };
    });
    const totalMinutes = servicesList.reduce((sum, s) => sum + s.duration, 0);
    let endTime = "";
    if (ktTime && totalMinutes > 0) {
      const startMinutes = timeToMinutes(ktTime);
      endTime = minutesToTimeDisplay((startMinutes + totalMinutes) % (24 * 60));
    }
    return {
      services: servicesList,
      totalMinutes,
      totalFormatted: formatDurationDisplay(totalMinutes, "verbose"),
      startTime: ktTime,
      endTime,
      hasServices: servicesList.length > 0
    };
  }, [ktTime, ktServices, catalogServices]);

  const validateKundentermin = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!ktCustomerId) newErrors.ktCustomerId = "Bitte wählen Sie einen Kunden";
    if (ktServices.length === 0) newErrors.ktServices = "Bitte wählen Sie mindestens einen Service";
    if (isAdmin && !ktAssignedEmployeeId) newErrors.ktAssignedEmployeeId = "Bitte wählen Sie einen Mitarbeiter";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateErstberatung = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!ebVorname.trim()) newErrors.ebVorname = "Vorname ist erforderlich";
    if (!ebNachname.trim()) newErrors.ebNachname = "Nachname ist erforderlich";
    const phoneValidation = validateGermanPhone(ebTelefon);
    if (!phoneValidation.valid) newErrors.ebTelefon = phoneValidation.error;
    if (!ebStrasse.trim()) newErrors.ebStrasse = "Straße ist erforderlich";
    if (!ebNr.trim()) newErrors.ebNr = "Hausnummer ist erforderlich";
    if (!/^\d{5}$/.test(ebPlz)) newErrors.ebPlz = "PLZ muss 5 Ziffern haben";
    if (!ebStadt.trim()) newErrors.ebStadt = "Stadt ist erforderlich";
    if (isAdmin && !ebAssignedEmployeeId) newErrors.ebAssignedEmployeeId = "Bitte wählen Sie einen Mitarbeiter";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleKundenterminSubmit = () => {
    if (!validateKundentermin()) return;
    
    createKundenterminMutation.mutate({
      customerId: parseInt(ktCustomerId),
      date: ktDate,
      scheduledStart: ktTime,
      services: ktServices,
      notes: ktNotes || undefined,
      assignedEmployeeId: isAdmin && ktAssignedEmployeeId ? parseInt(ktAssignedEmployeeId) : undefined,
    }, {
      onSuccess: () => {
        toast({ title: "Termin erstellt", description: "Der Kundentermin wurde erfolgreich angelegt." });
        setLocation(ktDate ? `/?date=${ktDate}` : "/");
      },
      onError: (error: Error) => {
        toast({ variant: "destructive", title: "Fehler", description: error.message });
      },
    });
  };

  const handleErstberatungSubmit = () => {
    if (!validateErstberatung()) return;
    
    const normalizedPhone = normalizePhone(ebTelefon);
    if (!normalizedPhone) {
      setErrors({ ebTelefon: "Ungültige Telefonnummer" });
      return;
    }
    
    createErstberatungMutation.mutate({
      customer: {
        vorname: ebVorname,
        nachname: ebNachname,
        telefon: normalizedPhone,
        strasse: ebStrasse,
        nr: ebNr,
        plz: ebPlz,
        stadt: ebStadt,
        pflegegrad: parseInt(ebPflegegrad),
      },
      date: ebDate,
      scheduledStart: ebStartTime,
      erstberatungDauer: ebErstberatungDauer,
      notes: ebNotes || undefined,
      assignedEmployeeId: isAdmin && ebAssignedEmployeeId ? parseInt(ebAssignedEmployeeId) : undefined,
    }, {
      onSuccess: () => {
        toast({ title: "Erstberatung erstellt", description: "Die Erstberatung und der neue Kunde wurden erfolgreich angelegt." });
        setLocation(ebDate ? `/?date=${ebDate}` : "/");
      },
      onError: (error: Error) => {
        toast({ variant: "destructive", title: "Fehler", description: error.message });
      },
    });
  };
  
  // Computed summary for Erstberatung
  const ebSummary = useMemo(() => {
    // Calculate end time using central utilities
    let endTime = "";
    if (ebStartTime && ebErstberatungDauer > 0) {
      const startMinutes = timeToMinutes(ebStartTime);
      endTime = minutesToTimeDisplay((startMinutes + ebErstberatungDauer) % (24 * 60));
    }
    
    return {
      totalMinutes: ebErstberatungDauer,
      totalFormatted: formatDurationDisplay(ebErstberatungDauer, "verbose"),
      startTime: ebStartTime,
      endTime,
    };
  }, [ebStartTime, ebErstberatungDauer]);

  const customerOptions = useMemo(() => {
    const eligible = isAdmin
      ? customers
      : customers.filter((c) => c.isCurrentlyAssigned !== false);
    return eligible.map((c) => ({
      value: c.id.toString(),
      label: c.name,
      sublabel: c.address,
    }));
  }, [customers, isAdmin]);

  const employeeOptions = useMemo(() =>
    employees
      .filter(e => e.isActive)
      .map((e) => ({
        value: e.id.toString(),
        label: e.displayName,
      })),
    [employees]
  );

  const isPending = createKundenterminMutation.isPending || createErstberatungMutation.isPending;

  return (
    <Layout>
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="pl-0 text-muted-foreground hover:text-foreground mb-4"
          onClick={() => setLocation("/")}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>
        <h1 className="text-2xl font-bold">Neuer Termin</h1>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 mb-6">
          <TabsTrigger value="kundentermin" data-testid="tab-kundentermin">
            <User className={`${iconSize.sm} mr-2`} /> Kundentermin
          </TabsTrigger>
          <TabsTrigger value="erstberatung" data-testid="tab-erstberatung">
            <Plus className={`${iconSize.sm} mr-2`} /> Erstberatung
          </TabsTrigger>
        </TabsList>

        {/* Kundentermin Form */}
        <TabsContent value="kundentermin">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Termin für bestehenden Kunden</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Customer Selection */}
              <div className="space-y-2">
                <Label>Kunde auswählen</Label>
                <SearchableSelect
                  options={customerOptions}
                  value={ktCustomerId}
                  onValueChange={setKtCustomerId}
                  placeholder="Kunde auswählen..."
                  searchPlaceholder="Kunde suchen..."
                  emptyText="Kein Kunde gefunden."
                  isLoading={customersLoading}
                  data-testid="select-customer"
                />
                {errors.ktCustomerId && <p className="text-destructive text-sm">{errors.ktCustomerId}</p>}
              </div>

              {/* Employee Assignment (Admin only - required) */}
              {isAdmin && (
                <div className="space-y-2">
                  <Label>
                    <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
                  </Label>
                  <SearchableSelect
                    options={employeeOptions}
                    value={ktAssignedEmployeeId}
                    onValueChange={setKtAssignedEmployeeId}
                    placeholder="Mitarbeiter auswählen..."
                    searchPlaceholder="Mitarbeiter suchen..."
                    emptyText="Kein Mitarbeiter gefunden."
                    className={errors.ktAssignedEmployeeId ? "border-destructive" : ""}
                    data-testid="select-kt-employee"
                  />
                  {errors.ktAssignedEmployeeId && <p className="text-destructive text-sm">{errors.ktAssignedEmployeeId}</p>}
                  <p className="text-xs text-muted-foreground">
                    Der Mitarbeiter muss dem Kunden zugeordnet sein (Haupt- oder Vertretungsmitarbeiter)
                  </p>
                </div>
              )}

              {/* Date & Time */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>
                    <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum
                  </Label>
                  <DatePicker
                    value={ktDate || null}
                    onChange={(val) => setKtDate(val || "")}
                    disableWeekends
                    data-testid="input-kt-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kt-time">
                    <Clock className={`${iconSize.sm} inline mr-1`} /> Startzeit
                  </Label>
                  <Input
                    id="kt-time"
                    type="time"
                    value={ktTime}
                    onChange={(e) => setKtTime(e.target.value)}
                    className="text-base"
                    data-testid="input-kt-time"
                  />
                </div>
              </div>

              <ServiceSelector
                services={ktServices}
                onChange={setKtServices}
                error={errors.ktServices}
              />

              {ktSummary.hasServices && (
                <AppointmentSummary
                  startTime={ktSummary.startTime}
                  endTime={ktSummary.endTime}
                  services={ktSummary.services}
                  totalFormatted={ktSummary.totalFormatted}
                />
              )}

              {costEstimate && !costEstimate.noPricing && costEstimate.totalCents > 0 && (
                <div className="rounded-lg border bg-blue-50 border-blue-200 p-3 text-sm" data-testid="budget-cost-estimate">
                  <p className="font-medium text-blue-800">
                    Geschätzte Kosten: {(costEstimate.totalCents / 100).toFixed(2)} €
                  </p>
                  {costEstimate.availableCents !== undefined && (
                    <p className="text-blue-600 text-xs mt-1">
                      Verfügbares Budget: {(costEstimate.availableCents / 100).toFixed(2)} €
                    </p>
                  )}
                </div>
              )}

              {costEstimate?.isHardBlock && (
                <div className="rounded-lg border bg-red-50 border-red-300 p-3 text-sm flex items-start gap-2" data-testid="budget-hard-block">
                  <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <p className="text-red-800 font-medium">Budget reicht nicht aus. Termin kann nicht erstellt werden.</p>
                </div>
              )}

              {costEstimate?.warning && !costEstimate?.isHardBlock && (
                <div className="rounded-lg border bg-amber-50 border-amber-200 p-3 text-sm flex items-start gap-2" data-testid="budget-warning">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                  <p className="text-amber-800">{costEstimate.warning}</p>
                </div>
              )}

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="kt-notes">Notizen (optional, max. 255 Zeichen)</Label>
                <Textarea
                  id="kt-notes"
                  placeholder="Besondere Hinweise..."
                  value={ktNotes}
                  onChange={(e) => setKtNotes(e.target.value.slice(0, 255))}
                  maxLength={255}
                  data-testid="textarea-kt-notes"
                />
                <p className="text-xs text-muted-foreground">{ktNotes.length}/255</p>
              </div>

              <Button
                className={`w-full ${componentStyles.btnPrimary}`}
                size="lg"
                onClick={handleKundenterminSubmit}
                disabled={isPending || costEstimate?.isHardBlock === true}
                data-testid="button-create-kundentermin"
              >
                {isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
                Kundentermin erstellen
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Erstberatung Form */}
        <TabsContent value="erstberatung">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Erstberatung für neuen Kunden</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Personal Info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="eb-vorname">Vorname *</Label>
                  <Input
                    id="eb-vorname"
                    value={ebVorname}
                    onChange={(e) => setEbVorname(e.target.value)}
                    placeholder="Max"
                    data-testid="input-eb-vorname"
                  />
                  {errors.ebVorname && <p className="text-destructive text-sm">{errors.ebVorname}</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="eb-nachname">Nachname *</Label>
                  <Input
                    id="eb-nachname"
                    value={ebNachname}
                    onChange={(e) => setEbNachname(e.target.value)}
                    placeholder="Mustermann"
                    data-testid="input-eb-nachname"
                  />
                  {errors.ebNachname && <p className="text-destructive text-sm">{errors.ebNachname}</p>}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="eb-telefon">Telefon *</Label>
                <Input
                  id="eb-telefon"
                  type="tel"
                  value={ebTelefon}
                  onChange={(e) => setEbTelefon(formatPhoneAsYouType(e.target.value))}
                  placeholder="0171 1234567"
                  data-testid="input-eb-telefon"
                />
                <p className="text-xs text-muted-foreground">Mobil (0171...) oder Festnetz (030...)</p>
                {errors.ebTelefon && <p className="text-destructive text-sm">{errors.ebTelefon}</p>}
              </div>

              {/* Address */}
              <div className="space-y-4">
                <Label className="flex items-center gap-2">
                  <Home className={iconSize.sm} /> Adresse
                </Label>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="eb-strasse">Straße *</Label>
                    <Input
                      id="eb-strasse"
                      value={ebStrasse}
                      onChange={(e) => setEbStrasse(e.target.value)}
                      placeholder="Musterstraße"
                      data-testid="input-eb-strasse"
                    />
                    {errors.ebStrasse && <p className="text-destructive text-sm">{errors.ebStrasse}</p>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="eb-nr">Nr. *</Label>
                    <Input
                      id="eb-nr"
                      value={ebNr}
                      onChange={(e) => setEbNr(e.target.value)}
                      placeholder="42"
                      data-testid="input-eb-nr"
                    />
                    {errors.ebNr && <p className="text-destructive text-sm">{errors.ebNr}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="eb-plz">PLZ *</Label>
                    <Input
                      id="eb-plz"
                      value={ebPlz}
                      onChange={(e) => setEbPlz(e.target.value)}
                      placeholder="10969"
                      maxLength={5}
                      data-testid="input-eb-plz"
                    />
                    {errors.ebPlz && <p className="text-destructive text-sm">{errors.ebPlz}</p>}
                  </div>
                  <div className="col-span-2 space-y-2">
                    <Label htmlFor="eb-stadt">Stadt *</Label>
                    <Input
                      id="eb-stadt"
                      value={ebStadt}
                      onChange={(e) => setEbStadt(e.target.value)}
                      placeholder="Berlin"
                      data-testid="input-eb-stadt"
                    />
                    {errors.ebStadt && <p className="text-destructive text-sm">{errors.ebStadt}</p>}
                  </div>
                </div>
              </div>

              {/* Pflegegrad */}
              <div className="space-y-2">
                <Label>Pflegegrad *</Label>
                <Select value={ebPflegegrad} onValueChange={setEbPflegegrad}>
                  <SelectTrigger data-testid="select-pflegegrad">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PFLEGEGRAD_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p.toString()}>
                        Pflegegrad {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Employee Assignment (Admin only - required) */}
              {isAdmin && (
                <div className="space-y-2">
                  <Label>
                    <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
                  </Label>
                  <SearchableSelect
                    options={employeeOptions}
                    value={ebAssignedEmployeeId}
                    onValueChange={setEbAssignedEmployeeId}
                    placeholder="Mitarbeiter auswählen..."
                    searchPlaceholder="Mitarbeiter suchen..."
                    emptyText="Kein Mitarbeiter gefunden."
                    className={errors.ebAssignedEmployeeId ? "border-destructive" : ""}
                    data-testid="select-eb-employee"
                  />
                  {errors.ebAssignedEmployeeId && <p className="text-destructive text-sm">{errors.ebAssignedEmployeeId}</p>}
                  <p className="text-xs text-muted-foreground">
                    Der ausgewählte Mitarbeiter wird automatisch Hauptmitarbeiter für diesen neuen Kunden
                  </p>
                </div>
              )}

              {/* Date & Time */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>
                    <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum *
                  </Label>
                  <DatePicker
                    value={ebDate || null}
                    onChange={(val) => setEbDate(val || "")}
                    disableWeekends
                    data-testid="input-eb-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="eb-start">
                    <Clock className={`${iconSize.sm} inline mr-1`} /> Startzeit *
                  </Label>
                  <Input
                    id="eb-start"
                    type="time"
                    value={ebStartTime}
                    onChange={(e) => setEbStartTime(e.target.value)}
                    className="text-base"
                    data-testid="input-eb-start"
                  />
                </div>
              </div>

              {/* Service (Erstberatung) */}
              <div className="space-y-4">
                <Label>Service</Label>
                <div className="flex items-center justify-between p-4 rounded-lg border bg-purple-50 border-purple-200">
                  <div className="flex-1">
                    <span className="font-medium text-purple-800">Erstberatung</span>
                  </div>
                  <Select
                    value={ebErstberatungDauer.toString()}
                    onValueChange={(v) => setEbErstberatungDauer(parseInt(v))}
                  >
                    <SelectTrigger className="w-auto min-w-[120px]" data-testid="select-erstberatung-dauer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_OPTIONS.map((d) => (
                        <SelectItem key={d} value={d.toString()}>
                          {formatDuration(d)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Summary */}
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3" data-testid="eb-summary-panel">
                <div className="flex items-center gap-2 text-purple-700 font-semibold">
                  <Clock className={iconSize.sm} />
                  <span>Terminübersicht</span>
                </div>
                
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-purple-600">Von</span>
                    <p className="font-medium text-lg text-purple-800">{ebSummary.startTime} Uhr</p>
                  </div>
                  <div>
                    <span className="text-purple-600">Bis</span>
                    <p className="font-medium text-lg text-purple-800">{ebSummary.endTime} Uhr</p>
                  </div>
                </div>

                <div className="border-t border-purple-200 pt-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-purple-700">Erstberatung</span>
                    <span className="font-medium text-purple-800">{ebSummary.totalFormatted}</span>
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="eb-notes">Notizen (optional, max. 255 Zeichen)</Label>
                <Textarea
                  id="eb-notes"
                  placeholder="Besondere Hinweise zur Erstberatung..."
                  value={ebNotes}
                  onChange={(e) => setEbNotes(e.target.value.slice(0, 255))}
                  maxLength={255}
                  data-testid="textarea-eb-notes"
                />
                <p className="text-xs text-muted-foreground">{ebNotes.length}/255</p>
              </div>

              <Button
                className={`w-full ${componentStyles.btnPrimary}`}
                size="lg"
                onClick={handleErstberatungSubmit}
                disabled={isPending}
                data-testid="button-create-erstberatung"
              >
                {isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
                Erstberatung erstellen
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
