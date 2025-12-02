import { useState, useMemo, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronLeft, Loader2, Calendar, Clock, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAppointment } from "@/features/appointments";
import { DURATION_OPTIONS } from "@shared/types";
import type { Customer } from "@shared/schema";

export default function EditAppointment() {
  const [, params] = useRoute("/edit-appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const id = params?.id ? parseInt(params.id) : 0;

  const { data: appointment, isLoading: appointmentLoading } = useAppointment(id);
  
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await fetch("/api/customers");
      if (!res.ok) throw new Error("Failed to fetch customers");
      return res.json();
    },
  });

  const [date, setDate] = useState<string>("");
  const [time, setTime] = useState<string>("");
  const [hauswirtschaft, setHauswirtschaft] = useState<boolean>(false);
  const [hauswirtschaftDauer, setHauswirtschaftDauer] = useState<number>(60);
  const [alltagsbegleitung, setAlltagsbegleitung] = useState<boolean>(false);
  const [alltagsbegleitungDauer, setAlltagsbegleitungDauer] = useState<number>(60);
  const [notes, setNotes] = useState<string>("");
  const [endTime, setEndTime] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (appointment) {
      setDate(appointment.date);
      setTime(appointment.scheduledStart.slice(0, 5));
      setNotes(appointment.notes || "");
      
      if (appointment.appointmentType === "Kundentermin") {
        setHauswirtschaft(!!appointment.hauswirtschaftDauer);
        setHauswirtschaftDauer(appointment.hauswirtschaftDauer || 60);
        setAlltagsbegleitung(!!appointment.alltagsbegleitungDauer);
        setAlltagsbegleitungDauer(appointment.alltagsbegleitungDauer || 60);
      } else if (appointment.scheduledEnd) {
        setEndTime(appointment.scheduledEnd.slice(0, 5));
      }
    }
  }, [appointment]);

  const summary = useMemo(() => {
    if (!appointment) return null;
    
    if (appointment.appointmentType === "Erstberatung") {
      return {
        startTime: time,
        endTime: endTime,
        totalFormatted: endTime ? `${time} - ${endTime}` : ""
      };
    }
    
    const services: { name: string; duration: number }[] = [];
    if (hauswirtschaft) {
      services.push({ name: "Hauswirtschaft", duration: hauswirtschaftDauer });
    }
    if (alltagsbegleitung) {
      services.push({ name: "Alltagsbegleitung", duration: alltagsbegleitungDauer });
    }
    
    const totalMinutes = services.reduce((sum, s) => sum + s.duration, 0);
    
    let calculatedEndTime = "";
    if (time && totalMinutes > 0) {
      const [hours, mins] = time.split(":").map(Number);
      const totalMins = hours * 60 + mins + totalMinutes;
      const endHours = Math.floor(totalMins / 60) % 24;
      const endMins = totalMins % 60;
      calculatedEndTime = `${endHours.toString().padStart(2, "0")}:${endMins.toString().padStart(2, "0")}`;
    }
    
    const formatDuration = (mins: number) => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h === 0) return `${m} Min.`;
      if (m === 0) return `${h} Std.`;
      return `${h} Std. ${m} Min.`;
    };
    
    return {
      services,
      totalMinutes,
      totalFormatted: formatDuration(totalMinutes),
      startTime: time,
      endTime: calculatedEndTime,
      hasServices: services.length > 0
    };
  }, [appointment, time, endTime, hauswirtschaft, hauswirtschaftDauer, alltagsbegleitung, alltagsbegleitungDauer]);

  const updateMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/appointments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Termin konnte nicht aktualisiert werden");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      toast({ title: "Termin aktualisiert", description: "Die Änderungen wurden gespeichert." });
      setLocation("/");
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    
    if (appointment?.appointmentType === "Kundentermin") {
      if (!hauswirtschaft && !alltagsbegleitung) {
        newErrors.services = "Bitte wählen Sie mindestens einen Service";
      }
    } else {
      if (time >= endTime) {
        newErrors.time = "Endzeit muss nach Startzeit liegen";
      }
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate() || !appointment) return;
    
    if (appointment.appointmentType === "Kundentermin") {
      const totalDuration = (hauswirtschaft ? hauswirtschaftDauer : 0) + (alltagsbegleitung ? alltagsbegleitungDauer : 0);
      const [hours, mins] = time.split(":").map(Number);
      const totalMins = hours * 60 + mins + totalDuration;
      const endHours = Math.floor(totalMins / 60) % 24;
      const endMins = totalMins % 60;
      const calculatedEndTime = `${endHours.toString().padStart(2, "0")}:${endMins.toString().padStart(2, "0")}`;
      
      let serviceType = null;
      if (hauswirtschaft && alltagsbegleitung) {
        serviceType = "Hauswirtschaft";
      } else if (hauswirtschaft) {
        serviceType = "Hauswirtschaft";
      } else if (alltagsbegleitung) {
        serviceType = "Alltagsbegleitung";
      }
      
      updateMutation.mutate({
        date,
        scheduledStart: time,
        scheduledEnd: calculatedEndTime,
        durationPromised: totalDuration,
        hauswirtschaftDauer: hauswirtschaft ? hauswirtschaftDauer : null,
        alltagsbegleitungDauer: alltagsbegleitung ? alltagsbegleitungDauer : null,
        serviceType,
        notes: notes || null,
      });
    } else {
      const startMinutes = parseInt(time.split(":")[0]) * 60 + parseInt(time.split(":")[1]);
      const endMinutes = parseInt(endTime.split(":")[0]) * 60 + parseInt(endTime.split(":")[1]);
      const duration = endMinutes - startMinutes;
      
      updateMutation.mutate({
        date,
        scheduledStart: time,
        scheduledEnd: endTime,
        durationPromised: duration,
        notes: notes || null,
      });
    }
  };

  if (appointmentLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
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
        <div className="text-center py-12 space-y-4">
          <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto" />
          <h2 className="text-xl font-bold">Bearbeitung nicht möglich</h2>
          <p className="text-muted-foreground">Abgeschlossene Termine können nicht bearbeitet werden.</p>
          <Button variant="outline" onClick={() => setLocation("/")}>
            Zurück zur Übersicht
          </Button>
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
          onClick={() => setLocation("/")}
          data-testid="button-back"
        >
          <ChevronLeft className="w-4 h-4 mr-1" /> Zurück
        </Button>
        <h1 className="text-2xl font-bold">Termin bearbeiten</h1>
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="date">
                <Calendar className="w-4 h-4 inline mr-1" /> Datum
              </Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                data-testid="input-date"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="time">
                <Clock className="w-4 h-4 inline mr-1" /> Startzeit
              </Label>
              <Input
                id="time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                data-testid="input-time"
              />
            </div>
          </div>

          {isKundentermin ? (
            <div className="space-y-4">
              <Label>Services (mindestens einer)</Label>
              
              <div className="flex items-center space-x-3 p-4 rounded-lg border">
                <Checkbox
                  id="hauswirtschaft"
                  checked={hauswirtschaft}
                  onCheckedChange={(checked) => {
                    setHauswirtschaft(!!checked);
                    if (!checked) setHauswirtschaftDauer(60);
                  }}
                  data-testid="checkbox-hauswirtschaft"
                />
                <div className="flex-1">
                  <Label htmlFor="hauswirtschaft" className="cursor-pointer font-medium">
                    Hauswirtschaft
                  </Label>
                </div>
                {hauswirtschaft && (
                  <Select
                    value={hauswirtschaftDauer.toString()}
                    onValueChange={(v) => setHauswirtschaftDauer(parseInt(v))}
                  >
                    <SelectTrigger className="w-28" data-testid="select-hauswirtschaft-dauer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_OPTIONS.map((d) => (
                        <SelectItem key={d} value={d.toString()}>
                          {d} Min.
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="flex items-center space-x-3 p-4 rounded-lg border">
                <Checkbox
                  id="alltagsbegleitung"
                  checked={alltagsbegleitung}
                  onCheckedChange={(checked) => {
                    setAlltagsbegleitung(!!checked);
                    if (!checked) setAlltagsbegleitungDauer(60);
                  }}
                  data-testid="checkbox-alltagsbegleitung"
                />
                <div className="flex-1">
                  <Label htmlFor="alltagsbegleitung" className="cursor-pointer font-medium">
                    Alltagsbegleitung
                  </Label>
                </div>
                {alltagsbegleitung && (
                  <Select
                    value={alltagsbegleitungDauer.toString()}
                    onValueChange={(v) => setAlltagsbegleitungDauer(parseInt(v))}
                  >
                    <SelectTrigger className="w-28" data-testid="select-alltagsbegleitung-dauer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_OPTIONS.map((d) => (
                        <SelectItem key={d} value={d.toString()}>
                          {d} Min.
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {errors.services && <p className="text-destructive text-sm">{errors.services}</p>}

              {summary && summary.hasServices && (
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2 text-primary font-semibold">
                    <Clock className="w-4 h-4" />
                    <span>Terminübersicht</span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Von</span>
                      <p className="font-medium text-lg">{summary.startTime} Uhr</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Bis</span>
                      <p className="font-medium text-lg">{summary.endTime} Uhr</p>
                    </div>
                  </div>

                  <div className="border-t border-primary/10 pt-3 space-y-1">
                    {summary.services?.map((s, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span>{s.name}</span>
                        <span className="text-muted-foreground">{s.duration} Min.</span>
                      </div>
                    ))}
                    <div className="flex justify-between font-medium pt-1 border-t border-primary/10">
                      <span>Gesamt</span>
                      <span className="text-primary">{summary.totalFormatted}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="endTime">
                <Clock className="w-4 h-4 inline mr-1" /> Endzeit
              </Label>
              <Input
                id="endTime"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                data-testid="input-endtime"
              />
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
            className="w-full"
            size="lg"
            onClick={handleSubmit}
            disabled={updateMutation.isPending}
            data-testid="button-save"
          >
            {updateMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Änderungen speichern
          </Button>
        </CardContent>
      </Card>
    </Layout>
  );
}
