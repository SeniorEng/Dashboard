import { useState, useMemo, useEffect, useRef, useCallback } from "react";
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
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronLeft, Loader2, Calendar, Clock, AlertTriangle, Home, Users, UserCheck, Repeat } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { useAppointment, useCustomerList, ServiceSelector, AppointmentSummary, FahrtdienstDetails } from "@/features/appointments";
import { useActiveEmployees, useAdminEmployees } from "@/features/appointments/hooks/use-active-employees";
import { EmployeeAvailability } from "@/features/appointments/components/employee-availability";
import type { FahrtdienstState } from "@/features/appointments/components/fahrtdienst-panel";
import { addMinutesToTime, timeToMinutes, minutesToTimeDisplay, formatDurationDisplay } from "@shared/utils/datetime";
import { DURATION_OPTIONS, PFLEGEGRAD_OPTIONS, formatDuration } from "@shared/types";
import { validateDachPhone, formatPhoneAsYouType } from "@shared/utils/phone";
import type { Service } from "@shared/schema";

export default function EditAppointment() {
  const [, params] = useRoute("/edit-appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const id = params?.id ? parseInt(params.id) : 0;
  const isAdmin = user?.isAdmin ?? false;
  const isTeamLead = user?.isTeamLead ?? false;
  const canChangeKtAssignment = isAdmin || isTeamLead;

  const { data: appointment, isLoading: appointmentLoading } = useAppointment(id);
  
  const { data: customers = [] } = useCustomerList();
  const { data: employees = [] } = useAdminEmployees({ enabled: isAdmin });
  // Aktive Mitarbeiter inklusive Teamleiter-Info (für Cross-Team-Confirm).
  const { data: activeEmployees = [] } = useActiveEmployees({ enabled: canChangeKtAssignment });

  const { data: appointmentServiceEntries = [], isSuccess: appointmentServicesLoaded } = useQuery<Array<{
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
  const [showSeriesEditDialog, setShowSeriesEditDialog] = useState(false);
  const [showCrossTeamConfirm, setShowCrossTeamConfirm] = useState(false);

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

  const [fahrtdienst, setFahrtdienst] = useState<FahrtdienstState>({
    enabled: false,
    doctorName: "",
    doctorAppointmentTime: "",
    doctorStrasse: "",
    doctorNr: "",
    doctorPlz: "",
    doctorStadt: "",
  });
  const [fahrtdienstTravelData, setFahrtdienstTravelData] = useState<{
    pickupTime: string;
    travelMinutes: number;
    bufferMinutes: number;
    distanceKm: number;
    doctorLat?: number;
    doctorLng?: number;
  } | null>(null);
  const [isGeocodingCustomer, setIsGeocodingCustomer] = useState(false);
  const [geocodingError, setGeocodingError] = useState<string | null>(null);
  const [geocodedCoords, setGeocodedCoords] = useState<{ customerId: number; lat: number; lng: number } | null>(null);

  const fahrtdienstInitializedRef = useRef(false);

  const handlePickupTimeCalculated = useCallback((
    pickupTime: string,
    travelMinutes: number,
    bufferMinutes: number,
    distanceKm: number,
    doctorLat?: number,
    doctorLng?: number,
  ) => {
    // Routing-Daten merken (für die PATCH-Payload), aber die Startzeit
    // beim Bearbeiten bewusst NICHT überschreiben. Die Übernahme passiert
    // jetzt explizit per Knopf in <FahrtdienstDetails />.
    setFahrtdienstTravelData({ pickupTime, travelMinutes, bufferMinutes, distanceKm, doctorLat, doctorLng });
  }, []);

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
        if (!fahrtdienstInitializedRef.current && appointmentServicesLoaded) {
          fahrtdienstInitializedRef.current = true;
          if (appointment.isFahrtdienst) {
            setFahrtdienst({
              enabled: true,
              doctorName: appointment.doctorName ?? "",
              doctorAppointmentTime: (appointment.doctorAppointmentTime ?? "").slice(0, 5),
              doctorStrasse: appointment.doctorStrasse ?? "",
              doctorNr: appointment.doctorNr ?? "",
              doctorPlz: appointment.doctorPlz ?? "",
              doctorStadt: appointment.doctorStadt ?? "",
            });
            if (
              appointment.estimatedTravelMinutes != null &&
              appointment.travelBufferMinutes != null
            ) {
              setFahrtdienstTravelData({
                pickupTime: appointment.scheduledStart.slice(0, 5),
                travelMinutes: appointment.estimatedTravelMinutes,
                bufferMinutes: appointment.travelBufferMinutes,
                distanceKm: 0,
                doctorLat: appointment.doctorLatitude ?? undefined,
                doctorLng: appointment.doctorLongitude ?? undefined,
              });
            }
          }
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
  }, [appointment, appointmentServiceEntries, catalogServices, appointmentServicesLoaded]);

  const hasAlltagsbegleitung = useMemo(() => {
    return services.some(s => {
      const catalog = catalogServices.find(c => c.id === s.serviceId);
      return catalog?.lohnartKategorie === "alltagsbegleitung";
    });
  }, [services, catalogServices]);

  useEffect(() => {
    if (!fahrtdienstInitializedRef.current) return;
    if (!hasAlltagsbegleitung && fahrtdienst.enabled) {
      setFahrtdienst({
        enabled: false,
        doctorName: "",
        doctorAppointmentTime: "",
        doctorStrasse: "",
        doctorNr: "",
        doctorPlz: "",
        doctorStadt: "",
      });
      setFahrtdienstTravelData(null);
    }
  }, [hasAlltagsbegleitung, fahrtdienst.enabled]);

  const customerForGeocode = appointment?.customer;
  useEffect(() => {
    if (!customerForGeocode || !fahrtdienst.enabled) {
      setGeocodingError(null);
      setIsGeocodingCustomer(false);
      return;
    }
    if (geocodedCoords && geocodedCoords.customerId === customerForGeocode.id) return;
    if (customerForGeocode.latitude && customerForGeocode.longitude) return;

    let cancelled = false;
    setIsGeocodingCustomer(true);
    setGeocodingError(null);
    api.post<{ latitude: number; longitude: number }>(`/customers/${customerForGeocode.id}/geocode`, {})
      .then((result) => {
        if (cancelled) return;
        const data = unwrapResult(result);
        setGeocodedCoords({ customerId: customerForGeocode.id, lat: data.latitude, lng: data.longitude });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setGeocodingError(err.message || "Kundenadresse konnte nicht aufgelöst werden");
      })
      .finally(() => {
        if (!cancelled) setIsGeocodingCustomer(false);
      });
    return () => { cancelled = true; };
  }, [customerForGeocode, fahrtdienst.enabled, geocodedCoords]);

  const effectiveCustomerLat = customerForGeocode?.latitude
    ?? (geocodedCoords?.customerId === customerForGeocode?.id ? geocodedCoords?.lat ?? null : null);
  const effectiveCustomerLng = customerForGeocode?.longitude
    ?? (geocodedCoords?.customerId === customerForGeocode?.id ? geocodedCoords?.lng ?? null : null);

  // Quelle: aktive Mitarbeiter (für Admin und Teamleiter gleichermaßen verfügbar).
  // Admins können die volle Liste aus useAdminEmployees nutzen, fallen aber auf
  // active-employees zurück, falls die Admin-Liste (noch) nicht geladen ist.
  const ktEmployeeSource = useMemo(() => {
    if (isAdmin && employees.length > 0) {
      return employees.filter(e => e.isActive).map(e => ({ id: e.id, displayName: e.displayName }));
    }
    return activeEmployees.map(e => ({ id: e.id, displayName: e.displayName }));
  }, [isAdmin, employees, activeEmployees]);

  const ktEmployeeOptions = useMemo(() => {
    if (appointment?.customer) {
      const c = appointment.customer;
      const assignedIds = [c.primaryEmployeeId, c.backupEmployeeId, c.backupEmployeeId2].filter(Boolean);
      if (assignedIds.length > 0) {
        return ktEmployeeSource
          .filter(e => assignedIds.includes(e.id))
          .map((e) => ({
            value: e.id.toString(),
            label: e.displayName + (e.id === c.primaryEmployeeId ? " (Haupt)" : e.id === c.backupEmployeeId ? " (Vertretung)" : " (2. Vertretung)"),
          }))
          .sort((a, b) => a.label.localeCompare(b.label, "de"));
      }
    }
    return ktEmployeeSource.map((e) => ({
      value: e.id.toString(),
      label: e.displayName,
    })).sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [ktEmployeeSource, appointment]);

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
      toast({ title: "Termin aktualisiert", description: "Die Änderungen wurden gespeichert." });
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const updateProspectMutation = useMutation({
    mutationFn: async ({ prospectId, data }: { prospectId: number; data: Record<string, unknown> }) => {
      const result = await api.patch(`/admin/prospects/${prospectId}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "prospects");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message || "Interessentendaten konnten nicht aktualisiert werden", variant: "destructive" });
    },
  });

  const seriesUpdateMutation = useMutation({
    mutationFn: async (data: { mode: "single" | "this_and_future" | "all_future"; updateFields: Record<string, unknown> }) => {
      const seriesId = appointment?.seriesId;
      if (!seriesId) throw new Error("Kein Serien-ID");
      const result = await api.post(`/appointment-series/${seriesId}/appointments/${id}/update`, {
        mode: data.mode,
        ...data.updateFields,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "appointment-series");
      toast({ title: "Serientermine aktualisiert" });
      setShowSeriesEditDialog(false);
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
      if (canChangeKtAssignment && !ktAssignedEmployeeId) {
        newErrors.ktAssignedEmployeeId = "Bitte wählen Sie einen Mitarbeiter";
      }
      if (hasAlltagsbegleitung && fahrtdienst.enabled) {
        if (!fahrtdienst.doctorAppointmentTime) newErrors.doctorAppointmentTime = "Arzt-Termin Uhrzeit ist erforderlich";
        if (!fahrtdienst.doctorStrasse) newErrors.doctorStrasse = "Arzt-Adresse (Straße) ist erforderlich";
        if (!fahrtdienst.doctorPlz || !/^\d{5}$/.test(fahrtdienst.doctorPlz)) newErrors.doctorPlz = "PLZ muss 5 Ziffern haben";
        if (!fahrtdienst.doctorStadt) newErrors.doctorStadt = "Arzt-Adresse (Ort) ist erforderlich";
      }
    } else if (appointment?.appointmentType === "Erstberatung") {
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

  const getSeriesUpdateFields = () => {
    if (!appointment) return {};
    const fields: Record<string, unknown> = {};
    if (date !== appointment.date) fields.date = date;
    const normalizedStart = (appointment.scheduledStart || "").slice(0, 5);
    if (time !== normalizedStart) fields.scheduledStart = time;
    if (canChangeKtAssignment && ktAssignedEmployeeId && parseInt(ktAssignedEmployeeId) !== appointment.assignedEmployeeId) {
      fields.assignedEmployeeId = parseInt(ktAssignedEmployeeId);
    }
    if ((notes || null) !== (appointment.notes || null)) fields.notes = notes || null;
    return fields;
  };

  // Diff für Erstberatung-Save: nur tatsächlich geänderte Felder werden an den
  // Server geschickt, damit der Backend-Konfliktcheck (Mitarbeiter, Wochenende)
  // bei reinen Notiz-Änderungen erst gar nicht greift.
  const getErstberatungUpdateFields = (): Record<string, unknown> => {
    if (!appointment) return {};
    const fields: Record<string, unknown> = {};
    if (date !== appointment.date) fields.date = date;
    const normalizedStart = (appointment.scheduledStart || "").slice(0, 5);
    const timeChanged = time !== normalizedStart;
    const durationChanged = duration !== appointment.durationPromised;
    if (timeChanged) fields.scheduledStart = time;
    if (timeChanged || durationChanged) {
      fields.scheduledEnd = addMinutesToTime(time, duration);
    }
    if (durationChanged) fields.durationPromised = duration;
    if ((notes || null) !== (appointment.notes || null)) fields.notes = notes || null;
    if (ebAssignedEmployeeId) {
      const newEmpId = parseInt(ebAssignedEmployeeId);
      if (newEmpId !== appointment.assignedEmployeeId) fields.assignedEmployeeId = newEmpId;
    }
    return fields;
  };

  // Diff für Kundentermin-Save: spart Konfliktchecks, wenn sich nur Notizen
  // ändern. Services werden nur mitgesendet, wenn sich Liste oder Dauern
  // unterscheiden.
  const getKundenterminUpdateFields = (): Record<string, unknown> => {
    if (!appointment) return {};
    const fields: Record<string, unknown> = {};
    if (date !== appointment.date) fields.date = date;
    const normalizedStart = (appointment.scheduledStart || "").slice(0, 5);
    const timeChanged = time !== normalizedStart;
    const totalDuration = services.reduce((sum, s) => sum + s.durationMinutes, 0);
    const durationChanged = totalDuration !== appointment.durationPromised;
    if (timeChanged) fields.scheduledStart = time;
    if (timeChanged || durationChanged) {
      fields.scheduledEnd = addMinutesToTime(time, totalDuration);
    }
    if (durationChanged) fields.durationPromised = totalDuration;
    if ((notes || null) !== (appointment.notes || null)) fields.notes = notes || null;
    if (canChangeKtAssignment && ktAssignedEmployeeId) {
      const newEmpId = parseInt(ktAssignedEmployeeId);
      if (newEmpId !== appointment.assignedEmployeeId) fields.assignedEmployeeId = newEmpId;
    }

    // Services-Diff: vergleiche aktuelle Auswahl mit Server-Stand.
    const originalSorted = [...appointmentServiceEntries]
      .map(e => ({ serviceId: e.serviceId, durationMinutes: e.plannedDurationMinutes }))
      .sort((a, b) => a.serviceId - b.serviceId);
    const currentSorted = [...services].sort((a, b) => a.serviceId - b.serviceId);
    const servicesChanged =
      originalSorted.length !== currentSorted.length ||
      originalSorted.some((o, i) =>
        o.serviceId !== currentSorted[i].serviceId ||
        o.durationMinutes !== currentSorted[i].durationMinutes
      );
    if (servicesChanged) {
      fields.services = services.map(s => ({
        serviceId: s.serviceId,
        plannedDurationMinutes: s.durationMinutes,
      }));
    }

    // Fahrtdienst-Diff: vergleiche alle relevanten Felder inkl. der routing-
    // Metadaten (Reisezeit, Puffer, Geokoordinaten). Bei jeder Änderung wird
    // die komplette Fahrtdienst-Payload geschickt, weil die Felder
    // zusammenhängen und die Backend-Validierung sie als Block erwartet.
    const fdEnabledNow = hasAlltagsbegleitung && fahrtdienst.enabled;
    const fdEnabledChanged = fdEnabledNow !== !!appointment.isFahrtdienst;
    const fdDoctorTimeChanged = (fahrtdienst.doctorAppointmentTime || "") !== ((appointment.doctorAppointmentTime ?? "").slice(0, 5));
    const fdDoctorAddrChanged =
      (fahrtdienst.doctorName || "") !== (appointment.doctorName ?? "") ||
      (fahrtdienst.doctorStrasse || "") !== (appointment.doctorStrasse ?? "") ||
      (fahrtdienst.doctorNr || "") !== (appointment.doctorNr ?? "") ||
      (fahrtdienst.doctorPlz || "") !== (appointment.doctorPlz ?? "") ||
      (fahrtdienst.doctorStadt || "") !== (appointment.doctorStadt ?? "");
    const fdRoutingChanged =
      (fahrtdienstTravelData?.travelMinutes ?? null) !== (appointment.estimatedTravelMinutes ?? null) ||
      (fahrtdienstTravelData?.bufferMinutes ?? null) !== (appointment.travelBufferMinutes ?? null) ||
      (fahrtdienstTravelData?.doctorLat ?? null) !== (appointment.doctorLatitude ?? null) ||
      (fahrtdienstTravelData?.doctorLng ?? null) !== (appointment.doctorLongitude ?? null);
    if (fdEnabledChanged || fdDoctorTimeChanged || fdDoctorAddrChanged || fdRoutingChanged) {
      Object.assign(fields, buildFahrtdienstPayload());
    }

    return fields;
  };

  const buildFahrtdienstPayload = (): Record<string, unknown> => {
    if (!hasAlltagsbegleitung || !fahrtdienst.enabled) {
      return {
        isFahrtdienst: false,
        doctorName: null,
        doctorAppointmentTime: null,
        doctorStrasse: null,
        doctorNr: null,
        doctorPlz: null,
        doctorStadt: null,
        doctorLatitude: null,
        doctorLongitude: null,
        estimatedTravelMinutes: null,
        travelBufferMinutes: null,
      };
    }
    const payload: Record<string, unknown> = {
      isFahrtdienst: true,
      doctorName: fahrtdienst.doctorName || null,
      doctorAppointmentTime: fahrtdienst.doctorAppointmentTime,
      doctorStrasse: fahrtdienst.doctorStrasse,
      doctorNr: fahrtdienst.doctorNr || null,
      doctorPlz: fahrtdienst.doctorPlz,
      doctorStadt: fahrtdienst.doctorStadt,
    };
    if (fahrtdienstTravelData) {
      payload.estimatedTravelMinutes = fahrtdienstTravelData.travelMinutes;
      payload.travelBufferMinutes = fahrtdienstTravelData.bufferMinutes;
      if (fahrtdienstTravelData.doctorLat !== undefined) payload.doctorLatitude = fahrtdienstTravelData.doctorLat;
      if (fahrtdienstTravelData.doctorLng !== undefined) payload.doctorLongitude = fahrtdienstTravelData.doctorLng;
    }
    return payload;
  };

  const handleSeriesUpdate = (mode: "single" | "this_and_future" | "all_future") => {
    if (mode === "single") {
      const totalDuration = services.reduce((sum, s) => sum + s.durationMinutes, 0);
      const calculatedEndTime = addMinutesToTime(time, totalDuration);
      updateMutation.mutate({
        date,
        scheduledStart: time,
        scheduledEnd: calculatedEndTime,
        durationPromised: totalDuration,
        notes: notes || null,
        assignedEmployeeId: canChangeKtAssignment && ktAssignedEmployeeId ? parseInt(ktAssignedEmployeeId) : undefined,
        services: services.map(s => ({
          serviceId: s.serviceId,
          plannedDurationMinutes: s.durationMinutes,
        })),
        ...buildFahrtdienstPayload(),
      });
      setShowSeriesEditDialog(false);
      return;
    }
    const updateFields = getSeriesUpdateFields();
    seriesUpdateMutation.mutate({ mode, updateFields });
  };

  // Cross-Team-Bestätigung: nur wenn ein Teamleiter (kein Admin) den Termin auf
  // einen Mitarbeiter aus einem fremden Team umhängt. Innerhalb des eigenen Teams
  // (oder wenn der Ziel-Mitarbeiter selbst der Teamleiter ist) keine Rückfrage.
  const crossTeamTarget = useMemo(() => {
    if (!isTeamLead || isAdmin) return null;
    if (!appointment || appointment.appointmentType !== "Kundentermin") return null;
    if (!ktAssignedEmployeeId) return null;
    const targetId = parseInt(ktAssignedEmployeeId);
    if (!targetId || targetId === appointment.assignedEmployeeId) return null;
    const target = activeEmployees.find(e => e.id === targetId);
    if (!target) return null;
    if (target.id === user?.id) return null;
    if (target.teamLeadId === user?.id) return null;
    return target;
  }, [isTeamLead, isAdmin, appointment, ktAssignedEmployeeId, activeEmployees, user?.id]);

  const handleSubmit = () => {
    if (!validate() || !appointment) return;

    if (crossTeamTarget) {
      setShowCrossTeamConfirm(true);
      return;
    }

    runSubmit();
  };

  const runSubmit = () => {
    if (!appointment) return;

    if (appointment.seriesId && appointment.appointmentType === "Kundentermin") {
      setShowSeriesEditDialog(true);
      return;
    }
    
    if (appointment.appointmentType === "Kundentermin") {
      const updateFields = getKundenterminUpdateFields();
      // Sicherheitsnetz: button-save ist via hasChanges deaktiviert, sodass
      // dieser Fall normalerweise nicht eintritt.
      if (Object.keys(updateFields).length === 0) return;
      updateMutation.mutate(updateFields);
    } else if (appointment.appointmentType === "Erstberatung") {
      const updateFields = getErstberatungUpdateFields();
      const prospectPayload = appointment.prospectId
        ? {
            vorname: ebVorname.trim(),
            nachname: ebNachname.trim(),
            telefon: ebTelefon.trim() || null,
            email: ebEmail.trim() || null,
            strasse: ebStrasse.trim() || null,
            nr: ebNr.trim() || null,
            plz: ebPlz.trim() || null,
            stadt: ebStadt.trim() || null,
            pflegegrad: ebPflegegrad && ebPflegegrad !== "none" ? parseInt(ebPflegegrad) : null,
          }
        : null;

      // Bei Erstberatung können sich Interessenten-Stammdaten parallel zum
      // Termin geändert haben. Wir senden den Prospect-PATCH unkonditional
      // (idempotent), erst danach den Termin-PATCH bzw. die Navigation.
      if (prospectPayload && appointment.prospectId) {
        updateProspectMutation.mutate(
          { prospectId: appointment.prospectId, data: prospectPayload },
          {
            onSuccess: () => {
              if (Object.keys(updateFields).length === 0) {
                // Termin selbst unverändert: nach erfolgreichem Stammdaten-
                // Update zurück zur Tagesansicht navigieren.
                toast({ title: "Termin aktualisiert", description: "Die Änderungen wurden gespeichert." });
                setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
                return;
              }
              updateMutation.mutate(updateFields);
            },
          },
        );
        return;
      }

      // Sicherheitsnetz: button-save ist via hasChanges deaktiviert, sodass
      // dieser Fall normalerweise nicht eintritt.
      if (Object.keys(updateFields).length === 0) return;
      updateMutation.mutate(updateFields);
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

  const isPending = updateMutation.isPending || updateProspectMutation.isPending || seriesUpdateMutation.isPending;

  // Stammdaten-Diff bei Erstberatung: Vergleicht die aktuell im Formular
  // sichtbaren Interessenten-Felder mit dem geladenen Stand.
  const hasProspectChanges = useMemo(() => {
    if (!appointment || appointment.appointmentType !== "Erstberatung") return false;
    if (!appointment.prospectId || !appointment.customer) return false;
    const c = appointment.customer;
    if (ebVorname.trim() !== (c.vorname || "")) return true;
    if (ebNachname.trim() !== (c.nachname || "")) return true;
    if ((ebTelefon.trim() || null) !== (c.telefon || null)) return true;
    if ((ebEmail.trim() || null) !== (c.email || null)) return true;
    if ((ebStrasse.trim() || null) !== (c.strasse || null)) return true;
    if ((ebNr.trim() || null) !== (c.nr || null)) return true;
    if ((ebPlz.trim() || null) !== (c.plz || null)) return true;
    if ((ebStadt.trim() || null) !== (c.stadt || null)) return true;
    const currentPg = ebPflegegrad && ebPflegegrad !== "none" ? parseInt(ebPflegegrad) : null;
    if (currentPg !== (c.pflegegrad ?? null)) return true;
    return false;
  }, [appointment, ebVorname, ebNachname, ebTelefon, ebEmail, ebStrasse, ebNr, ebPlz, ebStadt, ebPflegegrad]);

  // Speichern-Button-Status: aktiv nur, wenn es etwas zu speichern gibt.
  // Wir nutzen die bestehenden Diff-Funktionen, damit Button und tatsächlich
  // gesendete Felder synchron bleiben.
  const hasChanges = useMemo(() => {
    if (!appointment) return false;
    if (appointment.appointmentType === "Kundentermin") {
      return Object.keys(getKundenterminUpdateFields()).length > 0;
    }
    if (appointment.appointmentType === "Erstberatung") {
      if (hasProspectChanges) return true;
      return Object.keys(getErstberatungUpdateFields()).length > 0;
    }
    if (date !== appointment.date) return true;
    if (time !== (appointment.scheduledStart || "").slice(0, 5)) return true;
    if (duration !== appointment.durationPromised) return true;
    if ((notes || null) !== (appointment.notes || null)) return true;
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appointment,
    date,
    time,
    duration,
    notes,
    services,
    ktAssignedEmployeeId,
    ebAssignedEmployeeId,
    fahrtdienst,
    fahrtdienstTravelData,
    hasAlltagsbegleitung,
    appointmentServiceEntries,
    hasProspectChanges,
  ]);

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

  if (appointment.status === "completed" && !appointment.seriesId) {
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

      {appointment.seriesId && (
        <div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg" data-testid="banner-series-edit-info">
          <div className="flex items-center gap-2">
            <Repeat className={`${iconSize.sm} text-primary`} />
            <span className="text-sm font-medium text-primary">
              Teil einer Serie
            </span>
            <span className="text-xs text-muted-foreground">
              — Beim Speichern wählen Sie, ob nur dieser oder weitere Termine geändert werden
            </span>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {isKundentermin ? "Kundentermin" : "Erstberatung"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {isKundentermin && canChangeKtAssignment && (
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
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-1">
                <UserCheck className="h-4 w-4" />
                <span>Kontaktdaten des Interessenten</span>
              </div>
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
                <Clock className={`${iconSize.sm} inline mr-1`} />{" "}
                {isErstberatung ? "Startzeit *" : "Startzeit / Abholzeit"}
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
                renderAlltagsbegleitungDetails={() => (
                  <FahrtdienstDetails
                    fahrtdienst={fahrtdienst}
                    onChange={setFahrtdienst}
                    customerLat={effectiveCustomerLat}
                    customerLng={effectiveCustomerLng}
                    onPickupTimeCalculated={handlePickupTimeCalculated}
                    currentStartTime={time}
                    onApplyPickupTime={setTime}
                    errors={errors}
                    isGeocodingCustomer={isGeocodingCustomer}
                    geocodingError={geocodingError}
                  />
                )}
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
            disabled={isPending || !hasChanges}
            title={!hasChanges && !isPending ? "Keine Änderungen zu speichern" : undefined}
            data-testid="button-save"
          >
            {isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
            Änderungen speichern
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={showSeriesEditDialog} onOpenChange={setShowSeriesEditDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Repeat className={`${iconSize.md} text-primary`} />
              Serientermin ändern
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-1">
                <span className="block">Dieser Termin gehört zu einer Serie. Welche Termine möchten Sie ändern?</span>
                <span className="block text-xs">Bei Einzeländerung werden alle Felder inkl. Leistungen gespeichert. Bei Mehrfachänderung werden nur Datum, Uhrzeit, Mitarbeiter und Notizen für die Serie angepasst.</span>
                {appointment?.status === "completed" && (
                  <span className="block mt-2 text-amber-600 font-medium">
                    Dieser Termin ist bereits dokumentiert und kann nicht einzeln geändert werden. Sie können aber alle zukünftigen Termine anpassen.
                  </span>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 py-2">
            <button
              onClick={() => handleSeriesUpdate("single")}
              disabled={seriesUpdateMutation.isPending || appointment?.status === "completed"}
              className="w-full p-4 rounded-lg border-2 text-left hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="button-series-edit-single"
            >
              <span className="font-semibold text-sm">Nur diesen Termin ändern</span>
              <span className="block text-xs text-muted-foreground mt-1">
                Alle anderen Serientermine bleiben unverändert
              </span>
            </button>
            <button
              onClick={() => handleSeriesUpdate("this_and_future")}
              disabled={seriesUpdateMutation.isPending}
              className="w-full p-4 rounded-lg border-2 text-left hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="button-series-edit-this-and-future"
            >
              <span className="font-semibold text-sm">Diesen und alle folgenden ändern</span>
              <span className="block text-xs text-muted-foreground mt-1">
                Ab diesem Termin werden alle zukünftigen Termine geändert
              </span>
            </button>
            <button
              onClick={() => handleSeriesUpdate("all_future")}
              disabled={seriesUpdateMutation.isPending}
              className="w-full p-4 rounded-lg border-2 text-left hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="button-series-edit-all-future"
            >
              <span className="font-semibold text-sm">Alle zukünftigen Termine ändern</span>
              <span className="block text-xs text-muted-foreground mt-1">
                Alle zukünftigen Termine der Serie werden angepasst
              </span>
            </button>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={seriesUpdateMutation.isPending}>Abbrechen</AlertDialogCancel>
          </AlertDialogFooter>
          {seriesUpdateMutation.isPending && (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showCrossTeamConfirm} onOpenChange={setShowCrossTeamConfirm}>
        <AlertDialogContent className="max-w-md" data-testid="dialog-cross-team-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className={`${iconSize.md} text-amber-500`} />
              Mitarbeiter aus anderem Team
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-2">
                <span className="block">
                  <strong data-testid="text-cross-team-target-name">{crossTeamTarget?.displayName}</strong>{" "}
                  gehört nicht zu Ihrem Team.
                </span>
                {crossTeamTarget?.teamLeadName && (
                  <span className="block">
                    Teamleitung:{" "}
                    <strong data-testid="text-cross-team-lead-name">{crossTeamTarget.teamLeadName}</strong>
                  </span>
                )}
                <span className="block">
                  Möchten Sie die Zuweisung trotzdem speichern?
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cross-team-cancel">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-cross-team-confirm"
              onClick={() => {
                setShowCrossTeamConfirm(false);
                runSubmit();
              }}
            >
              Trotzdem speichern
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
