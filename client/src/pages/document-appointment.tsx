import { useState, useEffect, useCallback, useMemo } from "react";
import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { 
  ChevronLeft, ChevronRight, Loader2, Clock, 
  Home, MapPin, Car, Check, AlertCircle, X, Plus
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { 
  formatDuration, 
  getServicesToDocument,
  type TravelOriginType,
  type ServiceType
} from "@shared/types";
import type { AppointmentWithCustomer } from "@shared/types";

interface TravelSuggestion {
  suggestedOrigin: TravelOriginType;
  previousAppointmentId: number | null;
  previousCustomerName: string | null;
}

interface ServiceFormData {
  serviceType: ServiceType;
  plannedDuration: number;
  actualDuration: number;
  details: string;
}

interface DocumentationFormData {
  services: ServiceFormData[];
  travelOriginType: TravelOriginType;
  travelFromAppointmentId: number | null;
  travelKilometers: number;
  travelMinutes: number;
  customerKilometers: number;
  notes: string;
}

export default function DocumentAppointment() {
  const [, params] = useRoute("/document-appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const id = params?.id ? parseInt(params.id) : 0;

  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState<DocumentationFormData>({
    services: [],
    travelOriginType: "home",
    travelFromAppointmentId: null,
    travelKilometers: 0,
    travelMinutes: 0,
    customerKilometers: 0,
    notes: "",
  });

  const { data: appointment, isLoading: appointmentLoading } = useQuery<AppointmentWithCustomer>({
    queryKey: ["appointment", id],
    queryFn: async () => {
      const res = await fetch(`/api/appointments/${id}`);
      if (!res.ok) throw new Error("Termin nicht gefunden");
      return res.json();
    },
    enabled: id > 0,
  });

  const { data: travelSuggestion } = useQuery<TravelSuggestion>({
    queryKey: ["travel-suggestion", id],
    queryFn: async () => {
      const res = await fetch(`/api/appointments/${id}/travel-suggestion`);
      if (!res.ok) throw new Error("Fahrvorschlag nicht verfügbar");
      return res.json();
    },
    enabled: id > 0,
  });

  useEffect(() => {
    if (appointment) {
      const services = getServicesToDocument(appointment);
      setFormData(prev => ({
        ...prev,
        services: services.map(s => ({
          serviceType: s.serviceType,
          plannedDuration: s.plannedDuration,
          actualDuration: s.actualDuration ?? s.plannedDuration,
          details: s.details ?? "",
        })),
        notes: appointment.notes ?? "",
      }));
    }
  }, [appointment]);

  useEffect(() => {
    if (travelSuggestion) {
      setFormData(prev => ({
        ...prev,
        travelOriginType: travelSuggestion.suggestedOrigin,
        travelFromAppointmentId: travelSuggestion.previousAppointmentId,
      }));
    }
  }, [travelSuggestion]);

  const submitMutation = useMutation({
    mutationFn: async (data: DocumentationFormData) => {
      const payload: Record<string, unknown> = {
        travelOriginType: data.travelOriginType,
        travelKilometers: data.travelKilometers,
        notes: data.notes || null,
      };

      if (data.travelOriginType === "appointment") {
        payload.travelFromAppointmentId = data.travelFromAppointmentId;
        payload.travelMinutes = data.travelMinutes;
      }

      const hwService = data.services.find(s => s.serviceType === "Hauswirtschaft");
      const abService = data.services.find(s => s.serviceType === "Alltagsbegleitung");
      const ebService = data.services.find(s => s.serviceType === "Erstberatung");

      if (hwService) {
        payload.hauswirtschaftActualDauer = hwService.actualDuration;
        payload.hauswirtschaftDetails = hwService.details || null;
      }
      if (abService) {
        payload.alltagsbegleitungActualDauer = abService.actualDuration;
        payload.alltagsbegleitungDetails = abService.details || null;
      }
      if (ebService) {
        payload.erstberatungActualDauer = ebService.actualDuration;
        payload.erstberatungDetails = ebService.details || null;
      }
      if (data.customerKilometers > 0) {
        payload.customerKilometers = data.customerKilometers;
      }

      const result = await api.post(`/appointments/${id}/document`, payload);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      queryClient.invalidateQueries({ queryKey: ["appointment", id] });
      queryClient.invalidateQueries({ queryKey: ["time-entries"] });
      toast({
        title: "Dokumentation abgeschlossen",
        description: "Der Termin wurde erfolgreich dokumentiert.",
      });
      setLocation("/");
    },
    onError: (error: Error) => {
      toast({
        title: "Fehler",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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
    const defaultDuration = 60;
    setFormData(prev => ({
      ...prev,
      services: [
        ...prev.services,
        {
          serviceType,
          plannedDuration: 0,
          actualDuration: defaultDuration,
          details: "",
        },
      ],
    }));
  }, []);

  const availableServicesToAdd = useMemo(() => {
    if (appointment?.appointmentType !== "Kundentermin") return [];
    const existingTypes = formData.services.map(s => s.serviceType);
    const possibleServices: ServiceType[] = ["Hauswirtschaft", "Alltagsbegleitung"];
    return possibleServices.filter(s => !existingTypes.includes(s));
  }, [appointment?.appointmentType, formData.services]);

  const handleNext = useCallback(() => {
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
    submitMutation.mutate(formData);
  }, [formData, submitMutation, toast]);

  if (appointmentLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (!appointment) {
    return (
      <Layout>
        <Card className="border-destructive">
          <CardContent className="pt-6 text-center">
            <AlertCircle className={`${iconSize.xl} mx-auto text-destructive mb-4`} />
            <p className="text-destructive font-medium">Termin nicht gefunden</p>
          </CardContent>
        </Card>
      </Layout>
    );
  }

  if (appointment.status === "completed") {
    return (
      <Layout>
        <Card className="border-green-200 bg-green-50">
          <CardContent className="pt-6 text-center">
            <Check className={`${iconSize.xl} mx-auto text-green-600 mb-4`} />
            <p className="text-green-800 font-medium">
              Dieser Termin wurde bereits dokumentiert
            </p>
            <Button 
              variant="outline" 
              className="mt-4"
              onClick={() => setLocation(`/appointment/${id}`)}
            >
              Zurück zum Termin
            </Button>
          </CardContent>
        </Card>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => step === 1 ? setLocation(`/appointment/${id}`) : setStep(1)}
          className="mb-2 -ml-2"
          data-testid="button-back"
        >
          <ChevronLeft className={`${iconSize.sm} mr-1`} />
          {step === 1 ? "Zurück" : "Schritt 1"}
        </Button>
        
        <h1 className="text-2xl font-bold text-foreground" data-testid="text-title">
          Dokumentation
        </h1>
        <p className="text-muted-foreground text-sm">
          {appointment.customer?.name} • Schritt {step} von 2
        </p>
        
        <div className="flex gap-2 mt-3">
          <div className={`h-1 flex-1 rounded-full ${step >= 1 ? "bg-primary" : "bg-muted"}`} />
          <div className={`h-1 flex-1 rounded-full ${step >= 2 ? "bg-primary" : "bg-muted"}`} />
        </div>
      </div>

      {step === 1 ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className={`${iconSize.md} text-primary`} />
                Services dokumentieren
              </CardTitle>
              <CardDescription>
                Überprüfen Sie die Dauer und fügen Sie Details hinzu
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {formData.services.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p className="mb-2">Keine Services vorhanden</p>
                  <p className="text-sm">Fügen Sie mindestens einen Service hinzu</p>
                </div>
              ) : (
                formData.services.map((service, index) => (
                  <div key={service.serviceType} className="space-y-4 pb-4 border-b last:border-b-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium text-foreground">{service.serviceType}</h3>
                      <div className="flex items-center gap-3">
                        {service.plannedDuration > 0 && (
                          <span className="text-sm text-muted-foreground">
                            Geplant: {formatDuration(service.plannedDuration)}
                          </span>
                        )}
                        {service.plannedDuration === 0 && (
                          <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded">
                            Hinzugefügt
                          </span>
                        )}
                        {appointment?.appointmentType === "Kundentermin" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={() => {
                              const hasData = service.details.trim().length > 0;
                              if (hasData) {
                                if (window.confirm(`"${service.serviceType}" hat bereits eingetragene Details. Wirklich entfernen?`)) {
                                  removeService(index);
                                }
                              } else {
                                removeService(index);
                              }
                            }}
                            data-testid={`button-remove-${service.serviceType.toLowerCase()}`}
                          >
                            <X className={iconSize.sm} />
                          </Button>
                        )}
                      </div>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Tatsächliche Dauer</Label>
                        <span className="text-sm font-medium text-primary">
                          {formatDuration(service.actualDuration)}
                        </span>
                      </div>
                      <Slider
                        value={[service.actualDuration]}
                        onValueChange={([value]) => updateService(index, "actualDuration", value)}
                        min={15}
                        max={240}
                        step={15}
                        className="w-full"
                        data-testid={`slider-duration-${service.serviceType.toLowerCase()}`}
                      />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>15 Min.</span>
                        <span>4 Std.</span>
                      </div>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={`details-${index}`}>Servicedetails *</Label>
                        <span className={`text-xs ${service.details.length > 55 ? "text-destructive" : "text-muted-foreground"}`}>
                          {service.details.length}/55
                        </span>
                      </div>
                      <Input
                        id={`details-${index}`}
                        value={service.details}
                        onChange={(e) => updateService(index, "details", e.target.value.slice(0, 55))}
                        placeholder={
                          service.serviceType === "Hauswirtschaft" 
                            ? "z.B. Wäsche gewaschen, Boden gewischt" 
                            : service.serviceType === "Alltagsbegleitung"
                            ? "z.B. Begleitung zum Arzt, Spaziergang"
                            : "z.B. Beratung durchgeführt"
                        }
                        maxLength={55}
                        className={!service.details.trim() ? "border-amber-300" : ""}
                        data-testid={`input-details-${service.serviceType.toLowerCase()}`}
                      />
                    </div>
                  </div>
                ))
              )}
              
              {availableServicesToAdd.length > 0 && (
                <div className="pt-4 border-t">
                  <p className="text-sm text-muted-foreground mb-3">Service hinzufügen:</p>
                  <div className="flex flex-wrap gap-2">
                    {availableServicesToAdd.map(serviceType => (
                      <Button
                        key={serviceType}
                        variant="outline"
                        size="sm"
                        onClick={() => addService(serviceType)}
                        className="gap-1"
                        data-testid={`button-add-${serviceType.toLowerCase()}`}
                      >
                        <Plus className={iconSize.xs} />
                        {serviceType}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {formData.services.some(s => s.serviceType === "Hauswirtschaft" || s.serviceType === "Alltagsbegleitung") && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Car className={`${iconSize.md} text-primary`} />
                  Fahrten für/mit Kunde
                </CardTitle>
                <CardDescription>
                  z.B. Arztbesuch, Einkauf, Behördengang
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <Label htmlFor="customerKilometers">Gefahrene Kilometer</Label>
                  <div className="relative">
                    <Input
                      id="customerKilometers"
                      type="number"
                      min="0"
                      step="0.1"
                      value={formData.customerKilometers || ""}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        customerKilometers: parseFloat(e.target.value) || 0,
                      }))}
                      placeholder="0"
                      className="pr-12"
                      data-testid="input-customer-kilometers"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                      km
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          
          <Button 
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={handleNext}
            data-testid="button-next"
          >
            Weiter
            <ChevronRight className={`${iconSize.sm} ml-2`} />
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Car className={`${iconSize.md} text-primary`} />
                Anfahrt dokumentieren
              </CardTitle>
              <CardDescription>
                Woher kamen Sie zu diesem Termin?
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <RadioGroup
                value={formData.travelOriginType}
                onValueChange={(value: TravelOriginType) => setFormData(prev => ({
                  ...prev,
                  travelOriginType: value,
                  travelMinutes: value === "home" ? 0 : prev.travelMinutes,
                }))}
                className="space-y-3"
              >
                <div className={`flex items-center space-x-3 p-3 rounded-lg border ${formData.travelOriginType === "home" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <RadioGroupItem value="home" id="origin-home" data-testid="radio-origin-home" />
                  <Label htmlFor="origin-home" className="flex items-center gap-2 cursor-pointer flex-1">
                    <Home className={`${iconSize.sm} text-muted-foreground`} />
                    <span className="font-medium">Von zu Hause</span>
                  </Label>
                </div>
                
                <div className={`flex items-center space-x-3 p-3 rounded-lg border ${formData.travelOriginType === "appointment" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <RadioGroupItem value="appointment" id="origin-appointment" data-testid="radio-origin-appointment" />
                  <Label htmlFor="origin-appointment" className="flex items-center gap-2 cursor-pointer flex-1">
                    <MapPin className={`${iconSize.sm} text-muted-foreground`} />
                    <div>
                      <span className="font-medium">Vom vorherigen Kunden</span>
                      {travelSuggestion?.previousCustomerName && (
                        <p className="text-xs text-muted-foreground">
                          {travelSuggestion.previousCustomerName}
                        </p>
                      )}
                    </div>
                  </Label>
                </div>
              </RadioGroup>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="kilometers">Gefahrene Kilometer (Anfahrt)</Label>
                  <div className="relative">
                    <Input
                      id="kilometers"
                      type="number"
                      min="0"
                      step="0.1"
                      value={formData.travelKilometers || ""}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        travelKilometers: parseFloat(e.target.value) || 0,
                      }))}
                      placeholder="0"
                      className="pr-12"
                      data-testid="input-kilometers"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                      km
                    </span>
                  </div>
                </div>
                
                {formData.travelOriginType === "appointment" && (
                  <div className="space-y-2">
                    <Label htmlFor="travelMinutes">Fahrzeit</Label>
                    <div className="relative">
                      <Input
                        id="travelMinutes"
                        type="number"
                        min="0"
                        value={formData.travelMinutes || ""}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          travelMinutes: parseInt(e.target.value) || 0,
                        }))}
                        placeholder="0"
                        className="pr-12"
                        data-testid="input-travel-minutes"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                        Min.
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Zusätzliche Notizen (optional)</Label>
                <Textarea
                  id="notes"
                  value={formData.notes}
                  onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                  placeholder="Weitere Anmerkungen zum Termin..."
                  rows={3}
                  data-testid="textarea-notes"
                />
              </div>
            </CardContent>
          </Card>
          
          <Button 
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={handleSubmit}
            disabled={submitMutation.isPending}
            data-testid="button-submit"
          >
            {submitMutation.isPending ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird gespeichert...
              </>
            ) : (
              <>
                <Check className={`${iconSize.sm} mr-2`} />
                Dokumentation abschließen
              </>
            )}
          </Button>
        </div>
      )}
    </Layout>
  );
}
