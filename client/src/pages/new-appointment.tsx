import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronLeft, Loader2, Calendar, Clock, User, Home, Plus, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { iconSize, componentStyles } from "@/design-system";
import { DURATION_OPTIONS, PFLEGEGRAD_OPTIONS } from "@shared/types";
import type { Customer, User as UserType } from "@shared/schema";
import { validateGermanPhone, formatPhoneAsYouType, normalizePhone } from "@shared/utils/phone";

export default function NewAppointment() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<string>("kundentermin");

  const isAdmin = user?.isAdmin ?? false;

  // Fetch customers for Kundentermin
  const { data: customers = [], isLoading: customersLoading } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await fetch("/api/customers");
      if (!res.ok) throw new Error("Failed to fetch customers");
      return res.json();
    },
  });

  // Fetch employees for admin assignment
  const { data: employees = [] } = useQuery<UserType[]>({
    queryKey: ["admin", "employees"],
    queryFn: async () => {
      const res = await fetch("/api/admin/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
    enabled: isAdmin,
  });

  // Kundentermin state
  const [ktCustomerId, setKtCustomerId] = useState<string>("");
  const [ktDate, setKtDate] = useState<string>(new Date().toISOString().split("T")[0]);
  const [ktTime, setKtTime] = useState<string>("09:00");
  const [ktHauswirtschaft, setKtHauswirtschaft] = useState<boolean>(false);
  const [ktHauswirtschaftDauer, setKtHauswirtschaftDauer] = useState<number>(60);
  const [ktAlltagsbegleitung, setKtAlltagsbegleitung] = useState<boolean>(false);
  const [ktAlltagsbegleitungDauer, setKtAlltagsbegleitungDauer] = useState<number>(60);
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
  const [ebDate, setEbDate] = useState<string>(new Date().toISOString().split("T")[0]);
  const [ebStartTime, setEbStartTime] = useState<string>("09:00");
  const [ebErstberatungDauer, setEbErstberatungDauer] = useState<number>(60);
  const [ebNotes, setEbNotes] = useState<string>("");
  const [ebAssignedEmployeeId, setEbAssignedEmployeeId] = useState<string>("");

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Computed summary for Kundentermin
  const ktSummary = useMemo(() => {
    const services: { name: string; duration: number }[] = [];
    if (ktHauswirtschaft) {
      services.push({ name: "Hauswirtschaft", duration: ktHauswirtschaftDauer });
    }
    if (ktAlltagsbegleitung) {
      services.push({ name: "Alltagsbegleitung", duration: ktAlltagsbegleitungDauer });
    }
    
    const totalMinutes = services.reduce((sum, s) => sum + s.duration, 0);
    
    // Calculate end time
    let endTime = "";
    if (ktTime && totalMinutes > 0) {
      const [hours, mins] = ktTime.split(":").map(Number);
      const totalMins = hours * 60 + mins + totalMinutes;
      const endHours = Math.floor(totalMins / 60) % 24;
      const endMins = totalMins % 60;
      endTime = `${endHours.toString().padStart(2, "0")}:${endMins.toString().padStart(2, "0")}`;
    }
    
    // Format duration as hours and minutes
    const formatDuration = (mins: number) => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h === 0) return `${m} Min.`;
      if (m === 0) return `${h} Std.`;
      return `${h} Std. ${m} Min.`;
    };
    
    return {
      services,
      totalMinutes,
      totalFormatted: formatDuration(totalMinutes),
      startTime: ktTime,
      endTime,
      hasServices: services.length > 0
    };
  }, [ktTime, ktHauswirtschaft, ktHauswirtschaftDauer, ktAlltagsbegleitung, ktAlltagsbegleitungDauer]);

  // Create Kundentermin mutation
  const createKundentermin = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch("/api/appointments/kundentermin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || error.error || "Kundentermin konnte nicht erstellt werden");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      toast({ title: "Termin erstellt", description: "Der Kundentermin wurde erfolgreich angelegt." });
      setLocation("/");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  // Create Erstberatung mutation
  const createErstberatung = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch("/api/appointments/erstberatung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || error.error || "Erstberatung konnte nicht erstellt werden");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: "Erstberatung erstellt", description: "Die Erstberatung und der neue Kunde wurden erfolgreich angelegt." });
      setLocation("/");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const validateKundentermin = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!ktCustomerId) newErrors.ktCustomerId = "Bitte wählen Sie einen Kunden";
    if (!ktHauswirtschaft && !ktAlltagsbegleitung) newErrors.ktServices = "Bitte wählen Sie mindestens einen Service";
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
    
    createKundentermin.mutate({
      customerId: parseInt(ktCustomerId),
      date: ktDate,
      scheduledStart: ktTime,
      hauswirtschaftDauer: ktHauswirtschaft ? ktHauswirtschaftDauer : null,
      alltagsbegleitungDauer: ktAlltagsbegleitung ? ktAlltagsbegleitungDauer : null,
      notes: ktNotes || undefined,
      assignedEmployeeId: isAdmin && ktAssignedEmployeeId ? parseInt(ktAssignedEmployeeId) : undefined,
    });
  };

  const handleErstberatungSubmit = () => {
    if (!validateErstberatung()) return;
    
    const normalizedPhone = normalizePhone(ebTelefon);
    if (!normalizedPhone) {
      setErrors({ ebTelefon: "Ungültige Telefonnummer" });
      return;
    }
    
    createErstberatung.mutate({
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
    });
  };
  
  // Computed summary for Erstberatung
  const ebSummary = useMemo(() => {
    // Calculate end time
    let endTime = "";
    if (ebStartTime && ebErstberatungDauer > 0) {
      const [hours, mins] = ebStartTime.split(":").map(Number);
      const totalMins = hours * 60 + mins + ebErstberatungDauer;
      const endHours = Math.floor(totalMins / 60) % 24;
      const endMins = totalMins % 60;
      endTime = `${endHours.toString().padStart(2, "0")}:${endMins.toString().padStart(2, "0")}`;
    }
    
    // Format duration as hours and minutes
    const formatDuration = (mins: number) => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h === 0) return `${m} Min.`;
      if (m === 0) return `${h} Std.`;
      return `${h} Std. ${m} Min.`;
    };
    
    return {
      totalMinutes: ebErstberatungDauer,
      totalFormatted: formatDuration(ebErstberatungDauer),
      startTime: ebStartTime,
      endTime,
    };
  }, [ebStartTime, ebErstberatungDauer]);

  const isPending = createKundentermin.isPending || createErstberatung.isPending;

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
                <Select value={ktCustomerId} onValueChange={setKtCustomerId}>
                  <SelectTrigger data-testid="select-customer">
                    <SelectValue placeholder="Kunde auswählen..." />
                  </SelectTrigger>
                  <SelectContent>
                    {customersLoading ? (
                      <div className="p-2 text-center text-muted-foreground">Laden...</div>
                    ) : (
                      customers.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {c.name} - {c.address}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {errors.ktCustomerId && <p className="text-destructive text-sm">{errors.ktCustomerId}</p>}
              </div>

              {/* Employee Assignment (Admin only - required) */}
              {isAdmin && (
                <div className="space-y-2">
                  <Label>
                    <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
                  </Label>
                  <Select value={ktAssignedEmployeeId} onValueChange={setKtAssignedEmployeeId}>
                    <SelectTrigger data-testid="select-kt-employee" className={errors.ktAssignedEmployeeId ? "border-destructive" : ""}>
                      <SelectValue placeholder="Mitarbeiter auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      {employees
                        .filter(e => e.isActive)
                        .map((e) => (
                          <SelectItem key={e.id} value={e.id.toString()}>
                            {e.displayName}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {errors.ktAssignedEmployeeId && <p className="text-destructive text-sm">{errors.ktAssignedEmployeeId}</p>}
                  <p className="text-xs text-muted-foreground">
                    Der Mitarbeiter muss dem Kunden zugeordnet sein (Haupt- oder Vertretungsmitarbeiter)
                  </p>
                </div>
              )}

              {/* Date & Time */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="kt-date">
                    <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum
                  </Label>
                  <Input
                    id="kt-date"
                    type="date"
                    value={ktDate}
                    onChange={(e) => setKtDate(e.target.value)}
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
                    data-testid="input-kt-time"
                  />
                </div>
              </div>

              {/* Services */}
              <div className="space-y-4">
                <Label>Services (mindestens einer)</Label>
                
                <div className="flex items-center space-x-3 p-4 rounded-lg border">
                  <Checkbox
                    id="hauswirtschaft"
                    checked={ktHauswirtschaft}
                    onCheckedChange={(checked) => {
                      setKtHauswirtschaft(!!checked);
                      if (!checked) setKtHauswirtschaftDauer(60);
                    }}
                    data-testid="checkbox-hauswirtschaft"
                  />
                  <div className="flex-1">
                    <Label htmlFor="hauswirtschaft" className="cursor-pointer font-medium">
                      Hauswirtschaft
                    </Label>
                  </div>
                  {ktHauswirtschaft && (
                    <Select
                      value={ktHauswirtschaftDauer.toString()}
                      onValueChange={(v) => setKtHauswirtschaftDauer(parseInt(v))}
                    >
                      <SelectTrigger className="w-28" data-testid="select-hauswirtschaft-dauer">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DURATION_OPTIONS.map((d) => (
                          <SelectItem key={d} value={d.toString()}>
                            {d} Min.
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <div className="flex items-center space-x-3 p-4 rounded-lg border">
                  <Checkbox
                    id="alltagsbegleitung"
                    checked={ktAlltagsbegleitung}
                    onCheckedChange={(checked) => {
                      setKtAlltagsbegleitung(!!checked);
                      if (!checked) setKtAlltagsbegleitungDauer(60);
                    }}
                    data-testid="checkbox-alltagsbegleitung"
                  />
                  <div className="flex-1">
                    <Label htmlFor="alltagsbegleitung" className="cursor-pointer font-medium">
                      Alltagsbegleitung
                    </Label>
                  </div>
                  {ktAlltagsbegleitung && (
                    <Select
                      value={ktAlltagsbegleitungDauer.toString()}
                      onValueChange={(v) => setKtAlltagsbegleitungDauer(parseInt(v))}
                    >
                      <SelectTrigger className="w-28" data-testid="select-alltagsbegleitung-dauer">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DURATION_OPTIONS.map((d) => (
                          <SelectItem key={d} value={d.toString()}>
                            {d} Min.
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {errors.ktServices && <p className="text-destructive text-sm">{errors.ktServices}</p>}
              </div>

              {/* Real-time Summary */}
              {ktSummary.hasServices && (
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3" data-testid="summary-panel">
                  <div className="flex items-center gap-2 text-primary font-semibold">
                    <Clock className={iconSize.sm} />
                    <span>Terminübersicht</span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Von</span>
                      <p className="font-medium text-lg">{ktSummary.startTime} Uhr</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Bis</span>
                      <p className="font-medium text-lg">{ktSummary.endTime} Uhr</p>
                    </div>
                  </div>

                  <div className="border-t border-primary/10 pt-3 space-y-1">
                    {ktSummary.services.map((s, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span>{s.name}</span>
                        <span className="text-muted-foreground">{s.duration} Min.</span>
                      </div>
                    ))}
                    <div className="flex justify-between font-medium pt-1 border-t border-primary/10">
                      <span>Gesamt</span>
                      <span className="text-primary">{ktSummary.totalFormatted}</span>
                    </div>
                  </div>
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
                disabled={isPending}
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
                  <Select value={ebAssignedEmployeeId} onValueChange={setEbAssignedEmployeeId}>
                    <SelectTrigger data-testid="select-eb-employee" className={errors.ebAssignedEmployeeId ? "border-destructive" : ""}>
                      <SelectValue placeholder="Mitarbeiter auswählen..." />
                    </SelectTrigger>
                    <SelectContent>
                      {employees
                        .filter(e => e.isActive)
                        .map((e) => (
                          <SelectItem key={e.id} value={e.id.toString()}>
                            {e.displayName}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {errors.ebAssignedEmployeeId && <p className="text-destructive text-sm">{errors.ebAssignedEmployeeId}</p>}
                  <p className="text-xs text-muted-foreground">
                    Der ausgewählte Mitarbeiter wird automatisch Hauptmitarbeiter für diesen neuen Kunden
                  </p>
                </div>
              )}

              {/* Date & Time */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="eb-date">
                    <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum *
                  </Label>
                  <Input
                    id="eb-date"
                    type="date"
                    value={ebDate}
                    onChange={(e) => setEbDate(e.target.value)}
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
                    <SelectTrigger className="w-28" data-testid="select-erstberatung-dauer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_OPTIONS.map((d) => (
                        <SelectItem key={d} value={d.toString()}>
                          {d} Min.
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
