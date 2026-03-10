import { useState, useMemo, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ChevronLeft, Loader2, Calendar, Clock, AlertTriangle, Home, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { useAppointment, useCustomerList, ServiceSelector, AppointmentSummary } from "@/features/appointments";
import { useAdminEmployees } from "@/features/appointments/hooks/use-active-employees";
import { EmployeeAvailability } from "@/features/appointments/components/employee-availability";
import { addMinutesToTime, timeToMinutes, minutesToTimeDisplay, formatDurationDisplay } from "@shared/utils/datetime";
import { DURATION_OPTIONS, PFLEGEGRAD_OPTIONS, formatDuration } from "@shared/types";
import { validateGermanPhone, formatPhoneAsYouType } from "@shared/utils/phone";
import type { Service } from "@shared/schema";

export default function EditAppointment() {
  const [, params] = useRoute("/edit-appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const id = params?.id ? parseInt(params.id) : 0;
  const isAdmin = user?.isAdmin ?? false;

  const { data: appointment, isLoading: appointmentLoading } = useAppointment(id);
  
  const { data: customers = [] } = useCustomerList();
  const { data: employees = [] } = useAdminEmployees({ enabled: isAdmin });

  const { data: appointmentServiceEntries = [] } = useQuery<Array<{
    serviceId: number;
    plannedDurationMinutes: number;
    serviceName: string;
    serviceCode: string | null;
  }>>({
    queryKey: [`/api/appointments/${id}/services`],
    queryFn: async () => {
      const result = await api.get<Array<{
        serviceId: number;
        plannedDurationMinutes: number;
        serviceName: string;
        serviceCode: string | null;
      }>>(`/appointments/${id}/services`);
      return unwrapResult(result);
    },
    enabled: id > 0,
  });

  const { data: catalogServices = [] } = useQuery<Service[]>({
    queryKey: ["/api/services"],
    staleTime: 60_000,
  });

  const [date, setDate] = useState<string>("");
  const [time, setTime] = useState<string>("");
  const [services, setServices] = useState<Array<{ serviceId: number; durationMinutes: number }>>([]);
  const [notes, setNotes] = useState<string>("");
  const [endTime, setEndTime] = useState<string>("");
  const [duration, setDuration] = useState<number>(60);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ktAssignedEmployeeId, setKtAssignedEmployeeId] = useState<string>("");

  const [ebVorname, setEbVorname] = useState("");
  const [ebNachname, setEbNachname] = useState("");
  const [ebTelefon, setEbTelefon] = useState("");
  const [ebEmail, setEbEmail] = useState("");
  const [ebStrasse, setEbStrasse] = useState("");
  const [ebNr, setEbNr] = useState("");
  const [ebPlz, setEbPlz] = useState("");
  const [ebStadt, setEbStadt] = useState("");
  const [ebPflegegrad, setEbPflegegrad] = useState("1");
  const [ebAssignedEmployeeId, setEbAssignedEmployeeId] = useState("");

  useEffect(() => {
    if (appointment) {
      setDate(appointment.date);
      setTime(appointment.scheduledStart.slice(0, 5));
      setNotes(appointment.notes || "");
      
      if (appointment.appointmentType === "Kundentermin") {
        if (appointmentServiceEntries.length > 0) {
          setServices(appointmentServiceEntries.map(e => ({
            serviceId: e.serviceId,
            durationMinutes: e.plannedDurationMinutes,
          })));
        }
        if (appointment.assignedEmployeeId) {
          setKtAssignedEmployeeId(appointment.assignedEmployeeId.toString());
        }
      } else {
        if (appointment.scheduledEnd) {
          const start = appointment.scheduledStart.slice(0, 5);
          const end = appointment.scheduledEnd.slice(0, 5);
          setEndTime(end);
          const startMin = timeToMinutes(start);
          const endMin = timeToMinutes(end);
          const dur = endMin - startMin;
          if (dur > 0) setDuration(dur);
        }

        if (appointment.customer) {
          const c = appointment.customer;
          setEbVorname(c.vorname || "");
          setEbNachname(c.nachname || "");
          setEbTelefon(c.telefon || "");
          setEbEmail(c.email || "");
          setEbStrasse(c.strasse || "");
          setEbNr(c.nr || "");
          setEbPlz(c.plz || "");
          setEbStadt(c.stadt || "");
          setEbPflegegrad(c.pflegegrad?.toString() || "1");
        }
        if (appointment.assignedEmployeeId) {
          setEbAssignedEmployeeId(appointment.assignedEmployeeId.toString());
        }
      }
    }
  }, [appointment, appointmentServiceEntries, catalogServices]);

  const ktEmployeeOptions = useMemo(() => {
    const active = employees.filter(e => e.isActive);
    if (appointment?.customer) {
      const c = appointment.customer;
      const assignedIds = [c.primaryEmployeeId, c.backupEmployeeId, c.backupEmployeeId2].filter(Boolean);
      if (assignedIds.length > 0) {
        return active
          .filter(e => assignedIds.includes(e.id))
          .map((e) => ({
            value: e.id.toString(),
            label: e.displayName + (e.id === c.primaryEmployeeId ? " (Haupt)" : e.id === c.backupEmployeeId ? " (Vertretung)" : " (2. Vertretung)"),
          }))
          .sort((a, b) => a.label.localeCompare(b.label, "de"));
      }
    }
    return active.map((e) => ({
      value: e.id.toString(),
      label: e.displayName,
    })).sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [employees, appointment]);

  const ebEmployeeOptions = useMemo(() => {
    return employees
      .filter(e => e.isActive && e.roles?.includes("erstberatung"))
      .map((e) => ({
        value: e.id.toString(),
        label: e.displayName,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [employees]);

  const summary = useMemo(() => {
    if (!appointment) return null;
    
    if (appointment.appointmentType === "Erstberatung") {
      const calcEnd = time ? addMinutesToTime(time, duration) : "";
      return {
        startTime: time,
        endTime: calcEnd,
        totalFormatted: calcEnd ? `${time} - ${calcEnd}` : ""
      };
    }
    
    const servicesList = services.map(s => {
      const catalog = catalogServices.find(c => c.id === s.serviceId);
      return { name: catalog?.name || "Service", duration: s.durationMinutes };
    });
    
    const totalMinutes = servicesList.reduce((sum, s) => sum + s.duration, 0);
    
    let calculatedEndTime = "";
    if (time && totalMinutes > 0) {
      const startMinutes = timeToMinutes(time);
      calculatedEndTime = minutesToTimeDisplay((startMinutes + totalMinutes) % (24 * 60));
    }
    
    return {
      services: servicesList,
      totalMinutes,
      totalFormatted: formatDurationDisplay(totalMinutes, "verbose"),
      startTime: time,
      endTime: calculatedEndTime,
      hasServices: servicesList.length > 0
    };
  }, [appointment, time, duration, endTime, services, catalogServices]);

  const updateMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.patch(`/appointments/${id}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments");
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}/services`] });
      toast({ title: "Termin aktualisiert", description: "Die Änderungen wurden gespeichert." });
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const updateErstberatungMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.patch(`/appointments/${id}/erstberatung`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "customers");
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}/services`] });
      toast({ title: "Erstberatung aktualisiert", description: "Alle Änderungen wurden gespeichert." });
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    
    if (appointment?.appointmentType === "Kundentermin") {
      if (services.length === 0) {
        newErrors.services = "Bitte wählen Sie mindestens einen Service";
      }
      if (isAdmin && !ktAssignedEmployeeId) {
        newErrors.ktAssignedEmployeeId = "Bitte wählen Sie einen Mitarbeiter";
      }
    } else if (appointment?.appointmentType === "Erstberatung") {
      if (!ebVorname.trim()) newErrors.ebVorname = "Vorname ist erforderlich";
      if (!ebNachname.trim()) newErrors.ebNachname = "Nachname ist erforderlich";
      if (!ebTelefon.trim()) {
        newErrors.ebTelefon = "Telefon ist erforderlich";
      } else if (!validateGermanPhone(ebTelefon)) {
        newErrors.ebTelefon = "Ungültige Telefonnummer";
      }
      if (!ebStrasse.trim()) newErrors.ebStrasse = "Straße ist erforderlich";
      if (!ebNr.trim()) newErrors.ebNr = "Hausnummer ist erforderlich";
      if (!ebPlz.trim() || !/^\d{5}$/.test(ebPlz)) newErrors.ebPlz = "PLZ muss 5 Ziffern haben";
      if (!ebStadt.trim()) newErrors.ebStadt = "Stadt ist erforderlich";
      if (isAdmin && !ebAssignedEmployeeId) newErrors.ebAssignedEmployeeId = "Bitte einen Mitarbeiter auswählen";
      if (!duration || duration <= 0) newErrors.time = "Bitte wählen Sie eine Dauer";
    } else {
      if (!duration || duration <= 0) {
        newErrors.time = "Bitte wählen Sie eine Dauer";
      }
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate() || !appointment) return;
    
    if (appointment.appointmentType === "Kundentermin") {
      const totalDuration = services.reduce((sum, s) => sum + s.durationMinutes, 0);
      const calculatedEndTime = addMinutesToTime(time, totalDuration);
      
      updateMutation.mutate({
        date,
        scheduledStart: time,
        scheduledEnd: calculatedEndTime,
        durationPromised: totalDuration,
        notes: notes || null,
        assignedEmployeeId: isAdmin && ktAssignedEmployeeId ? parseInt(ktAssignedEmployeeId) : undefined,
        services: services.map(s => ({
          serviceId: s.serviceId,
          plannedDurationMinutes: s.durationMinutes,
        })),
      });
    } else if (appointment.appointmentType === "Erstberatung") {
      updateErstberatungMutation.mutate({
        customer: {
          vorname: ebVorname.trim(),
          nachname: ebNachname.trim(),
          telefon: ebTelefon.trim(),
          email: ebEmail.trim() || undefined,
          strasse: ebStrasse.trim(),
          nr: ebNr.trim(),
          plz: ebPlz.trim(),
          stadt: ebStadt.trim(),
          pflegegrad: parseInt(ebPflegegrad),
        },
        date,
        scheduledStart: time,
        erstberatungDauer: duration,
        notes: notes || null,
        assignedEmployeeId: ebAssignedEmployeeId ? parseInt(ebAssignedEmployeeId) : null,
      });
    } else {
      const calculatedEnd = addMinutesToTime(time, duration);
      
      updateMutation.mutate({
        date,
        scheduledStart: time,
        scheduledEnd: calculatedEnd,
        durationPromised: duration,
        notes: notes || null,
      });
    }
  };

  const isPending = updateMutation.isPending || updateErstberatungMutation.isPending;

  if (appointmentLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (!appointment) {
    return (
      <Layout>
        <div className="text-center py-12">Termin nicht gefunden</div>
      </Layout>
    );
  }

  if (appointment.status === "completed") {
    return (
      <Layout>
        <Button 
          variant="ghost" 
          size="sm" 
          className="pl-0 text-muted-foreground hover:text-foreground mb-4" 
          onClick={() => setLocation(appointment?.date ? `/?date=${appointment.date}` : "/")}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>
        <div className="text-center py-12 space-y-4">
          <AlertTriangle className={`${iconSize.xl} text-amber-500 mx-auto`} />
          <h2 className="text-xl font-bold">Bearbeitung nicht möglich</h2>
          <p className="text-muted-foreground">Abgeschlossene Termine können nicht bearbeitet werden.</p>
        </div>
      </Layout>
    );
  }

  const isKundentermin = appointment.appointmentType === "Kundentermin";
  const isErstberatung = appointment.appointmentType === "Erstberatung";

  return (
    <Layout>
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          className="pl-0 text-muted-foreground hover:text-foreground mb-4"
          onClick={() => setLocation(appointment?.date ? `/?date=${appointment.date}` : "/")}
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>
        <h1 className={componentStyles.pageTitle}>
          {isErstberatung ? "Erstberatung bearbeiten" : "Termin bearbeiten"}
        </h1>
        {!isErstberatung && appointment.customer && (
          <p className="text-muted-foreground mt-1">{appointment.customer.name}</p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {isKundentermin ? "Kundentermin" : "Erstberatung"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {isKundentermin && isAdmin && (
            <div className="space-y-2">
              <Label>
                <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
              </Label>
              <SearchableSelect
                options={ktEmployeeOptions}
                value={ktAssignedEmployeeId}
                onValueChange={setKtAssignedEmployeeId}
                placeholder="Mitarbeiter auswählen..."
                searchPlaceholder="Mitarbeiter suchen..."
                emptyText="Kein Mitarbeiter gefunden."
                className={errors.ktAssignedEmployeeId ? "border-destructive" : ""}
                data-testid="select-kt-employee"
              />
              {errors.ktAssignedEmployeeId && <p className="text-destructive text-sm">{errors.ktAssignedEmployeeId}</p>}
            </div>
          )}

          {isErstberatung && (
            <>
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

              <div className="space-y-2">
                <Label htmlFor="eb-email">E-Mail</Label>
                <Input
                  id="eb-email"
                  type="email"
                  value={ebEmail}
                  onChange={(e) => setEbEmail(e.target.value)}
                  placeholder="beispiel@email.de"
                  data-testid="input-eb-email"
                />
              </div>

              <div className="space-y-4">
                <Label className="flex items-center gap-2">
                  <Home className={iconSize.sm} /> Adresse
                </Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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

              {isAdmin && (
                <div className="space-y-2">
                  <Label>
                    <Users className={`${iconSize.sm} inline mr-1`} /> Mitarbeiter zuweisen *
                  </Label>
                  <SearchableSelect
                    options={ebEmployeeOptions}
                    value={ebAssignedEmployeeId}
                    onValueChange={setEbAssignedEmployeeId}
                    placeholder="Mitarbeiter auswählen..."
                    searchPlaceholder="Mitarbeiter suchen..."
                    emptyText="Kein Mitarbeiter mit Erstberatungs-Berechtigung gefunden."
                    className={errors.ebAssignedEmployeeId ? "border-destructive" : ""}
                    data-testid="select-eb-employee"
                  />
                  {errors.ebAssignedEmployeeId && <p className="text-destructive text-sm">{errors.ebAssignedEmployeeId}</p>}
                </div>
              )}
            </>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>
                <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum {isErstberatung ? "*" : ""}
              </Label>
              <DatePicker
                value={date || null}
                onChange={(val) => setDate(val || "")}
                disableWeekends
                data-testid="input-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="time">
                <Clock className={`${iconSize.sm} inline mr-1`} /> Startzeit {isErstberatung ? "*" : ""}
              </Label>
              <Input
                id="time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="text-base"
                data-testid="input-time"
              />
            </div>
          </div>

          {isAdmin && isErstberatung && date && (
            <EmployeeAvailability
              date={date}
              selectedEmployeeId={ebAssignedEmployeeId}
              onSelectEmployee={setEbAssignedEmployeeId}
            />
          )}

          {isKundentermin ? (
            <div className="space-y-4">
              <ServiceSelector
                services={services}
                onChange={setServices}
                error={errors.services}
              />

              {summary && summary.hasServices && (
                <AppointmentSummary
                  startTime={summary.startTime}
                  endTime={summary.endTime}
                  services={summary.services || []}
                  totalFormatted={summary.totalFormatted}
                />
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {isErstberatung ? (
                <>
                  <div className="space-y-4">
                    <Label>Service</Label>
                    <div className="flex items-center justify-between p-4 rounded-lg border bg-purple-50 border-purple-200">
                      <div className="flex-1">
                        <span className="font-medium text-purple-800">Erstberatung</span>
                      </div>
                      <Select
                        value={duration.toString()}
                        onValueChange={(val) => {
                          const dur = parseInt(val);
                          setDuration(dur);
                          if (time) {
                            setEndTime(addMinutesToTime(time, dur));
                          }
                        }}
                      >
                        <SelectTrigger className="w-auto min-w-[120px]" data-testid="select-duration">
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

                  {summary && (
                    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3" data-testid="eb-summary-panel">
                      <div className="flex items-center gap-2 text-purple-700 font-semibold">
                        <Clock className={iconSize.sm} />
                        <span>Terminübersicht</span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-purple-600">Von</span>
                          <p className="font-medium text-lg text-purple-800">{summary.startTime} Uhr</p>
                        </div>
                        <div>
                          <span className="text-purple-600">Bis</span>
                          <p className="font-medium text-lg text-purple-800">{summary.endTime} Uhr</p>
                        </div>
                      </div>

                      <div className="border-t border-purple-200 pt-3">
                        <div className="flex justify-between text-sm">
                          <span className="text-purple-700">Erstberatung</span>
                          <span className="font-medium text-purple-800">{formatDuration(duration)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  <Label>
                    <Clock className={`${iconSize.sm} inline mr-1`} /> Dauer
                  </Label>
                  <Select
                    value={duration.toString()}
                    onValueChange={(val) => {
                      const dur = parseInt(val);
                      setDuration(dur);
                      if (time) {
                        setEndTime(addMinutesToTime(time, dur));
                      }
                    }}
                  >
                    <SelectTrigger data-testid="select-duration">
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
                  {time && (
                    <p className="text-xs text-muted-foreground">
                      {time} – {addMinutesToTime(time, duration)}
                    </p>
                  )}
                </div>
              )}
              {errors.time && <p className="text-destructive text-sm">{errors.time}</p>}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notizen (optional, max. 255 Zeichen)</Label>
            <Textarea
              id="notes"
              placeholder={isErstberatung ? "Besondere Hinweise zur Erstberatung..." : "Besondere Hinweise..."}
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 255))}
              maxLength={255}
              data-testid="textarea-notes"
            />
            <p className="text-xs text-muted-foreground">{notes.length}/255</p>
          </div>

          <Button
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={handleSubmit}
            disabled={isPending}
            data-testid="button-save"
          >
            {isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
            Änderungen speichern
          </Button>
        </CardContent>
      </Card>
    </Layout>
  );
}
