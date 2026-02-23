import { useState, useMemo, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, Loader2, Calendar, Clock, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { useAppointment, useCustomerList, ServiceSelector, AppointmentSummary } from "@/features/appointments";
import { addMinutesToTime, timeToMinutes, minutesToTimeDisplay, formatDurationDisplay } from "@shared/utils/datetime";
import { DURATION_OPTIONS, formatDuration } from "@shared/types";
import type { Service } from "@shared/schema";

export default function EditAppointment() {
  const [, params] = useRoute("/edit-appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const id = params?.id ? parseInt(params.id) : 0;

  const { data: appointment, isLoading: appointmentLoading } = useAppointment(id);
  
  const { data: customers = [] } = useCustomerList();

  const { data: appointmentServiceEntries = [] } = useQuery<Array<{
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
      } else if (appointment.scheduledEnd) {
        const start = appointment.scheduledStart.slice(0, 5);
        const end = appointment.scheduledEnd.slice(0, 5);
        setEndTime(end);
        const startMin = timeToMinutes(start);
        const endMin = timeToMinutes(end);
        const dur = endMin - startMin;
        if (dur > 0) setDuration(dur);
      }
    }
  }, [appointment, appointmentServiceEntries, catalogServices]);

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
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}/services`] });
      toast({ title: "Termin aktualisiert", description: "Die Änderungen wurden gespeichert." });
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
    } else {
      if (!duration || duration <= 0) {
        newErrors.time = "Bitte wählen Sie eine Dauer";
      }
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate() || !appointment) return;
    
    if (appointment.appointmentType === "Kundentermin") {
      const totalDuration = services.reduce((sum, s) => sum + s.durationMinutes, 0);
      const calculatedEndTime = addMinutesToTime(time, totalDuration);
      
      updateMutation.mutate({
        date,
        scheduledStart: time,
        scheduledEnd: calculatedEndTime,
        durationPromised: totalDuration,
        notes: notes || null,
        services: services.map(s => ({
          serviceId: s.serviceId,
          plannedDurationMinutes: s.durationMinutes,
        })),
      });
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

  if (appointment.status === "completed") {
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
        <h1 className={componentStyles.pageTitle}>Termin bearbeiten</h1>
        {appointment.customer && (
          <p className="text-muted-foreground mt-1">{appointment.customer.name}</p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {isKundentermin ? "Kundentermin" : "Erstberatung"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>
                <Calendar className={`${iconSize.sm} inline mr-1`} /> Datum
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
                <Clock className={`${iconSize.sm} inline mr-1`} /> Startzeit
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

          {isKundentermin ? (
            <div className="space-y-4">
              <ServiceSelector
                services={services}
                onChange={setServices}
                error={errors.services}
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
              {errors.time && <p className="text-destructive text-sm">{errors.time}</p>}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notizen (optional, max. 255 Zeichen)</Label>
            <Textarea
              id="notes"
              placeholder="Besondere Hinweise..."
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
            disabled={updateMutation.isPending}
            data-testid="button-save"
          >
            {updateMutation.isPending ? <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} /> : null}
            Änderungen speichern
          </Button>
        </CardContent>
      </Card>
    </Layout>
  );
}
