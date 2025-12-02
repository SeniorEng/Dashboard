import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointment, useUpdateAppointment, calculateDuration, formatTime, getDisplayLabel } from "@/features/appointments";
import { SERVICE_OPTIONS } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { 
  MapPin, Clock, Navigation, 
  CheckCircle2, Play, StopCircle, FileText, Save, ChevronLeft, Loader2
} from "lucide-react";
import SignatureCanvas from "react-signature-canvas";
import { useToast } from "@/hooks/use-toast";

export default function AppointmentDetail() {
  const [, params] = useRoute("/appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const id = params?.id ? parseInt(params.id) : 0;
  
  const { data: appointment, isLoading } = useAppointment(id);
  const updateMutation = useUpdateAppointment();
  
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [kilometers, setKilometers] = useState("");
  const [notes, setNotes] = useState("");
  const [servicesDone, setServicesDone] = useState<string[]>([]);
  const sigPad = useRef<SignatureCanvas>(null);

  // Initialize state when appointment loads
  useEffect(() => {
    if (appointment) {
      if (appointment.startTime) setStartTime(new Date(appointment.startTime));
      if (appointment.endTime) setEndTime(new Date(appointment.endTime));
      if (appointment.kilometers) setKilometers(appointment.kilometers);
      if (appointment.notes) setNotes(appointment.notes);
      if (appointment.servicesDone) setServicesDone(appointment.servicesDone);
    }
  }, [appointment]);

  // Memoized duration calculation
  const duration = useMemo(() => calculateDuration(startTime, endTime), [startTime, endTime]);

  // Callbacks for handlers
  const handleStartVisit = useCallback(() => {
    if (!appointment) return;
    const now = new Date();
    setStartTime(now);
    updateMutation.mutate({
      id: appointment.id,
      data: { status: "in-progress", startTime: now }
    }, {
      onSuccess: () => {
        toast({
          title: "Besuch gestartet",
          description: `Besuch bei ${appointment.customer?.name} um ${formatTime(now)} gestartet`,
        });
      }
    });
  }, [appointment, updateMutation, toast]);

  const handleFinishVisit = useCallback(() => {
    if (!appointment) return;
    const now = new Date();
    setEndTime(now);
    updateMutation.mutate({
      id: appointment.id,
      data: { status: "documenting", endTime: now }
    });
  }, [appointment, updateMutation]);

  const handleComplete = useCallback(() => {
    if (!appointment) return;
    if (!sigPad.current || sigPad.current.isEmpty()) {
      toast({
        variant: "destructive",
        title: "Unterschrift erforderlich",
        description: "Bitte lassen Sie den Kunden unterschreiben.",
      });
      return;
    }

    const signatureData = sigPad.current.toDataURL();
    
    updateMutation.mutate({
      id: appointment.id,
      data: { 
        status: "completed",
        kilometers,
        notes,
        servicesDone,
        signatureData
      }
    }, {
      onSuccess: () => {
        toast({
          title: "Besuch abgeschlossen",
          description: "Dokumentation erfolgreich gespeichert.",
        });
        setTimeout(() => setLocation("/"), 1500);
      }
    });
  }, [appointment, kilometers, notes, servicesDone, updateMutation, toast, setLocation]);

  const handleServiceToggle = useCallback((service: string, checked: boolean) => {
    setServicesDone(prev => 
      checked ? [...prev, service] : prev.filter(s => s !== service)
    );
  }, []);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12" data-testid="loading-appointment">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (!appointment) {
    return (
      <Layout>
        <div className="text-center py-12" data-testid="not-found-appointment">
          Termin nicht gefunden
        </div>
      </Layout>
    );
  }

  const displayLabel = getDisplayLabel(appointment);

  const renderContent = () => {
    switch (appointment.status) {
      case "scheduled":
        return (
          <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-primary/5 border border-primary/10 rounded-2xl p-6 text-center space-y-4">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-primary mb-2">
                <Clock className="w-8 h-8" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground text-lg">Bereit zum Starten?</h3>
                <p className="text-muted-foreground text-sm mt-1">
                  Geplant für {appointment.time} Uhr • {appointment.durationPromised} Min.
                </p>
              </div>
              <Button 
                size="lg" 
                className="w-full font-bold shadow-lg shadow-primary/20" 
                onClick={handleStartVisit}
                disabled={updateMutation.isPending}
                data-testid="button-start-visit"
              >
                <Play className="w-4 h-4 mr-2 fill-current" /> Besuch starten
              </Button>
            </div>

            {appointment.customer && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Leistungsplan</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-3">
                    {appointment.customer.needs.map((need, i) => (
                      <li key={i} className="flex items-center gap-3 text-sm">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary/60" />
                        {need}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        );

      case "in-progress":
        return (
          <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-8 text-center space-y-6 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-blue-200 animate-pulse" />
              <div className="space-y-2">
                <span className="text-blue-600 text-sm font-bold uppercase tracking-wider">Besuch läuft</span>
                <div className="text-4xl font-bold text-blue-900 font-mono">Aktiv</div>
                <p className="text-blue-600/80 text-sm">Gestartet um {formatTime(startTime)}</p>
              </div>
              <Button 
                size="lg" 
                variant="destructive" 
                className="w-full font-bold" 
                onClick={handleFinishVisit}
                disabled={updateMutation.isPending}
                data-testid="button-finish-visit"
              >
                <StopCircle className="w-4 h-4 mr-2 fill-current" /> Besuch beenden
              </Button>
            </div>

            {appointment.customer && (
              <Card className="opacity-80">
                <CardHeader>
                  <CardTitle className="text-base">Kundenbedürfnisse</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    {appointment.customer.needs.map((need, i) => (
                      <li key={i}>• {need}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        );

      case "documenting":
        return (
          <div className="space-y-6 animate-in slide-in-from-bottom-8 duration-500">
            <div className="bg-orange-50 border border-orange-100 p-4 rounded-xl flex items-center gap-3 text-orange-800 text-sm">
              <Clock className="w-5 h-5 shrink-0" />
              <div>
                <span className="font-bold">Besuchsdauer:</span>
                {duration !== null ? ` ${duration} Minuten` : " --"}
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <FileText className="w-5 h-5 text-primary" />
                  Dokumentation
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-3">
                  <Label className="text-base">Erbrachte Leistungen</Label>
                  <div className="grid grid-cols-1 gap-3">
                    {SERVICE_OPTIONS.map((service) => (
                      <div key={service} className="flex items-center space-x-3 p-3 rounded-lg border border-input hover:bg-accent/50 transition-colors">
                        <Checkbox 
                          id={service} 
                          checked={servicesDone.includes(service)}
                          onCheckedChange={(checked) => handleServiceToggle(service, !!checked)}
                          data-testid={`checkbox-${service.toLowerCase().replace(/\s+/g, "-")}`}
                        />
                        <Label htmlFor={service} className="font-normal cursor-pointer flex-1">{service}</Label>
                      </div>
                    ))}
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="notes">Notizen / Beobachtungen</Label>
                  <Textarea 
                    id="notes" 
                    placeholder="Beschreiben Sie kurz, was gemacht wurde..." 
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="min-h-[100px]"
                    data-testid="textarea-notes"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="km">Fahrtstrecke (km)</Label>
                  <div className="relative">
                    <Input 
                      id="km" 
                      type="number" 
                      placeholder="0" 
                      value={kilometers}
                      onChange={(e) => setKilometers(e.target.value)}
                      className="pl-10"
                      data-testid="input-kilometers"
                    />
                    <Navigation className="w-4 h-4 absolute left-3 top-3 text-muted-foreground" />
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <Label>Kundenunterschrift</Label>
                  <div className="border rounded-lg overflow-hidden bg-white shadow-inner">
                    <SignatureCanvas 
                      ref={sigPad}
                      penColor="black"
                      canvasProps={{ width: 300, height: 150, className: "w-full h-[150px]" }} 
                    />
                  </div>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={() => sigPad.current?.clear()} 
                    className="text-xs text-muted-foreground"
                    data-testid="button-clear-signature"
                  >
                    Unterschrift löschen
                  </Button>
                </div>
              </CardContent>
              <CardFooter className="bg-muted/20 p-6">
                <Button 
                  size="lg" 
                  className="w-full font-bold text-lg h-12" 
                  onClick={handleComplete}
                  disabled={updateMutation.isPending}
                  data-testid="button-complete-documentation"
                >
                  <Save className="w-5 h-5 mr-2" /> Dokumentation abschließen
                </Button>
              </CardFooter>
            </Card>
          </div>
        );

      case "completed":
        return (
          <div className="text-center py-12 space-y-6 animate-in zoom-in-90 duration-500">
            <div className="w-24 h-24 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-12 h-12" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">Alles erledigt!</h2>
            <p className="text-muted-foreground max-w-xs mx-auto">
              Besuch erfolgreich dokumentiert und gespeichert. Gut gemacht!
            </p>
            <Button size="lg" variant="outline" onClick={() => setLocation("/")} data-testid="button-back-dashboard">
              Zurück zur Übersicht
            </Button>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Layout>
      <div className="mb-6">
        <Button 
          variant="ghost" 
          size="sm" 
          className="pl-0 text-muted-foreground hover:text-foreground mb-4" 
          onClick={() => setLocation("/")}
          data-testid="button-back"
        >
          <ChevronLeft className="w-4 h-4 mr-1" /> Zurück zum Tagesplan
        </Button>

        {appointment.customer && (
          <div className="mb-6">
            <Badge variant="secondary" className="mb-2">{displayLabel}</Badge>
            <h1 className="text-2xl font-bold leading-tight" data-testid="text-customer-name">
              {appointment.customer.name}
            </h1>
            <div className="flex items-center text-muted-foreground text-sm mt-1">
              <MapPin className="w-3.5 h-3.5 mr-1 text-primary" />
              {appointment.customer.address}
            </div>
          </div>
        )}
      </div>

      {renderContent()}
    </Layout>
  );
}
