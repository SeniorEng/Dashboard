import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  ChevronLeft, ChevronRight, Loader2, Clock, 
  Users, Check, AlertCircle, X, Plus, User, UserX
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useDocumentationForm, type ServiceFormData, type DocumentationFormData, PerformedBySelector, TravelDocumentation } from "@/features/appointments";
import { 
  formatDuration, 
  DURATION_OPTIONS,
} from "@shared/types";

export default function DocumentAppointment() {
  const [, params] = useRoute("/document-appointment/:id");
  const [, setLocation] = useLocation();
  const id = params?.id ? parseInt(params.id) : 0;

  const {
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
    handleTravelOriginChange,
    submitState,
    submitError,
    retrySubmit,
    dismissSubmitError,
  } = useDocumentationForm(id);

  const isSubmitting = submitState === "submitting" || documentMutation.isPending;
  const isSubmitted = submitState === "success";

  const customerTravelEligible = formData.services.some(
    s => s.serviceType === "Hauswirtschaft" || s.serviceType === "Alltagsbegleitung"
  );
  const [hasCustomerTravel, setHasCustomerTravel] = useState<"yes" | "no">("no");
  const [customerTravelInit, setCustomerTravelInit] = useState(false);
  useEffect(() => {
    if (!customerTravelInit && formData.services.length > 0) {
      setHasCustomerTravel(formData.customerKilometers > 0 ? "yes" : "no");
      setCustomerTravelInit(true);
    }
  }, [customerTravelInit, formData.services.length, formData.customerKilometers]);

  const handleCustomerTravelToggle = (value: "yes" | "no") => {
    setHasCustomerTravel(value);
    if (value === "no") {
      setFormData(prev => ({ ...prev, customerKilometers: 0 }));
    }
  };

  const totalServiceMinutes = formData.services.reduce((sum, s) => sum + (s.actualDuration || 0), 0);
  const showCustomerTravelBlock = customerTravelEligible;

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
        
        <h1 className={componentStyles.pageTitle} data-testid="text-title">
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
          {isAdmin && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <User className={`${iconSize.md} text-primary`} />
                  Durchgeführt von
                </CardTitle>
                <CardDescription>
                  Wer hat diesen Termin durchgeführt?
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PerformedBySelector
                  value={formData.performedByEmployeeId}
                  onChange={(val) => setFormData(prev => ({ ...prev, performedByEmployeeId: val }))}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className={`${iconSize.md} text-primary`} />
                Tatsächliche Startzeit
              </CardTitle>
              <CardDescription>
                Wann hat der Termin tatsächlich begonnen?
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Label htmlFor="actualStart">Startzeit</Label>
                  <Input
                    id="actualStart"
                    type="time"
                    className="min-h-[44px] text-base"
                    value={formData.actualStart}
                    onChange={(e) => setFormData(prev => ({ ...prev, actualStart: e.target.value }))}
                    data-testid="input-actual-start"
                  />
                </div>
                {calculatedEnd && (
                  <div className="flex-1">
                    <Label>Berechnetes Ende</Label>
                    <div className="min-h-[44px] flex items-center text-base text-muted-foreground bg-muted/50 rounded-md px-3">
                      {calculatedEnd} Uhr
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

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
                        <Select
                          value={service.actualDuration.toString()}
                          onValueChange={(v) => updateService(index, "actualDuration", parseInt(v))}
                        >
                          <SelectTrigger className="w-auto min-w-[140px]" data-testid={`select-duration-${service.serviceType.toLowerCase()}`}>
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
                    
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={`details-${index}`}>Servicedetails *</Label>
                        <span className={`text-xs ${service.details.length > 120 ? "text-destructive" : "text-muted-foreground"}`}>
                          {service.details.length}/120
                        </span>
                      </div>
                      <Input
                        id={`details-${index}`}
                        value={service.details}
                        onChange={(e) => updateService(index, "details", e.target.value.slice(0, 120))}
                        placeholder={
                          service.serviceType === "Hauswirtschaft" 
                            ? "z.B. Wäsche gewaschen, Boden gewischt" 
                            : service.serviceType === "Alltagsbegleitung"
                            ? "z.B. Begleitung zum Arzt, Spaziergang"
                            : "z.B. Beratung durchgeführt"
                        }
                        maxLength={120}
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

          <Button 
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={handleNext}
            data-testid="button-next"
          >
            Weiter
            <ChevronRight className={`${iconSize.sm} ml-2`} />
          </Button>

          {appointment?.customerId && (
            <Button
              variant="outline"
              className="w-full border-amber-300 text-amber-800 hover:bg-amber-50"
              size="lg"
              onClick={() => setLocation(`/document-appointment/${id}/no-show`)}
              data-testid="button-noshow"
            >
              <UserX className={`${iconSize.sm} mr-2`} />
              Kunde nicht angetroffen / abgesagt
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <TravelDocumentation
            travelOriginType={formData.travelOriginType}
            onTravelOriginTypeChange={handleTravelOriginChange}
            travelKilometers={formData.travelKilometers}
            onTravelKilometersChange={(value) => setFormData(prev => ({ ...prev, travelKilometers: value }))}
            travelMinutes={formData.travelMinutes}
            onTravelMinutesChange={(value) => setFormData(prev => ({ ...prev, travelMinutes: value }))}
            previousCustomerName={travelSuggestion?.previousCustomerName}
            notes={formData.notes}
            onNotesChange={(value) => setFormData(prev => ({ ...prev, notes: value }))}
            suggestedKilometers={travelSuggestion?.suggestedKilometers ?? null}
            suggestedMinutes={travelSuggestion?.suggestedMinutes ?? null}
          />

          {showCustomerTravelBlock && (
            <Card className="border-l-4 border-l-amber-500">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className={`${iconSize.md} text-amber-600`} />
                  Fahrten während des Termins
                </CardTitle>
                <CardDescription>
                  Sind Sie <strong>mit</strong> dem Kunden unterwegs gewesen? z.B. Arztbesuch, Einkauf, Behördengang.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <RadioGroup
                  value={hasCustomerTravel}
                  onValueChange={(v) => handleCustomerTravelToggle(v as "yes" | "no")}
                  className="space-y-2"
                >
                  <div className={`flex items-center space-x-3 p-3 rounded-lg border ${hasCustomerTravel === "no" ? "border-amber-500 bg-amber-50" : "border-border"}`}>
                    <RadioGroupItem value="no" id="customer-travel-no" data-testid="radio-customer-travel-no" />
                    <Label htmlFor="customer-travel-no" className="cursor-pointer flex-1 font-medium">
                      Nein, keine Fahrten mit dem Kunden
                    </Label>
                  </div>
                  <div className={`flex items-center space-x-3 p-3 rounded-lg border ${hasCustomerTravel === "yes" ? "border-amber-500 bg-amber-50" : "border-border"}`}>
                    <RadioGroupItem value="yes" id="customer-travel-yes" data-testid="radio-customer-travel-yes" />
                    <Label htmlFor="customer-travel-yes" className="cursor-pointer flex-1 font-medium">
                      Ja, ich bin mit dem Kunden unterwegs gewesen
                    </Label>
                  </div>
                </RadioGroup>

                {hasCustomerTravel === "yes" && (
                  <div className="space-y-2">
                    <Label htmlFor="customerKilometers">Gefahrene Kilometer mit dem Kunden</Label>
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
                    <p className="text-xs text-muted-foreground">
                      z.B. Arztbesuch, Einkauf, Behördengang — Strecken, die Sie <strong>während</strong> des Termins gemeinsam mit dem Kunden gefahren sind.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="bg-muted/40" data-testid="card-summary">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Zusammenfassung</CardTitle>
              <CardDescription>
                Bitte prüfen Sie die Eingaben, bevor Sie abschließen.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {formData.services.map((s, i) => (
                <div key={i} className="flex justify-between" data-testid={`summary-service-${s.serviceType.toLowerCase()}`}>
                  <span className="text-muted-foreground">{s.serviceType}</span>
                  <span className="font-medium">{formatDuration(s.actualDuration)}</span>
                </div>
              ))}
              {totalServiceMinutes > 0 && (
                <div className="flex justify-between pt-2 border-t">
                  <span className="text-muted-foreground">Gesamt-Dauer</span>
                  <span className="font-medium" data-testid="summary-total-duration">{formatDuration(totalServiceMinutes)}</span>
                </div>
              )}
              <div className={`flex justify-between pt-2 border-t ${formData.travelKilometers > 0 ? "" : "text-muted-foreground/60"}`}>
                <span>Anfahrt zum Kunden</span>
                <span data-testid="summary-travel-km">
                  {formData.travelKilometers > 0 ? `${formData.travelKilometers} km` : "keine"}
                </span>
              </div>
              {showCustomerTravelBlock && (
                <div className={`flex justify-between ${formData.customerKilometers > 0 ? "" : "text-muted-foreground/60"}`}>
                  <span>Fahrten mit dem Kunden</span>
                  <span data-testid="summary-customer-km">
                    {formData.customerKilometers > 0 ? `${formData.customerKilometers} km` : "keine"}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {submitError && (
            <Card
              className="border-destructive bg-destructive/5"
              data-testid="banner-submit-error"
              role="alert"
            >
              <CardContent className="pt-4 pb-4 space-y-3">
                <div className="flex items-start gap-3">
                  <AlertCircle className={`${iconSize.md} text-destructive shrink-0 mt-0.5`} />
                  <div className="flex-1">
                    <p className="font-medium text-destructive" data-testid="text-submit-error-title">
                      Dokumentation nicht gespeichert
                    </p>
                    <p className="text-sm text-destructive/90 mt-1" data-testid="text-submit-error-message">
                      {submitError.message}
                    </p>
                  </div>
                </div>
                {submitError.canRetry && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      variant="default"
                      className="flex-1"
                      onClick={retrySubmit}
                      disabled={isSubmitting}
                      data-testid="button-retry-submit"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                          Wird erneut gespeichert...
                        </>
                      ) : (
                        <>
                          <Check className={`${iconSize.sm} mr-2`} />
                          Erneut speichern
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={dismissSubmitError}
                      disabled={isSubmitting}
                      data-testid="button-dismiss-submit-error"
                    >
                      Schließen
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {isSubmitted && (
            <Card
              className="border-green-300 bg-green-50"
              data-testid="banner-submit-success"
              role="status"
            >
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <Check className={`${iconSize.md} text-green-700`} />
                <p className="font-medium text-green-800" data-testid="text-submit-success">
                  Dokumentation gespeichert
                </p>
              </CardContent>
            </Card>
          )}

          <Button
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={handleSubmit}
            disabled={isSubmitting || isSubmitted || submitError?.isAlreadyCompleted || submitError?.isSignatureLocked}
            data-testid="button-submit"
          >
            {isSubmitting ? (
              <>
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                Wird gespeichert...
              </>
            ) : isSubmitted ? (
              <>
                <Check className={`${iconSize.sm} mr-2`} />
                Gespeichert
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
