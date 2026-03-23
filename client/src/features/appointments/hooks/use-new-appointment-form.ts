import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { api, unwrapResult } from "@/lib/api/client";
import { useCustomerList } from "./use-customer-list";
import { useAdminEmployees } from "./use-active-employees";
import { useCreateKundentermin, useCreateErstberatung } from "./use-appointment-mutations";
import { timeToMinutes, minutesToTimeDisplay, formatDurationDisplay, todayISO } from "@shared/utils/datetime";
import type { Service } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";

export function useNewAppointmentForm() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const copyFromId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("copyFrom") : null;
  const initialTab = copyFromId ? "kundentermin" : (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("type") === "erstberatung" ? "erstberatung" : "kundentermin");
  const [activeTab, setActiveTab] = useState<string>(initialTab);

  const isAdmin = user?.isAdmin ?? false;

  const { data: customers = [], isLoading: customersLoading } = useCustomerList();
  const { data: employees = [] } = useAdminEmployees({ enabled: isAdmin });

  const createKundenterminMutation = useCreateKundentermin();
  const createErstberatungMutation = useCreateErstberatung();

  const { data: catalogServices = [] } = useQuery<Service[]>({
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

  const [ktCustomerId, setKtCustomerId] = useState<string>("");
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
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
      const result = await api.get<{ prospect: ProspectAppointmentData; appointments: unknown[] }>(`/admin/prospects/${fromProspectId}/appointment-data`);
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
      const result = await api.post<{ id: number; vorname: string; nachname: string; telefon: string | null }>("/admin/prospects", {
        ...data,
        status: "erstberatung_vereinbart",
        quelle: "direktkontakt",
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

  const effectiveProspectId = fromProspectId || (inlineProspectCreatedId ? String(inlineProspectCreatedId) : null);

  const { data: inlineProspectData } = useQuery<ProspectAppointmentData>({
    queryKey: ["prospect-appointment-data", inlineProspectCreatedId],
    queryFn: async () => {
      const result = await api.get<{ prospect: ProspectAppointmentData; appointments: unknown[] }>(`/admin/prospects/${inlineProspectCreatedId}/appointment-data`);
      return unwrapResult(result).prospect;
    },
    enabled: !!inlineProspectCreatedId && !fromProspectId,
    staleTime: 60_000,
  });

  const effectiveProspectData = fromProspectId ? (prospectData ?? null) : (inlineProspectData ?? null);

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
      }>(`/budget/${ktCustomerId}/cost-estimate?${budgetEstimateParams}`);
      if (!result.success) return { totalCents: 0, warning: null };
      return result.data;
    },
    enabled: !!ktCustomerId && !!budgetEstimateParams,
    staleTime: 30_000,
  });

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
    if (!effectiveProspectId) newErrors.ebProspect = "Bitte legen Sie zuerst einen Interessenten an";
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
    if (!inlineProspectTelefon.trim()) newErrors.inlineTelefon = "Telefonnummer ist erforderlich";
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
      assignedEmployeeId: isAdmin && ebAssignedEmployeeId ? parseInt(ebAssignedEmployeeId) : undefined,
    }, {
      onSuccess: () => {
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
    const eligible = isAdmin
      ? customers
      : customers.filter((c) => c.isCurrentlyAssigned !== false);
    return eligible.map((c) => ({
      value: c.id.toString(),
      label: c.name,
      sublabel: c.address,
    })).sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [customers, isAdmin]);

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

  const employeeOptions = useMemo(() => {
    const active = employees.filter(e => e.isActive);
    if (selectedCustomer) {
      const assignedIds = [selectedCustomer.primaryEmployeeId, selectedCustomer.backupEmployeeId, selectedCustomer.backupEmployeeId2].filter(Boolean);
      if (assignedIds.length > 0) {
        return active
          .filter(e => assignedIds.includes(e.id))
          .map((e) => ({
            value: e.id.toString(),
            label: e.displayName + (e.id === selectedCustomer.primaryEmployeeId ? " (Haupt)" : e.id === selectedCustomer.backupEmployeeId ? " (Vertretung)" : " (2. Vertretung)"),
          }))
          .sort((a, b) => a.label.localeCompare(b.label, "de"));
      }
    }
    return active.map((e) => ({
      value: e.id.toString(),
      label: e.displayName,
    })).sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [employees, selectedCustomer]);

  const ebEmployeeOptions = useMemo(() => {
    return employees
      .filter(e => e.isActive && e.roles?.includes("erstberatung"))
      .map((e) => ({
        value: e.id.toString(),
        label: e.displayName,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"));
  }, [employees]);

  const isPending = createKundenterminMutation.isPending || createErstberatungMutation.isPending;

  return {
    activeTab,
    setActiveTab,
    isAdmin,
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
  };
}
