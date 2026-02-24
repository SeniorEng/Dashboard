import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { api, unwrapResult } from "@/lib/api/client";
import { useCustomerList } from "./use-customer-list";
import { useAdminEmployees } from "./use-active-employees";
import { useCreateKundentermin, useCreateErstberatung } from "./use-appointment-mutations";
import { validateGermanPhone, normalizePhone, formatPhoneAsYouType } from "@shared/utils/phone";
import { timeToMinutes, minutesToTimeDisplay, formatDurationDisplay, todayISO } from "@shared/utils/datetime";
import type { Service } from "@shared/schema";

export function useNewAppointmentForm() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const initialTab = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("type") === "erstberatung" ? "erstberatung" : "kundentermin";
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

  const [ktCustomerId, setKtCustomerId] = useState<string>("");
  const [ktDate, setKtDate] = useState<string>(todayISO());
  const [ktTime, setKtTime] = useState<string>("09:00");
  const [ktServices, setKtServices] = useState<Array<{ serviceId: number; durationMinutes: number }>>([]);
  const [ktNotes, setKtNotes] = useState<string>("");
  const [ktAssignedEmployeeId, setKtAssignedEmployeeId] = useState<string>("");

  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const fromProspectId = urlParams.get("fromProspect");

  const [ebVorname, setEbVorname] = useState<string>(urlParams.get("vorname") || "");
  const [ebNachname, setEbNachname] = useState<string>(urlParams.get("nachname") || "");
  const [ebTelefon, setEbTelefon] = useState<string>(urlParams.get("telefon") || "");
  const [ebEmail, setEbEmail] = useState<string>(urlParams.get("email") || "");
  const [ebStrasse, setEbStrasse] = useState<string>(urlParams.get("strasse") || "");
  const [ebNr, setEbNr] = useState<string>(urlParams.get("nr") || "");
  const [ebPlz, setEbPlz] = useState<string>(urlParams.get("plz") || "");
  const [ebStadt, setEbStadt] = useState<string>(urlParams.get("stadt") || "");
  const [ebPflegegrad, setEbPflegegrad] = useState<string>(urlParams.get("pflegegrad") || "1");
  const [ebDate, setEbDate] = useState<string>(todayISO());
  const [ebStartTime, setEbStartTime] = useState<string>("09:00");
  const [ebErstberatungDauer, setEbErstberatungDauer] = useState<number>(60);
  const [ebNotes, setEbNotes] = useState<string>("");
  const [ebAssignedEmployeeId, setEbAssignedEmployeeId] = useState<string>("");

  const defaultsInitialized = useRef(false);
  useEffect(() => {
    if (catalogServices.length > 0 && !defaultsInitialized.current) {
      defaultsInitialized.current = true;
      const defaults = catalogServices
        .filter(s => s.isDefault && s.isActive && s.unitType === "hours" && (!s.code || !["erstberatung", "kilometer"].includes(s.code)))
        .map(s => ({ serviceId: s.id, durationMinutes: s.minDurationMinutes || 60 }));
      if (defaults.length > 0) {
        setKtServices(defaults);
      }
    }
  }, [catalogServices]);

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
      const result = await api.get(`/budget/${ktCustomerId}/cost-estimate?${budgetEstimateParams}`);
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
        email: ebEmail || undefined,
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
      onSuccess: async (data: any) => {
        if (fromProspectId) {
          try {
            await api.patch(`/admin/prospects/${fromProspectId}`, {
              status: "erstberatung",
              convertedCustomerId: data?.customerId || null,
              statusNotiz: "Automatisch in Erstberatung umgewandelt",
            });
          } catch (e) {
            console.warn("Prospect update failed:", e);
            toast({ variant: "destructive", title: "Hinweis", description: "Erstberatung wurde erstellt, aber der Interessent konnte nicht automatisch aktualisiert werden." });
          }
        }
        toast({ title: "Erstberatung erstellt", description: "Die Erstberatung und der neue Kunde wurden erfolgreich angelegt." });
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
    }));
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
    } else {
      setKtAssignedEmployeeId("");
    }
  }, [selectedCustomer, ktCustomerId]);

  const employeeOptions = useMemo(() => {
    const active = employees.filter(e => e.isActive);
    if (selectedCustomer) {
      const assignedIds = [selectedCustomer.primaryEmployeeId, selectedCustomer.backupEmployeeId].filter(Boolean);
      if (assignedIds.length > 0) {
        return active
          .filter(e => assignedIds.includes(e.id))
          .map((e) => ({
            value: e.id.toString(),
            label: e.displayName + (e.id === selectedCustomer.primaryEmployeeId ? " (Haupt)" : " (Vertretung)"),
          }));
      }
    }
    return active.map((e) => ({
      value: e.id.toString(),
      label: e.displayName,
    }));
  }, [employees, selectedCustomer]);

  const ebEmployeeOptions = useMemo(() => {
    return employees
      .filter(e => e.isActive && e.roles?.includes("erstberatung"))
      .map((e) => ({
        value: e.id.toString(),
        label: e.displayName,
      }));
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

    fromProspectId,
    errors,
    costEstimate,
    ktSummary,
    ebSummary,
    customerOptions,
    employeeOptions,
    ebEmployeeOptions,
    isPending,

    handleKundenterminSubmit,
    handleErstberatungSubmit,
    formatPhoneAsYouType,
  };
}
