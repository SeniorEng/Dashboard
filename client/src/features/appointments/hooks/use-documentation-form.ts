import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useAppointment } from "./use-appointments";
import { useDocumentAppointment, useTravelSuggestion } from "./use-appointment-mutations";
import type { TravelOriginType, ServiceType } from "@shared/types";
import type { Service } from "@shared/schema";
import { formatTimeHHMM, addMinutesToTime } from "@shared/utils/datetime";

export interface ServiceFormData {
  serviceId?: number;
  serviceType: ServiceType;
  plannedDuration: number;
  actualDuration: number;
  details: string;
}

export interface DocumentationFormData {
  performedByEmployeeId: number | null;
  actualStart: string;
  services: ServiceFormData[];
  travelOriginType: TravelOriginType;
  travelFromAppointmentId: number | null;
  travelKilometers: number;
  travelMinutes: number;
  customerKilometers: number;
  notes: string;
}

export function useDocumentationForm(id: number) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin ?? false;

  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState<DocumentationFormData>({
    performedByEmployeeId: null,
    actualStart: "",
    services: [],
    travelOriginType: "home",
    travelFromAppointmentId: null,
    travelKilometers: 0,
    travelMinutes: 0,
    customerKilometers: 0,
    notes: "",
  });

  const { data: appointment, isLoading: appointmentLoading } = useAppointment(id);
  const { data: travelSuggestion } = useTravelSuggestion(id);
  const documentMutation = useDocumentAppointment(id);

  const { data: appointmentServicesData } = useQuery<Array<{ serviceId: number; serviceCode: string; plannedDurationMinutes: number; actualDurationMinutes: number | null; details: string | null }>>({
    queryKey: [`/api/appointments/${id}/services`],
    queryFn: async () => {
      const res = await fetch(`/api/appointments/${id}/services`);
      if (!res.ok) throw new Error("Failed to fetch appointment services");
      return res.json();
    },
    enabled: id > 0,
  });

  const { data: catalogServices } = useQuery<Service[]>({
    queryKey: ["/api/services"],
    staleTime: 60_000,
  });

  const servicesInitialized = useRef(false);

  useEffect(() => {
    if (appointment && appointmentServicesData && !servicesInitialized.current) {
      const prefillStart = appointment.actualStart
        ? formatTimeHHMM(appointment.actualStart)
        : appointment.scheduledStart
          ? formatTimeHHMM(appointment.scheduledStart)
          : "";

      setFormData(prev => ({
        ...prev,
        performedByEmployeeId: appointment.assignedEmployeeId ?? null,
        actualStart: prefillStart,
        services: appointmentServicesData.map(as => ({
          serviceId: as.serviceId,
          serviceType: as.serviceCode === 'hauswirtschaft' ? "Hauswirtschaft" as ServiceType
            : as.serviceCode === 'alltagsbegleitung' ? "Alltagsbegleitung" as ServiceType
            : as.serviceCode === 'erstberatung' ? "Erstberatung" as ServiceType
            : as.serviceCode as ServiceType,
          plannedDuration: as.plannedDurationMinutes,
          actualDuration: as.actualDurationMinutes ?? as.plannedDurationMinutes,
          details: as.details ?? "",
        })),
        notes: appointment.notes ?? "",
      }));

      servicesInitialized.current = true;
    }
  }, [appointment, appointmentServicesData]);

  useEffect(() => {
    if (travelSuggestion) {
      setFormData(prev => ({
        ...prev,
        travelOriginType: travelSuggestion.suggestedOrigin,
        travelFromAppointmentId: travelSuggestion.previousAppointmentId,
      }));
    }
  }, [travelSuggestion]);

  const updateService = useCallback((index: number, field: keyof ServiceFormData, value: number | string) => {
    setFormData(prev => ({
      ...prev,
      services: prev.services.map((s, i) => 
        i === index ? { ...s, [field]: value } : s
      ),
    }));
  }, []);

  const removeService = useCallback((index: number) => {
    setFormData(prev => ({
      ...prev,
      services: prev.services.filter((_, i) => i !== index),
    }));
  }, []);

  const addService = useCallback((serviceType: ServiceType) => {
    const codeMap: Record<string, string> = {
      "Hauswirtschaft": "hauswirtschaft",
      "Alltagsbegleitung": "alltagsbegleitung",
      "Erstberatung": "erstberatung",
    };
    const code = codeMap[serviceType] ?? serviceType.toLowerCase();
    const catalogEntry = catalogServices?.find(s => s.code === code);
    const defaultDuration = catalogEntry?.minDurationMinutes || 60;
    setFormData(prev => ({
      ...prev,
      services: [
        ...prev.services,
        {
          serviceId: catalogEntry?.id,
          serviceType,
          plannedDuration: 0,
          actualDuration: defaultDuration,
          details: "",
        },
      ],
    }));
  }, [catalogServices]);

  const calculatedEnd = useMemo(() => {
    if (!formData.actualStart) return null;
    const totalMinutes = formData.services.reduce((sum, s) => sum + (s.actualDuration || 0), 0);
    if (totalMinutes === 0) return null;
    return addMinutesToTime(formData.actualStart, totalMinutes);
  }, [formData.actualStart, formData.services]);

  const availableServicesToAdd = useMemo(() => {
    if (appointment?.appointmentType !== "Kundentermin") return [];
    const existingTypes = formData.services.map(s => s.serviceType);
    const possibleServices: ServiceType[] = ["Hauswirtschaft", "Alltagsbegleitung"];
    return possibleServices.filter(s => !existingTypes.includes(s));
  }, [appointment?.appointmentType, formData.services]);

  const handleNext = useCallback(() => {
    if (!formData.actualStart || !/^\d{2}:\d{2}$/.test(formData.actualStart)) {
      toast({
        title: "Startzeit fehlt",
        description: "Bitte geben Sie die tatsächliche Startzeit an.",
        variant: "destructive",
      });
      return;
    }

    if (formData.services.length === 0) {
      toast({
        title: "Kein Service vorhanden",
        description: "Mindestens ein Service muss dokumentiert werden.",
        variant: "destructive",
      });
      return;
    }
    
    const isStep1Valid = formData.services.every(s => s.actualDuration > 0);
    if (!isStep1Valid) {
      toast({
        title: "Bitte alle Felder ausfüllen",
        description: "Die tatsächliche Dauer muss für jeden Service angegeben werden.",
        variant: "destructive",
      });
      return;
    }
    
    const missingDetails = formData.services.find(s => !s.details.trim());
    if (missingDetails) {
      toast({
        title: "Servicedetails fehlen",
        description: `Bitte geben Sie Details für "${missingDetails.serviceType}" an.`,
        variant: "destructive",
      });
      return;
    }
    
    setStep(2);
  }, [formData.services, toast]);

  const handleSubmit = useCallback(() => {
    if (formData.travelKilometers <= 0) {
      toast({
        title: "Kilometer fehlt",
        description: "Bitte geben Sie die gefahrenen Kilometer an.",
        variant: "destructive",
      });
      return;
    }
    if (formData.travelOriginType === "appointment" && formData.travelMinutes <= 0) {
      toast({
        title: "Fahrzeit fehlt",
        description: "Bitte geben Sie die Fahrzeit vom vorherigen Kunden an.",
        variant: "destructive",
      });
      return;
    }

    const payload: Record<string, unknown> = {
      performedByEmployeeId: formData.performedByEmployeeId,
      actualStart: formData.actualStart,
      travelOriginType: formData.travelOriginType,
      travelKilometers: formData.travelKilometers,
      notes: formData.notes || null,
    };

    if (formData.travelOriginType === "appointment") {
      payload.travelFromAppointmentId = formData.travelFromAppointmentId;
      payload.travelMinutes = formData.travelMinutes;
    }

    const servicesWithoutId = formData.services.filter(s => !s.serviceId && s.actualDuration > 0);
    if (servicesWithoutId.length > 0) {
      toast({
        title: "Service-Fehler",
        description: `${servicesWithoutId.map(s => s.serviceType).join(", ")} konnte nicht zugeordnet werden. Bitte entfernen und neu hinzufügen.`,
        variant: "destructive",
      });
      return;
    }

    payload.services = formData.services
      .filter(s => s.serviceId && s.actualDuration && s.actualDuration > 0)
      .map(s => ({
        serviceId: s.serviceId,
        actualDurationMinutes: s.actualDuration,
        details: s.details.trim(),
      }));

    if (formData.customerKilometers > 0) {
      payload.customerKilometers = formData.customerKilometers;
    }

    documentMutation.mutate(payload, {
      onSuccess: () => {
        toast({
          title: "Dokumentation abgeschlossen",
          description: "Der Termin wurde erfolgreich dokumentiert.",
        });
        setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
      },
      onError: (error: Error) => {
        toast({
          title: "Fehler",
          description: error.message,
          variant: "destructive",
        });
      },
    });
  }, [formData, documentMutation, toast, setLocation]);

  return {
    step, setStep,
    formData, setFormData,
    appointment, appointmentLoading,
    documentMutation,
    isAdmin,
    calculatedEnd,
    availableServicesToAdd,
    updateService, removeService, addService,
    handleNext, handleSubmit,
    travelSuggestion,
  };
}
