import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  ChevronLeft, ChevronRight, Loader2, Clock, 
  Car, Check, AlertCircle, X, Plus, User
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
  } = useDocumentationForm(id);

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
          <TravelDocumentation
            travelOriginType={formData.travelOriginType}
            onTravelOriginTypeChange={(value) => setFormData(prev => ({
              ...prev,
              travelOriginType: value,
              travelMinutes: value === "home" ? 0 : prev.travelMinutes,
            }))}
            travelKilometers={formData.travelKilometers}
            onTravelKilometersChange={(value) => setFormData(prev => ({ ...prev, travelKilometers: value }))}
            travelMinutes={formData.travelMinutes}
            onTravelMinutesChange={(value) => setFormData(prev => ({ ...prev, travelMinutes: value }))}
            previousCustomerName={travelSuggestion?.previousCustomerName}
            notes={formData.notes}
            onNotesChange={(value) => setFormData(prev => ({ ...prev, notes: value }))}
          />
          
          <Button 
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={handleSubmit}
            disabled={documentMutation.isPending}
            data-testid="button-submit"
          >
            {documentMutation.isPending ? (
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
