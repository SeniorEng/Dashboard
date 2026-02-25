import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointment } from "@/features/appointments";
import { useDeleteAppointment } from "@/features/appointments/hooks";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { iconSize, componentStyles, getServiceColors } from "@/design-system";
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { 
  MapPin, Calendar, FileText, ChevronLeft, Loader2, 
  Pencil, Trash2, AlertTriangle, Phone, Car, Home, ArrowRight, UserCheck, UserPlus, CheckCircle2, XCircle, Clock
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatTimeSlot, getEndTime } from "@/features/appointments/utils";
import { 
  formatDuration, 
  canModifyAppointment,
  type AppointmentStatus
} from "@shared/types";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { formatDateForDisplay } from "@shared/utils/datetime";

export default function AppointmentDetail() {
  const [, params] = useRoute("/appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const id = params?.id ? parseInt(params.id) : 0;
  const canConvert = user?.isAdmin || user?.roles?.includes("erstberatung");
  const [showDeclineDialog, setShowDeclineDialog] = useState(false);
  const [declineNote, setDeclineNote] = useState("");

  const declineMutation = useMutation({
    mutationFn: async ({ customerId, note }: { customerId: number; note?: string }) => {
      const result = await api.post(`/admin/customers/${customerId}/decline-erstberatung`, { note: note || undefined });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/appointments/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast({ title: "Erstberatung abgelehnt", description: "Der Kunde wurde als 'Kein Interesse' markiert." });
      setShowDeclineDialog(false);
      setDeclineNote("");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });
  
  const { data: appointment, isLoading } = useAppointment(id);
  const { data: appointmentServices } = useQuery<Array<{ 
    id: number;
    serviceId: number; 
    serviceName: string;
    serviceCode: string;
    serviceUnitType: string;
    plannedDurationMinutes: number; 
    actualDurationMinutes: number | null; 
    details: string | null;
  }>>({
    queryKey: [`/api/appointments/${id}/services`],
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
      }>>(`/appointments/${id}/services`);
      return unwrapResult(result);
    },
    enabled: !!id && !!appointment,
  });
  const deleteMutation = useDeleteAppointment();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleDelete = useCallback(async () => {
    try {
      await deleteMutation.mutateAsync(id);
      toast({
        title: "Termin gelöscht",
        description: "Der Termin wurde erfolgreich gelöscht.",
      });
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Der Termin konnte nicht gelöscht werden.";
      toast({
        variant: "destructive",
        title: "Fehler",
        description: message,
      });
    }
    setShowDeleteDialog(false);
  }, [deleteMutation, id, toast, setLocation]);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12" data-testid="loading-appointment">
          <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
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

  const canModify = canModifyAppointment(appointment.status as AppointmentStatus);
  const isErstberatung = appointment.appointmentType === "Erstberatung";

  const services = appointmentServices || [];
  const hasAnyService = services.length > 0;
  const hasAnyDocumentedService = services.some(s => s.actualDurationMinutes !== null && s.actualDurationMinutes > 0);
  const isCompleted = appointment.status === "completed";

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

        <div className="mb-4">
          <StatusBadge type="status" value={appointment.status} />
        </div>

        {appointment.customer && (
          <div className="mb-6">
            <h1 className={componentStyles.pageTitle} data-testid="text-customer-name">
              {appointment.customer.name}
            </h1>
            <div className="flex items-center text-muted-foreground text-sm mt-2">
              <MapPin className={`${iconSize.sm} mr-1.5 text-primary shrink-0`} />
              <span>{appointment.customer.address}</span>
            </div>
            {appointment.customer.telefon && (
              <div className="flex items-center text-muted-foreground text-sm mt-1">
                <Phone className={`${iconSize.sm} mr-1.5 text-primary shrink-0`} />
                <a href={`tel:${appointment.customer.telefon}`} className="hover:text-primary">
                  {formatPhoneForDisplay(appointment.customer.telefon)}
                </a>
              </div>
            )}
          </div>
        )}

        {isErstberatung && appointment.customerId && appointment.customer && (() => {
          const customerStatus = (appointment.customer as any).status;
          const isStillErstberatung = customerStatus === "erstberatung";
          const isDocumentedOrCompleted = appointment.status === "completed" || appointment.status === "documenting";

          if (isStillErstberatung && canConvert && isDocumentedOrCompleted) {
            return (
              <div className="mt-4 p-4 bg-white border-2 border-teal-200 rounded-lg space-y-3" data-testid="card-convert-decision">
                <p className="text-sm font-medium text-center text-gray-700">Wie möchten Sie fortfahren?</p>
                <Link href={`/customer/${appointment.customerId}/convert?fromAppointment=${appointment.id}`}>
                  <Button className="w-full bg-teal-600 hover:bg-teal-700 h-12 text-base" data-testid="button-convert-from-appointment">
                    <UserPlus className="h-5 w-5 mr-2" />
                    Neukunden-Anlage starten
                    <ArrowRight className="h-5 w-5 ml-2" />
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  className="w-full text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => setShowDeclineDialog(true)}
                  data-testid="button-decline-erstberatung"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Kein Interesse
                </Button>
              </div>
            );
          }

          if (isStillErstberatung && canConvert && !isDocumentedOrCompleted) {
            return (
              <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded-lg" data-testid="card-convert-pending">
                <div className="flex items-center gap-2">
                  <Clock className={`${iconSize.sm} text-gray-500`} />
                  <span className="text-sm text-gray-600">Nach der Erstberatung können Sie den Kunden hier übernehmen.</span>
                </div>
              </div>
            );
          }

          if (customerStatus === "aktiv") {
            return (
              <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg" data-testid="card-already-converted">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className={`${iconSize.sm} text-emerald-600`} />
                    <span className="text-sm font-medium text-emerald-700">Kunde wurde bereits übernommen</span>
                  </div>
                  <Link href={`/customer/${appointment.customerId}`}>
                    <Button size="sm" variant="outline" className="text-emerald-700 border-emerald-300" data-testid="button-view-customer">
                      Zum Kunden
                      <ArrowRight className={`${iconSize.sm} ml-1`} />
                    </Button>
                  </Link>
                </div>
              </div>
            );
          }

          if (customerStatus === "inaktiv") {
            return (
              <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded-lg" data-testid="card-declined">
                <div className="flex items-center gap-2">
                  <XCircle className={`${iconSize.sm} text-gray-500`} />
                  <span className="text-sm text-gray-600">Kein Interesse — Kunde wurde nicht übernommen</span>
                </div>
              </div>
            );
          }

          return null;
        })()}
      </div>

      <SectionCard
        title={isCompleted ? "Termin & Leistungen" : "Terminübersicht"}
        icon={<Calendar className={iconSize.sm} />}
        className="mb-4"
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between py-2 border-b border-border/50">
            <span className="text-muted-foreground">Datum</span>
            <span className="font-medium">
              {formatDateForDisplay(appointment.date, { 
                weekday: "long", 
                day: "numeric", 
                month: "long", 
                year: "numeric" 
              })}
            </span>
          </div>
          
          <div className="flex items-center justify-between py-2 border-b border-border/50">
            <span className="text-muted-foreground">Uhrzeit</span>
            <span className="font-medium">
              {formatTimeSlot(appointment.scheduledStart)} - {getEndTime(appointment)} Uhr
            </span>
          </div>

          <div className="flex items-center justify-between py-2 border-b border-border/50">
            <span className="text-muted-foreground">Art</span>
            <span className="font-medium">
              {isErstberatung ? "Erstberatung" : "Kundentermin"}
            </span>
          </div>

          {(hasAnyService || (isCompleted && hasAnyDocumentedService)) && (
            <>
              {isCompleted && hasAnyDocumentedService && (
                <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                  <span className="flex-1" />
                  <span className="w-16 text-right">Geplant</span>
                  <span className="w-16 text-right font-medium text-primary">Ist</span>
                </div>
              )}

              {services.map((service) => {
                const hasDocumented = service.actualDurationMinutes !== null && service.actualDurationMinutes > 0;
                const serviceColorKey = service.serviceCode as string;
                if (!service.plannedDurationMinutes && !(isCompleted && hasDocumented)) return null;
                
                return (
                  <div key={service.id} className="py-2 border-b border-border/50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${getServiceColors(serviceColorKey).bg}`} />
                        <span>{service.serviceName}</span>
                      </div>
                      {isCompleted && hasDocumented ? (
                        <div className="flex items-center">
                          <span className="w-16 text-right text-muted-foreground text-sm">
                            {service.plannedDurationMinutes ? formatDuration(service.plannedDurationMinutes) : "—"}
                          </span>
                          <span className="w-16 text-right font-medium text-primary">
                            {formatDuration(service.actualDurationMinutes!)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">
                          {service.plannedDurationMinutes ? formatDuration(service.plannedDurationMinutes) : "—"}
                        </span>
                      )}
                    </div>
                    {isCompleted && service.details && (
                      <p className="text-sm text-muted-foreground mt-1 ml-4">
                        {service.details}
                      </p>
                    )}
                  </div>
                );
              })}

              <div className="flex items-center justify-between py-2 pt-2 border-t border-border">
                <span className="font-medium">Gesamt</span>
                {isCompleted && hasAnyDocumentedService ? (
                  <div className="flex items-center">
                    <span className="w-16 text-right text-muted-foreground text-sm">
                      {formatDuration(appointment.durationPromised || 0)}
                    </span>
                    <span className="w-16 text-right font-medium text-primary">
                      {formatDuration(
                        services.reduce((sum, s) => sum + (s.actualDurationMinutes || 0), 0)
                      )}
                    </span>
                  </div>
                ) : (
                  <span className="font-medium">
                    {formatDuration(appointment.durationPromised || 0)}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </SectionCard>

      {isCompleted && (
        <SectionCard
          title="Fahrt"
          icon={<Car className={iconSize.sm} />}
          className="mb-4"
        >
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                {appointment.travelOriginType === "home" ? (
                  <Home className={`${iconSize.xs} text-muted-foreground`} />
                ) : (
                  <ArrowRight className={`${iconSize.xs} text-muted-foreground`} />
                )}
                <span className="text-muted-foreground">
                  {appointment.travelOriginType === "home" ? "Von zu Hause" : "Vom vorherigen Kunden"}
                </span>
              </div>
              {appointment.travelOriginType === "appointment" && appointment.travelMinutes && (
                <span>{appointment.travelMinutes} Min.</span>
              )}
            </div>
            
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                <Car className={`${iconSize.xs} text-muted-foreground`} />
                <span className="text-muted-foreground">Anfahrt</span>
              </div>
              <span>{appointment.travelKilometers || 0} km</span>
            </div>
            
            {appointment.customerKilometers != null && appointment.customerKilometers > 0 && (
              <div className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                  <Car className={`${iconSize.xs} text-muted-foreground`} />
                  <span className="text-muted-foreground">Km für/mit Kunde</span>
                </div>
                <span>{appointment.customerKilometers} km</span>
              </div>
            )}
            
            {((appointment.travelKilometers || 0) + (appointment.customerKilometers || 0)) > 0 && (
              <div className="flex items-center justify-between pt-2 border-t border-border/50">
                <span className="font-medium">Gesamt</span>
                <span className="font-medium">
                  {(appointment.travelKilometers || 0) + (appointment.customerKilometers || 0)} km
                </span>
              </div>
            )}
          </div>
        </SectionCard>
      )}


      {appointment.notes && (
        <SectionCard title="Notizen" className="mb-4">
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {appointment.notes}
          </p>
        </SectionCard>
      )}

      {appointment.status !== "completed" && (
        <div className="mt-6">
          <Button 
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={() => setLocation(`/document-appointment/${appointment.id}`)}
            data-testid="button-document"
          >
            <FileText className={`${iconSize.sm} mr-2`} />
            Jetzt dokumentieren
          </Button>
        </div>
      )}

      {canModify && (
        <div className="flex gap-3 mt-6">
          <Button 
            variant="outline" 
            className="flex-1"
            onClick={() => setLocation(`/edit-appointment/${appointment.id}`)}
            data-testid="button-edit"
          >
            <Pencil className={`${iconSize.sm} mr-2`} />
            Bearbeiten
          </Button>
          <Button 
            variant="outline" 
            className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
            data-testid="button-delete"
          >
            <Trash2 className={`${iconSize.sm} mr-2`} />
            Löschen
          </Button>
        </div>
      )}


      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className={`${iconSize.md} text-destructive`} />
              Termin löschen?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Möchten Sie den Termin bei {appointment.customer?.name} wirklich löschen? 
              Diese Aktion kann nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showDeclineDialog} onOpenChange={(v) => { if (!v) { setShowDeclineDialog(false); setDeclineNote(""); } }}>
        <AlertDialogContent className="fixed inset-0 flex items-center justify-center">
          <div className="bg-background rounded-lg p-6 max-w-md w-full mx-4 shadow-lg border">
            <AlertDialogHeader>
              <AlertDialogTitle>Kein Interesse bestätigen?</AlertDialogTitle>
              <AlertDialogDescription>
                Der Erstberatungskunde wird als „Kein Interesse" markiert und aus der aktiven Kundenliste entfernt.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="mt-3">
              <Label>Grund / Kommentar</Label>
              <Textarea
                value={declineNote}
                onChange={(e) => setDeclineNote(e.target.value)}
                placeholder="z.B. Preisvorstellungen zu hoch, anderer Anbieter gewählt..."
                className="min-h-[60px]"
                data-testid="input-decline-note"
              />
            </div>
            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel onClick={() => { setShowDeclineDialog(false); setDeclineNote(""); }} data-testid="button-cancel-decline">
                Abbrechen
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => appointment?.customerId && declineMutation.mutate({ customerId: appointment.customerId, note: declineNote })}
                className="bg-red-600 hover:bg-red-700"
                disabled={declineMutation.isPending}
                data-testid="button-confirm-decline"
              >
                {declineMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Kein Interesse bestätigen
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
