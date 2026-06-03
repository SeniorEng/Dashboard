import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { api, unwrapResult } from "@/lib/api/client";
import { addMinutesToTime, timeToMinutes, minutesToTimeDisplay, formatDurationDisplay } from "@shared/utils/datetime";
import { canModifyAppointment, type AppointmentStatus } from "@shared/domain/appointments";
import { useAppointment } from "./use-appointments";
import { useCustomerList } from "./use-customer-list";
import { useActiveEmployees, useAdminEmployees } from "./use-active-employees";
import {
  useAppointmentServiceEntries,
  useCatalogServices,
  useCostEstimate,
} from "./use-edit-appointment-data";
import { useEditAppointmentMutations } from "./use-edit-appointment-mutations";
import { shouldResetFahrtdienst } from "../utils";
import { computeErstberatungUpdateFields } from "../lib/edit-diff";
import type { FahrtdienstState } from "../components/fahrtdienst-panel";

export function useEditAppointment(id: number) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin ?? false;
  const isTeamLead = user?.isTeamLead ?? false;
  const canChangeKtAssignment = isAdmin || isTeamLead;
  // Stammdaten des Interessenten (Name, Telefon, Adresse, Pflegegrad) dürfen
  // nur Admins und Nutzer mit Erstberatungs-Rolle ändern. Teamleitungen ohne
  // diese Rolle können den Termin trotzdem verlegen, sehen die Stammdaten-
  // Felder aber schreibgeschützt.
  const canEditProspectFields = isAdmin || (user?.roles?.includes("erstberatung") ?? false);

  const { data: appointment, isLoading: appointmentLoading } = useAppointment(id);

  const { data: customers = [] } = useCustomerList();
  const { data: employees = [] } = useAdminEmployees({ enabled: isAdmin });
  // Aktive Mitarbeiter inklusive Teamleiter-Info (für Cross-Team-Confirm).
  const { data: activeEmployees = [] } = useActiveEmployees({ enabled: canChangeKtAssignment });

  const { data: appointmentServiceEntries = [], isSuccess: appointmentServicesLoaded } = useAppointmentServiceEntries(id);

  const { data: catalogServices = [], isSuccess: catalogServicesLoaded } = useCatalogServices();

  const [date, setDate] = useState<string>("");
  const [time, setTime] = useState<string>("");
  const [services, setServices] = useState<Array<{ serviceId: number; durationMinutes: number }>>([]);
  const [notes, setNotes] = useState<string>("");
  const [endTime, setEndTime] = useState<string>("");
  const [duration, setDuration] = useState<number>(60);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ktAssignedEmployeeId, setKtAssignedEmployeeId] = useState<string>("");
  const [showSeriesEditDialog, setShowSeriesEditDialog] = useState(false);

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
  // Initiale Mount-Werte für time/duration festhalten, damit der Erstberatungs-
  // Diff nicht gegen einen potenziell driftenden `durationPromised`-Wert aus
  // der DB vergleicht (siehe edit-diff.ts). Wird beim ersten Befüllen des
  // Formulars einmal gesetzt und nur bei Wechsel der Termin-ID zurückgesetzt
  // (Schutz gegen Stale-Baseline, falls die Komponente für einen anderen
  // Termin wiederverwendet wird).
  const initialTimeRef = useRef<string | null>(null);
  const initialDurationRef = useRef<number | null>(null);
  const initialBaselineAppointmentIdRef = useRef<number | null>(null);
  // Guard, der die initiale Befüllung von date/time/notes/employee/customer
  // genau einmal pro Termin-ID erlaubt. Ohne diesen Guard würde der
  // useEffect bei jedem Eintreffen einer Sekundär-Query
  // (appointmentServiceEntries, catalogServices) die Formularfelder erneut
  // aus dem Server-Stand setzen und damit gerade vorgenommene Nutzer-
  // Änderungen überschreiben (Task #632: Zeit-Fill kurz vor dem Eintreffen
  // der Services-Antwort wurde auf den alten Wert zurückgesetzt → PATCH
  // ohne `scheduledStart`).
  const formInitializedRef = useRef<number | null>(null);
  const servicesInitializedRef = useRef<number | null>(null);

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
      if (initialBaselineAppointmentIdRef.current !== appointment.id) {
        initialBaselineAppointmentIdRef.current = appointment.id;
        initialTimeRef.current = null;
        initialDurationRef.current = null;
        formInitializedRef.current = null;
        servicesInitializedRef.current = null;
        fahrtdienstInitializedRef.current = false;
      }

      const needsFormInit = formInitializedRef.current !== appointment.id;
      if (needsFormInit) {
        formInitializedRef.current = appointment.id;
        setDate(appointment.date);
        const initialTime = appointment.scheduledStart.slice(0, 5);
        setTime(initialTime);
        setNotes(appointment.notes || "");
        if (initialTimeRef.current === null) {
          initialTimeRef.current = initialTime;
        }
      }

      if (appointment.appointmentType === "Kundentermin") {
        // Services-Initialisierung wartet auf das erfolgreiche Laden der
        // Services-Query und passiert dann genau einmal pro Termin-ID —
        // ein späterer Refetch darf eine in der Zwischenzeit vom Nutzer
        // geänderte Service-Auswahl nicht überschreiben.
        if (
          appointmentServicesLoaded &&
          servicesInitializedRef.current !== appointment.id
        ) {
          servicesInitializedRef.current = appointment.id;
          if (appointmentServiceEntries.length > 0) {
            setServices(appointmentServiceEntries.map(e => ({
              serviceId: e.serviceId,
              durationMinutes: e.plannedDurationMinutes,
            })));
          }
        }
        if (needsFormInit && appointment.assignedEmployeeId) {
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
      } else if (needsFormInit) {
        if (appointment.scheduledEnd) {
          const start = appointment.scheduledStart.slice(0, 5);
          const end = appointment.scheduledEnd.slice(0, 5);
          setEndTime(end);
          const startMin = timeToMinutes(start);
          const endMin = timeToMinutes(end);
          const dur = endMin - startMin;
          if (dur > 0) {
            setDuration(dur);
            if (initialDurationRef.current === null) {
              initialDurationRef.current = dur;
            }
          }
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
    // Reset NUR ausführen, wenn der Servicekatalog wirklich geladen ist –
    // sonst könnte ein langsames `/api/services` einen gespeicherten
    // Fahrtdienst-Block kurzzeitig zurücksetzen, bevor der Katalog ankommt
    // und `hasAlltagsbegleitung` korrekt berechnet werden kann.
    if (!shouldResetFahrtdienst({
      catalogLoaded: catalogServicesLoaded,
      fahrtdienstInitialized: fahrtdienstInitializedRef.current,
      hasAlltagsbegleitung,
      fahrtdienstEnabled: fahrtdienst.enabled,
    })) {
      return;
    }
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
  }, [catalogServicesLoaded, hasAlltagsbegleitung, fahrtdienst.enabled]);

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

  // Admins haben Zugriff auf /admin/employees mit vollen Stammdaten;
  // Teamleitungen (ohne diesen Zugriff) nutzen die nicht-sensible
  // active-employees-Liste, die ebenfalls die Rollen enthält.
  const ebEmployeeOptions = useMemo(() => {
    if (isAdmin && employees.length > 0) {
      return employees
        .filter(e => e.isActive && e.roles?.includes("erstberatung"))
        .map((e) => ({
          value: e.id.toString(),
          label: e.displayName,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "de"));
    }
    return activeEmployees
      .filter(e => e.roles?.includes("erstberatung"))
      .map((e) => ({
        value: e.id.toString(),
        label: e.displayName,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [isAdmin, employees, activeEmployees]);

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

  const budgetEstimateParams = useMemo(() => {
    if (!appointment?.customerId || services.length === 0) return null;
    const serviceIds = services.map(s => s.serviceId).join(",");
    const serviceDurations = services.map(s => s.durationMinutes).join(",");
    if (!serviceIds) return null;
    const params = new URLSearchParams();
    params.set("serviceIds", serviceIds);
    params.set("serviceDurations", serviceDurations);
    params.set("date", date);
    return params.toString();
  }, [appointment?.customerId, services, date]);

  const { data: costEstimate } = useCostEstimate(appointment?.customerId, budgetEstimateParams);

  const { updateMutation, updateProspectMutation, seriesUpdateMutation } = useEditAppointmentMutations({
    id,
    appointment,
    setLocation,
    setShowSeriesEditDialog,
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
      if (canChangeKtAssignment && !ebAssignedEmployeeId) newErrors.ebAssignedEmployeeId = "Bitte einen Mitarbeiter auswählen";
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
  // bei reinen Notiz-Änderungen erst gar nicht greift. Vergleich gegen die
  // initialen Mount-Werte (Refs), nicht gegen `appointment.durationPromised`,
  // weil das bei bereits gestarteten Terminen vom tatsächlichen
  // `scheduledEnd-scheduledStart` driften kann (Task #595).
  const getErstberatungUpdateFields = (): Record<string, unknown> => {
    if (!appointment) return {};
    return computeErstberatungUpdateFields({
      originalDate: appointment.date,
      originalNotes: appointment.notes ?? null,
      originalAssignedEmployeeId: appointment.assignedEmployeeId ?? null,
      initialTime: initialTimeRef.current ?? (appointment.scheduledStart || "").slice(0, 5),
      initialDuration: initialDurationRef.current ?? appointment.durationPromised,
      date,
      time,
      duration,
      notes,
      assignedEmployeeId: ebAssignedEmployeeId,
    });
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

  const handleSubmit = () => {
    if (!validate() || !appointment) return;
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

      // Stammdaten-PATCH nur dann feuern, wenn (a) der Nutzer sie überhaupt
      // ändern darf, (b) ein verknüpfter Interessent existiert und (c) sich
      // tatsächlich ein Stammdaten-Feld geändert hat. Sonst würde z. B. ein
      // bedingungsloser PATCH eine Teamleitung ohne Erstberatungs-Rolle
      // blockieren und das nachgelagerte Termin-Update verhindern.
      const shouldUpdateProspect =
        canEditProspectFields && !!appointment.prospectId && hasProspectChanges;

      if (shouldUpdateProspect) {
        const prospectPayload = {
          vorname: ebVorname.trim(),
          nachname: ebNachname.trim(),
          telefon: ebTelefon.trim() || null,
          email: ebEmail.trim() || null,
          strasse: ebStrasse.trim() || null,
          nr: ebNr.trim() || null,
          plz: ebPlz.trim() || null,
          stadt: ebStadt.trim() || null,
          pflegegrad: ebPflegegrad && ebPflegegrad !== "none" ? parseInt(ebPflegegrad) : null,
        };

        updateProspectMutation.mutate(
          { prospectId: appointment.prospectId!, data: prospectPayload },
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
      // Stammdaten-Änderungen zählen nur, wenn der Nutzer sie auch speichern
      // darf — sonst würde der Speichern-Button für Teamleitungen ohne
      // Erstberatungs-Rolle „grundlos" aktiv erscheinen, obwohl die Felder
      // disabled sind.
      if (hasProspectChanges && canEditProspectFields) return true;
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
    canEditProspectFields,
  ]);

  const isKundentermin = appointment?.appointmentType === "Kundentermin";
  const isErstberatung = appointment?.appointmentType === "Erstberatung";
  // Status `completed`/`customer_no_show` sperren Notizen, Mitarbeiterzuweisung
  // und alle Scheduling-Felder — das deckt sich mit `canModifyAppointment`.
  // `scheduled` und `documenting` bleiben editierbar (Task #638).
  const ebFullyLocked = isErstberatung && !!appointment && !canModifyAppointment(appointment.status as AppointmentStatus);
  const ebLockHint = ebFullyLocked
    ? "Dieser Termin ist abgeschlossen — Änderungen sind nicht mehr möglich."
    : null;

  // Verhindert „unused variable"-Warnung; der Hook lädt die Kundenliste
  // bewusst (Prefetch/Cache-Wärmung) wie im ursprünglichen Seitencode.
  void customers;

  return {
    appointment,
    appointmentLoading,
    isAdmin,
    isKundentermin,
    isErstberatung,
    canChangeKtAssignment,
    canEditProspectFields,
    date,
    setDate,
    time,
    setTime,
    duration,
    setDuration,
    setEndTime,
    notes,
    setNotes,
    services,
    setServices,
    errors,
    ktAssignedEmployeeId,
    setKtAssignedEmployeeId,
    ktEmployeeOptions,
    ebVorname,
    setEbVorname,
    ebNachname,
    setEbNachname,
    ebTelefon,
    setEbTelefon,
    ebEmail,
    setEbEmail,
    ebStrasse,
    setEbStrasse,
    ebNr,
    setEbNr,
    ebPlz,
    setEbPlz,
    ebStadt,
    setEbStadt,
    ebPflegegrad,
    setEbPflegegrad,
    ebAssignedEmployeeId,
    setEbAssignedEmployeeId,
    ebEmployeeOptions,
    fahrtdienst,
    setFahrtdienst,
    effectiveCustomerLat,
    effectiveCustomerLng,
    isGeocodingCustomer,
    geocodingError,
    handlePickupTimeCalculated,
    summary,
    costEstimate,
    ebFullyLocked,
    ebLockHint,
    showSeriesEditDialog,
    setShowSeriesEditDialog,
    handleSubmit,
    handleSeriesUpdate,
    isPending,
    hasChanges,
    seriesUpdatePending: seriesUpdateMutation.isPending,
    setLocation,
  };
}
