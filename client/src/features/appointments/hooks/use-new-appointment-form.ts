import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import { useAuth, canCreateErstberatung } from "@/hooks/use-auth";
import { api, unwrapResult } from "@/lib/api/client";
import { useCustomerList } from "./use-customer-list";
import { shouldResetFahrtdienst } from "../utils";
import { useActiveEmployees, useAdminEmployees } from "./use-active-employees";
import { useCreateKundentermin, useCreateErstberatung } from "./use-appointment-mutations";
import { useCreateAppointmentSeries, usePreviewAppointmentSeries } from "./use-appointment-series";
import type { SeriesCreateInput } from "./use-appointment-series";
import { timeToMinutes, minutesToTimeDisplay, formatDurationDisplay, todayISO } from "@shared/utils/datetime";
import type { Weekday, SeriesFrequency } from "@shared/schema/appointments";
import { isDachPhone } from "@shared/schema/common";
import type { Service } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";
import type { FahrtdienstState } from "../components/fahrtdienst-panel";

export function useNewAppointmentForm() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const copyFromId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("copyFrom") : null;
  const isAdmin = user?.isAdmin ?? false;
  const isTeamLead = user?.isTeamLead ?? false;
  const canChangeAssignment = isAdmin || isTeamLead;
  const canErstberatung = canCreateErstberatung(user?.roles ?? [], isAdmin);
  const wantsErstberatung = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("type") === "erstberatung";
  const requestedTab = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const initialTab = copyFromId
    ? "kundentermin"
    : requestedTab === "eintrag"
      ? "eintrag"
      : requestedTab === "erstberatung" && canErstberatung
        ? "erstberatung"
        : (wantsErstberatung && canErstberatung ? "erstberatung" : "kundentermin");
  const [activeTab, setActiveTab] = useState<string>(initialTab);

  const { data: customers = [], isLoading: customersLoading } = useCustomerList();
  const { data: employees = [] } = useAdminEmployees({ enabled: isAdmin });
  // Teamleitungen haben keinen Zugriff auf /admin/employees, sehen die aktive
  // Mitarbeiterliste aber über /appointments/active-employees (inkl. Rollen).
  const { data: activeEmployees = [] } = useActiveEmployees({ enabled: canChangeAssignment });

  const createKundenterminMutation = useCreateKundentermin();
  const createErstberatungMutation = useCreateErstberatung();
  const createSeriesMutation = useCreateAppointmentSeries();
  const previewSeriesMutation = usePreviewAppointmentSeries();

  const [seriesEnabled, setSeriesEnabled] = useState(false);
  const [seriesWeekdays, setSeriesWeekdays] = useState<Weekday[]>([]);
  const [seriesFrequency, setSeriesFrequency] = useState<SeriesFrequency>("weekly");
  const [seriesEndDate, setSeriesEndDate] = useState<string>("");
  const [seriesConflicts, setSeriesConflicts] = useState<Array<{ date: string; reason: string }>>([]);
  const [showSeriesConflictDialog, setShowSeriesConflictDialog] = useState(false);
  const [seriesConflictInfo, setSeriesConflictInfo] = useState<{ totalDates: number; validDates: number } | null>(null);
  const [pendingSeriesInput, setPendingSeriesInput] = useState<SeriesCreateInput | null>(null);

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
  const [geocodedCoords, setGeocodedCoords] = useState<{ customerId: string; lat: number; lng: number } | null>(null);

  const handlePickupTimeCalculated = useCallback((
    pickupTime: string,
    travelMinutes: number,
    bufferMinutes: number,
    distanceKm: number,
    doctorLat?: number,
    doctorLng?: number,
  ) => {
    // Routing-Daten merken (für die Termin-Payload), aber die Startzeit
    // bewusst NICHT mehr automatisch überschreiben — die Übernahme erfolgt
    // jetzt explizit per Knopf in <FahrtdienstDetails />.
    setFahrtdienstTravelData({ pickupTime, travelMinutes, bufferMinutes, distanceKm, doctorLat, doctorLng });
  }, []);

  const { data: catalogServices = [], isSuccess: catalogServicesLoaded } = useQuery<Service[]>({
    queryKey: ["/api/services"],
    staleTime: 60_000,
  });

  const copyFromNumericId = copyFromId ? parseInt(copyFromId) : 0;
  const { data: copyFromAppointment } = useQuery<AppointmentWithCustomer>({
    queryKey: [`/api/appointments/${copyFromNumericId}`],
    queryFn: async () => {
      const result = await api.get<AppointmentWithCustomer>(`/appointments/${copyFromNumericId}`);
      return unwrapResult(result);
    },
    enabled: copyFromNumericId > 0,
    staleTime: 60_000,
  });

  const { data: copyFromServices } = useQuery<Array<{
    id: number;
    serviceId: number;
    serviceName: string;
    serviceCode: string;
    serviceUnitType: string;
    plannedDurationMinutes: number;
    actualDurationMinutes: number | null;
    details: string | null;
  }>>({
    queryKey: [`/api/appointments/${copyFromNumericId}/services`],
    queryFn: async () => {
      const result = await api.get<Array<{
        id: number;
        serviceId: number;
        serviceName: string;
        serviceCode: string;
        serviceUnitType: string;
        plannedDurationMinutes: number;
        actualDurationMinutes: number | null;
        details: string | null;
      }>>(`/appointments/${copyFromNumericId}/services`);
      return unwrapResult(result);
    },
    enabled: copyFromNumericId > 0 && !!copyFromAppointment,
    staleTime: 60_000,
  });

  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialCustomerId = urlParams.get("customerId") ?? "";
  const [ktCustomerId, setKtCustomerId] = useState<string>(initialCustomerId);
  const initialDate = urlParams.get("date") && /^\d{4}-\d{2}-\d{2}$/.test(urlParams.get("date")!) ? urlParams.get("date")! : todayISO();

  const [ktDate, setKtDate] = useState<string>(initialDate);
  const [ktTime, setKtTime] = useState<string>("09:00");
  const [ktServices, setKtServices] = useState<Array<{ serviceId: number; durationMinutes: number }>>([]);
  const [ktNotes, setKtNotes] = useState<string>("");
  const [ktAssignedEmployeeId, setKtAssignedEmployeeId] = useState<string>("");
  const fromProspectId = urlParams.get("prospectId");

  interface ProspectAppointmentData {
    id: number;
    vorname: string;
    nachname: string;
    telefon: string | null;
    email: string | null;
    strasse: string | null;
    nr: string | null;
    plz: string | null;
    stadt: string | null;
    pflegegrad: number | null;
  }

  const { data: prospectData } = useQuery<ProspectAppointmentData>({
    queryKey: ["prospect-appointment-data", fromProspectId],
    queryFn: async () => {
      const result = await api.get<{ prospect: ProspectAppointmentData; appointments: unknown[] }>(`/prospects/${fromProspectId}/appointment-data`);
      const data = unwrapResult(result);
      return data.prospect;
    },
    enabled: !!fromProspectId,
    staleTime: 60_000,
  });

  const [ebDate, setEbDate] = useState<string>(initialDate);
  const [ebStartTime, setEbStartTime] = useState<string>(urlParams.get("time") || "09:00");
  const [ebErstberatungDauer, setEbErstberatungDauer] = useState<number>(60);
  const [ebNotes, setEbNotes] = useState<string>("");
  const [ebAssignedEmployeeId, setEbAssignedEmployeeId] = useState<string>(urlParams.get("employeeId") || "");

  const [prospectMode, setProspectMode] = useState<"existing" | "new">("existing");
  const [selectedExistingProspectId, setSelectedExistingProspectId] = useState<number | null>(null);

  const [inlineProspectVorname, setInlineProspectVorname] = useState<string>("");
  const [inlineProspectNachname, setInlineProspectNachname] = useState<string>("");
  const [inlineProspectTelefon, setInlineProspectTelefon] = useState<string>("");
  const [inlineProspectEmail, setInlineProspectEmail] = useState<string>("");
  const [inlineProspectStrasse, setInlineProspectStrasse] = useState<string>("");
  const [inlineProspectNr, setInlineProspectNr] = useState<string>("");
  const [inlineProspectPlz, setInlineProspectPlz] = useState<string>("");
  const [inlineProspectStadt, setInlineProspectStadt] = useState<string>("");
  const [inlineProspectPflegegrad, setInlineProspectPflegegrad] = useState<string>("");
  const [inlineProspectCreatedId, setInlineProspectCreatedId] = useState<number | null>(null);

  const createInlineProspectMutation = useMutation({
    mutationFn: async (data: {
      vorname: string;
      nachname: string;
      telefon?: string;
      email?: string;
      strasse?: string;
      nr?: string;
      plz?: string;
      stadt?: string;
      pflegegrad?: number;
    }) => {
      const result = await api.post<{ id: number; vorname: string; nachname: string; telefon: string | null }>("/prospects/inline", {
        ...data,
        quelleDetails: "Telefonischer Erstkontakt — Erstberatung direkt vereinbart",
      });
      return unwrapResult(result);
    },
    onSuccess: (prospect) => {
      setInlineProspectCreatedId(prospect.id);
      toast({ title: "Interessent angelegt", description: `${prospect.vorname} ${prospect.nachname} wurde als Interessent erstellt.` });
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const effectiveProspectId = fromProspectId || (selectedExistingProspectId ? String(selectedExistingProspectId) : null) || (inlineProspectCreatedId ? String(inlineProspectCreatedId) : null);

  const { data: inlineProspectData } = useQuery<ProspectAppointmentData>({
    queryKey: ["prospect-appointment-data", inlineProspectCreatedId],
    queryFn: async () => {
      const result = await api.get<{ prospect: ProspectAppointmentData; appointments: unknown[] }>(`/prospects/${inlineProspectCreatedId}/appointment-data`);
      return unwrapResult(result).prospect;
    },
    enabled: !!inlineProspectCreatedId && !fromProspectId,
    staleTime: 60_000,
  });

  const { data: selectedProspectData } = useQuery<ProspectAppointmentData>({
    queryKey: ["prospect-appointment-data", selectedExistingProspectId],
    queryFn: async () => {
      const result = await api.get<{ prospect: ProspectAppointmentData; appointments: unknown[] }>(`/prospects/${selectedExistingProspectId}/appointment-data`);
      return unwrapResult(result).prospect;
    },
    enabled: !!selectedExistingProspectId && !fromProspectId,
    staleTime: 60_000,
  });

  const effectiveProspectData = fromProspectId ? (prospectData ?? null) : (selectedProspectData ?? inlineProspectData ?? null);

  const defaultsInitialized = useRef(false);
  const copyFromInitialized = useRef(false);
  useEffect(() => {
    if (copyFromId) return;
    if (catalogServices.length > 0 && !defaultsInitialized.current) {
      defaultsInitialized.current = true;
      const defaults = catalogServices
        .filter(s => s.isDefault && s.isActive && s.unitType === "hours" && (!s.code || !["erstberatung", "kilometer"].includes(s.code)))
        .map(s => ({ serviceId: s.id, durationMinutes: s.minDurationMinutes || 60 }));
      if (defaults.length > 0) {
        setKtServices(defaults);
      }
    }
  }, [catalogServices, copyFromId]);

  useEffect(() => {
    if (!copyFromId || copyFromInitialized.current) return;
    if (!copyFromAppointment) return;

    if (!copyFromServices) return;

    copyFromInitialized.current = true;
    defaultsInitialized.current = true;

    setKtCustomerId(copyFromAppointment.customerId?.toString() ?? "");
    if (copyFromAppointment.assignedEmployeeId) {
      setKtAssignedEmployeeId(copyFromAppointment.assignedEmployeeId.toString());
    }
    setKtNotes(copyFromAppointment.notes || "");
    const copiedServices = copyFromServices.map(s => ({
      serviceId: s.serviceId,
      durationMinutes: s.plannedDurationMinutes,
    }));
    if (copiedServices.length > 0) {
      setKtServices(copiedServices);
    }

    toast({ title: "Termin als Vorlage geladen" });
  }, [copyFromId, copyFromAppointment, copyFromServices, toast]);

  const [errors, setErrors] = useState<Record<string, string>>({});

  const budgetEstimateParams = useMemo(() => {
    if (!ktCustomerId || ktServices.length === 0) return null;
    const serviceIds = ktServices.map(s => s.serviceId).join(",");
    const serviceDurations = ktServices.map(s => s.durationMinutes).join(",");
    if (!serviceIds) return null;
    const params = new URLSearchParams();
    params.set("serviceIds", serviceIds);
    params.set("serviceDurations", serviceDurations);
    params.set("date", ktDate);
    return params.toString();
  }, [ktCustomerId, ktServices, ktDate]);

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
    isSelbstzahler?: boolean;
    bruttoCents?: number;
    vatCents?: number;
    vatRate?: number;
  }>({
    queryKey: ["/api/budget", ktCustomerId, "cost-estimate", budgetEstimateParams],
    queryFn: async () => {
      const result = await api.get<{
        totalCents: number;
        warning: string | null;
        noPricing?: boolean;
        availableCents?: number;
        currentMonthUsedCents?: number;
        monthlyLimitCents?: number | null;
        projectedMonthUsedCents?: number;
        isHardBlock?: boolean;
        acceptsPrivatePayment?: boolean;
        isSelbstzahler?: boolean;
        bruttoCents?: number;
        vatCents?: number;
        vatRate?: number;
      }>(`/budget/${ktCustomerId}/cost-estimate?${budgetEstimateParams}`);
      if (!result.success) return { totalCents: 0, warning: null };
      return result.data;
    },
    enabled: !!ktCustomerId && !!budgetEstimateParams,
    staleTime: 30_000,
  });

  const hasAlltagsbegleitung = useMemo(() => {
    return ktServices.some(s => {
      const catalog = catalogServices.find(c => c.id === s.serviceId);
      return catalog?.lohnartKategorie === "alltagsbegleitung";
    });
  }, [ktServices, catalogServices]);

  useEffect(() => {
    // Erst zurücksetzen, wenn der Servicekatalog wirklich da ist – so kann
    // ein verzögertes `/api/services` keinen bereits ausgewählten
    // Fahrtdienst-Block aus Versehen aushebeln.
    if (!shouldResetFahrtdienst({
      catalogLoaded: catalogServicesLoaded,
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
    if (canChangeAssignment && !ktAssignedEmployeeId) newErrors.ktAssignedEmployeeId = "Bitte wählen Sie einen Mitarbeiter";
    if (hasAlltagsbegleitung && fahrtdienst.enabled) {
      if (!fahrtdienst.doctorAppointmentTime) newErrors.doctorAppointmentTime = "Arzt-Termin Uhrzeit ist erforderlich";
      if (!fahrtdienst.doctorStrasse) newErrors.doctorStrasse = "Arzt-Adresse (Straße) ist erforderlich";
      if (!fahrtdienst.doctorPlz || !/^\d{5}$/.test(fahrtdienst.doctorPlz)) newErrors.doctorPlz = "PLZ muss 5 Ziffern haben";
      if (!fahrtdienst.doctorStadt) newErrors.doctorStadt = "Arzt-Adresse (Ort) ist erforderlich";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateErstberatung = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!effectiveProspectId) newErrors.ebProspect = "Bitte legen Sie zuerst einen Interessenten an";
    if (canChangeAssignment && !ebAssignedEmployeeId) newErrors.ebAssignedEmployeeId = "Bitte wählen Sie einen Mitarbeiter";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const seriesPreview = useMemo(() => {
    if (!seriesEnabled || seriesWeekdays.length === 0 || !seriesEndDate || !ktDate) return null;

    const startDateObj = new Date(ktDate + "T00:00:00");
    const endDateObj = new Date(seriesEndDate + "T00:00:00");
    if (endDateObj <= startDateObj) return null;

    const weekdayMap: Record<string, number> = { mo: 1, di: 2, mi: 3, do: 4, fr: 5 };
    const selectedJsDays = seriesWeekdays.map(d => weekdayMap[d]).filter(Boolean);

    const dates: string[] = [];
    const current = new Date(startDateObj);
    let weekCounter = 0;
    let lastWeek = -1;

    while (current <= endDateObj) {
      const jsDay = current.getDay();
      const weekNum = Math.floor((current.getTime() - startDateObj.getTime()) / (7 * 24 * 60 * 60 * 1000));

      if (weekNum !== lastWeek) {
        if (lastWeek >= 0) weekCounter++;
        lastWeek = weekNum;
      }

      const isActiveWeek = seriesFrequency === "weekly" || weekCounter % 2 === 0;

      if (isActiveWeek && selectedJsDays.includes(jsDay === 0 ? 7 : jsDay)) {
        const y = current.getFullYear();
        const m = String(current.getMonth() + 1).padStart(2, "0");
        const d = String(current.getDate()).padStart(2, "0");
        dates.push(`${y}-${m}-${d}`);
      }

      current.setDate(current.getDate() + 1);
    }

    const totalMinutes = ktServices.reduce((sum, s) => sum + s.durationMinutes, 0);

    return {
      count: dates.length,
      dates,
      totalMinutes,
      weekdays: seriesWeekdays,
      frequency: seriesFrequency,
      startDate: ktDate,
      endDate: seriesEndDate,
      startTime: ktTime,
    };
  }, [seriesEnabled, seriesWeekdays, seriesFrequency, seriesEndDate, ktDate, ktTime, ktServices]);

  const confirmSeriesCreate = (input: SeriesCreateInput) => {
    createSeriesMutation.mutate(input, {
      onSuccess: (response) => {
        const created = response.createdAppointments;
        toast({ title: "Terminserie erstellt", description: `${created} Termine wurden angelegt.` });
        if (response._budgetWarning) {
          setTimeout(() => {
            toast({ title: "Budget-Hinweis", description: response._budgetWarning, variant: "destructive" });
          }, 500);
        }
        setShowSeriesConflictDialog(false);
        setSeriesConflicts([]);
        setSeriesConflictInfo(null);
        setPendingSeriesInput(null);
        setLocation(input.startDate ? `/?date=${input.startDate}` : "/");
      },
      onError: (error: Error) => {
        toast({ variant: "destructive", title: "Fehler", description: error.message });
      },
    });
  };

  const handleKundenterminSubmit = () => {
    if (!validateKundentermin()) return;

    if (seriesEnabled) {
      if (seriesWeekdays.length === 0) {
        setErrors(prev => ({ ...prev, seriesWeekdays: "Bitte wählen Sie mindestens einen Wochentag" }));
        return;
      }
      if (!seriesEndDate) {
        setErrors(prev => ({ ...prev, seriesEndDate: "Bitte wählen Sie ein Enddatum" }));
        return;
      }
      if (seriesEndDate <= ktDate) {
        setErrors(prev => ({ ...prev, seriesEndDate: "Enddatum muss nach dem Startdatum liegen" }));
        return;
      }
      const startMs = new Date(ktDate).getTime();
      const endMs = new Date(seriesEndDate).getTime();
      const maxMs = 365 * 24 * 60 * 60 * 1000;
      if (endMs - startMs > maxMs) {
        setErrors(prev => ({ ...prev, seriesEndDate: "Maximaler Zeitraum: 12 Monate" }));
        return;
      }

      const totalMinutes = ktServices.reduce((sum, s) => sum + s.durationMinutes, 0);
      const employeeId = canChangeAssignment && ktAssignedEmployeeId ? parseInt(ktAssignedEmployeeId) : user?.id;
      if (!employeeId) {
        toast({ variant: "destructive", title: "Fehler", description: "Kein Mitarbeiter zugewiesen" });
        return;
      }

      const seriesInput: SeriesCreateInput = {
        customerId: parseInt(ktCustomerId),
        assignedEmployeeId: employeeId,
        frequency: seriesFrequency,
        weekdays: seriesWeekdays,
        scheduledStart: ktTime,
        durationMinutes: totalMinutes,
        services: ktServices,
        startDate: ktDate,
        endDate: seriesEndDate,
        notes: ktNotes || undefined,
      };

      previewSeriesMutation.mutate(seriesInput, {
        onSuccess: (preview) => {
          setPendingSeriesInput(seriesInput);

          if (preview.conflicts.length > 0) {
            setSeriesConflicts(preview.conflicts);
            setSeriesConflictInfo({
              totalDates: preview.totalDates,
              validDates: preview.validDates,
            });
            setShowSeriesConflictDialog(true);
          } else if (!preview.valid) {
            toast({ variant: "destructive", title: "Fehler", description: preview.error || "Keine gültigen Termine gefunden." });
          } else {
            confirmSeriesCreate(seriesInput);
          }
        },
        onError: (error: Error) => {
          toast({ variant: "destructive", title: "Fehler", description: error.message });
        },
      });
      return;
    }

    const mutationData: Record<string, unknown> = {
      customerId: parseInt(ktCustomerId),
      date: ktDate,
      scheduledStart: ktTime,
      services: ktServices,
      notes: ktNotes || undefined,
      assignedEmployeeId: canChangeAssignment && ktAssignedEmployeeId ? parseInt(ktAssignedEmployeeId) : undefined,
    };

    if (hasAlltagsbegleitung && fahrtdienst.enabled && fahrtdienst.doctorAppointmentTime && fahrtdienst.doctorStrasse) {
      mutationData.isFahrtdienst = true;
      mutationData.doctorName = fahrtdienst.doctorName || undefined;
      mutationData.doctorAppointmentTime = fahrtdienst.doctorAppointmentTime;
      mutationData.doctorStrasse = fahrtdienst.doctorStrasse;
      mutationData.doctorNr = fahrtdienst.doctorNr || undefined;
      mutationData.doctorPlz = fahrtdienst.doctorPlz;
      mutationData.doctorStadt = fahrtdienst.doctorStadt;
      if (fahrtdienstTravelData) {
        mutationData.estimatedTravelMinutes = fahrtdienstTravelData.travelMinutes;
        mutationData.travelBufferMinutes = fahrtdienstTravelData.bufferMinutes;
        mutationData.doctorLatitude = fahrtdienstTravelData.doctorLat;
        mutationData.doctorLongitude = fahrtdienstTravelData.doctorLng;
      }
    }

    createKundenterminMutation.mutate(mutationData, {
      onSuccess: (data: any) => {
        toast({ title: "Termin erstellt", description: "Der Kundentermin wurde erfolgreich angelegt." });
        if (data?._warning) {
          setTimeout(() => {
            toast({ title: "Budget-Hinweis", description: data._warning, variant: "destructive" });
          }, 500);
        }
        setLocation(ktDate ? `/?date=${ktDate}` : "/");
      },
      onError: (error: Error) => {
        toast({ variant: "destructive", title: "Fehler", description: error.message });
      },
    });
  };

  const handleInlineProspectCreate = () => {
    const newErrors: Record<string, string> = {};
    if (!inlineProspectVorname.trim()) newErrors.inlineVorname = "Vorname ist erforderlich";
    if (!inlineProspectNachname.trim()) newErrors.inlineNachname = "Nachname ist erforderlich";
    if (!inlineProspectTelefon.trim()) {
      newErrors.inlineTelefon = "Telefonnummer ist erforderlich";
    } else if (!isDachPhone(inlineProspectTelefon.trim())) {
      newErrors.inlineTelefon = "Ungültige Telefonnummer (DE/AT/CH)";
    }
    if (inlineProspectEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inlineProspectEmail.trim())) {
      newErrors.inlineEmail = "Ungültige E-Mail-Adresse";
    }
    if (inlineProspectPlz.trim() && !/^\d{5}$/.test(inlineProspectPlz.trim())) {
      newErrors.inlinePlz = "PLZ muss 5 Ziffern haben";
    }
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    createInlineProspectMutation.mutate({
      vorname: inlineProspectVorname.trim(),
      nachname: inlineProspectNachname.trim(),
      telefon: inlineProspectTelefon.trim() || undefined,
      email: inlineProspectEmail.trim() || undefined,
      strasse: inlineProspectStrasse.trim() || undefined,
      nr: inlineProspectNr.trim() || undefined,
      plz: inlineProspectPlz.trim() || undefined,
      stadt: inlineProspectStadt.trim() || undefined,
      pflegegrad: inlineProspectPflegegrad ? parseInt(inlineProspectPflegegrad) : undefined,
    });
  };

  const handleErstberatungSubmit = () => {
    if (!validateErstberatung()) return;

    createErstberatungMutation.mutate({
      prospectId: parseInt(effectiveProspectId!),
      date: ebDate,
      scheduledStart: ebStartTime,
      erstberatungDauer: ebErstberatungDauer,
      notes: ebNotes || undefined,
      assignedEmployeeId: canChangeAssignment && ebAssignedEmployeeId ? parseInt(ebAssignedEmployeeId) : undefined,
    }, {
      onSuccess: () => {
        invalidateRelated(queryClient, "appointments");
        toast({ title: "Erstberatung erstellt", description: "Die Erstberatung wurde erfolgreich angelegt." });
        setLocation(ebDate ? `/?date=${ebDate}` : "/");
      },
      onError: (error: Error) => {
        toast({ variant: "destructive", title: "Fehler", description: error.message });
      },
    });
  };

  const ebSummary = useMemo(() => {
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
    const eligible = canChangeAssignment
      ? customers
      : customers.filter((c) => c.isCurrentlyAssigned !== false);
    return eligible.map((c) => ({
      value: c.id.toString(),
      label: c.name,
      sublabel: c.address,
    })).sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [customers, canChangeAssignment]);

  const selectedCustomer = useMemo(() => {
    if (!ktCustomerId) return null;
    return customers.find(c => c.id.toString() === ktCustomerId) ?? null;
  }, [ktCustomerId, customers]);

  const prevCustomerIdRef = useRef(ktCustomerId);
  useEffect(() => {
    if (prevCustomerIdRef.current === ktCustomerId) return;
    prevCustomerIdRef.current = ktCustomerId;
    if (!selectedCustomer) {
      setKtAssignedEmployeeId("");
      return;
    }
    if (selectedCustomer.primaryEmployeeId) {
      setKtAssignedEmployeeId(selectedCustomer.primaryEmployeeId.toString());
    } else if (selectedCustomer.backupEmployeeId) {
      setKtAssignedEmployeeId(selectedCustomer.backupEmployeeId.toString());
    } else if (selectedCustomer.backupEmployeeId2) {
      setKtAssignedEmployeeId(selectedCustomer.backupEmployeeId2.toString());
    } else {
      setKtAssignedEmployeeId("");
    }
  }, [selectedCustomer, ktCustomerId]);

  useEffect(() => {
    if (!ktCustomerId || !fahrtdienst.enabled) {
      setGeocodingError(null);
      setIsGeocodingCustomer(false);
      return;
    }
    if (!selectedCustomer) return;

    if (geocodedCoords && geocodedCoords.customerId === ktCustomerId) return;

    if (selectedCustomer.latitude && selectedCustomer.longitude) return;

    let cancelled = false;
    setIsGeocodingCustomer(true);
    setGeocodingError(null);

    api.post<{ latitude: number; longitude: number }>(`/customers/${ktCustomerId}/geocode`, {})
      .then((result) => {
        if (cancelled) return;
        const data = unwrapResult(result);
        setGeocodedCoords({ customerId: ktCustomerId, lat: data.latitude, lng: data.longitude });
        invalidateRelated(queryClient, "customers");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setGeocodingError(err.message || "Kundenadresse konnte nicht aufgelöst werden");
      })
      .finally(() => {
        if (!cancelled) setIsGeocodingCustomer(false);
      });

    return () => { cancelled = true; };
  }, [ktCustomerId, fahrtdienst.enabled, selectedCustomer, geocodedCoords, queryClient]);

  const effectiveCustomerLat = selectedCustomer?.latitude ?? (geocodedCoords?.customerId === ktCustomerId ? geocodedCoords.lat : null);
  const effectiveCustomerLng = selectedCustomer?.longitude ?? (geocodedCoords?.customerId === ktCustomerId ? geocodedCoords.lng : null);

  // Quelle: aktive Mitarbeiter (für Admin und Teamleitung gleichermaßen).
  // Admins nutzen die volle Liste aus /admin/employees, fallen aber auf
  // /appointments/active-employees zurück, falls die Admin-Liste (noch) nicht
  // geladen ist. Teamleitungen verwenden ausschließlich active-employees.
  const employeeSource = useMemo(() => {
    if (isAdmin && employees.length > 0) {
      return employees.filter(e => e.isActive).map(e => ({ id: e.id, displayName: e.displayName, roles: e.roles ?? [] }));
    }
    return activeEmployees.map(e => ({ id: e.id, displayName: e.displayName, roles: e.roles ?? [] }));
  }, [isAdmin, employees, activeEmployees]);

  const employeeOptions = useMemo(() => {
    if (selectedCustomer) {
      const assignedIds = [selectedCustomer.primaryEmployeeId, selectedCustomer.backupEmployeeId, selectedCustomer.backupEmployeeId2].filter(Boolean);
      if (assignedIds.length > 0) {
        return employeeSource
          .filter(e => assignedIds.includes(e.id))
          .map((e) => ({
            value: e.id.toString(),
            label: e.displayName + (e.id === selectedCustomer.primaryEmployeeId ? " (Haupt)" : e.id === selectedCustomer.backupEmployeeId ? " (Vertretung)" : " (2. Vertretung)"),
          }))
          .sort((a, b) => a.label.localeCompare(b.label, "de"));
      }
    }
    return employeeSource.map((e) => ({
      value: e.id.toString(),
      label: e.displayName,
    })).sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [employeeSource, selectedCustomer]);

  const ebEmployeeOptions = useMemo(() => {
    return employeeSource
      .filter(e => e.roles?.includes("erstberatung"))
      .map((e) => ({
        value: e.id.toString(),
        label: e.displayName,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [employeeSource]);

  const isPending = createKundenterminMutation.isPending || createErstberatungMutation.isPending || createSeriesMutation.isPending || previewSeriesMutation.isPending;

  return {
    activeTab,
    setActiveTab,
    isAdmin,
    isTeamLead,
    canChangeAssignment,
    canErstberatung,
    customersLoading,

    ktCustomerId,
    setKtCustomerId,
    ktDate,
    setKtDate,
    ktTime,
    setKtTime,
    ktServices,
    setKtServices,
    ktNotes,
    setKtNotes,
    ktAssignedEmployeeId,
    setKtAssignedEmployeeId,
    selectedCustomerBillingType: selectedCustomer?.billingType ?? null,

    prospectData: effectiveProspectData,
    ebDate,
    setEbDate,
    ebStartTime,
    setEbStartTime,
    ebErstberatungDauer,
    setEbErstberatungDauer,
    ebNotes,
    setEbNotes,
    ebAssignedEmployeeId,
    setEbAssignedEmployeeId,

    copyFromId,
    copyFromCustomerName: copyFromAppointment?.customer?.name ?? null,
    fromProspectId: effectiveProspectId,
    errors,
    costEstimate,
    ktSummary,
    ebSummary,
    customerOptions,
    employeeOptions,
    ebEmployeeOptions,
    isPending,

    prospectMode,
    setProspectMode,
    selectedExistingProspectId,
    setSelectedExistingProspectId,
    clearSelectedProspect: () => {
      setSelectedExistingProspectId(null);
    },

    inlineProspectVorname,
    setInlineProspectVorname,
    inlineProspectNachname,
    setInlineProspectNachname,
    inlineProspectTelefon,
    setInlineProspectTelefon,
    inlineProspectEmail,
    setInlineProspectEmail,
    inlineProspectStrasse,
    setInlineProspectStrasse,
    inlineProspectNr,
    setInlineProspectNr,
    inlineProspectPlz,
    setInlineProspectPlz,
    inlineProspectStadt,
    setInlineProspectStadt,
    inlineProspectPflegegrad,
    setInlineProspectPflegegrad,
    inlineProspectCreatedId,
    isCreatingProspect: createInlineProspectMutation.isPending,
    handleInlineProspectCreate,

    handleKundenterminSubmit,
    handleErstberatungSubmit,

    fahrtdienst,
    setFahrtdienst,
    hasAlltagsbegleitung,
    selectedCustomer,
    handlePickupTimeCalculated,
    isGeocodingCustomer,
    geocodingError,
    effectiveCustomerLat,
    effectiveCustomerLng,

    seriesEnabled,
    setSeriesEnabled,
    seriesWeekdays,
    setSeriesWeekdays,
    seriesFrequency,
    setSeriesFrequency,
    seriesEndDate,
    setSeriesEndDate,
    seriesPreview,
    seriesConflicts,
    showSeriesConflictDialog,
    seriesConflictInfo,
    isSeriesCreating: createSeriesMutation.isPending,
    confirmSeriesWithSkippedConflicts: () => {
      if (pendingSeriesInput) {
        confirmSeriesCreate(pendingSeriesInput);
      }
    },
    dismissSeriesConflictDialog: () => {
      setShowSeriesConflictDialog(false);
      setSeriesConflicts([]);
      setSeriesConflictInfo(null);
      setPendingSeriesInput(null);
    },
  };
}
