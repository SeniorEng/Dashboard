import { useState, useCallback } from "react";
import { formatKm } from "@/lib/utils";
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
  Pencil, Trash2, AlertTriangle, Phone, Car, Home, ArrowRight, UserPlus, RotateCcw, Copy, Repeat
} from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useAppointmentSeriesDetail, formatSeriesInfo } from "@/features/appointments/hooks/use-appointment-series";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
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

  const [showReopenDialog, setShowReopenDialog] = useState(false);
  const [showSeriesDeleteDialog, setShowSeriesDeleteDialog] = useState(false);

  const reopenMutation = useMutation({
    mutationFn: async () => {
      const result = await api.post(`/appointments/${id}/reopen`, {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments");
      toast({ title: "Dokumentation zur Korrektur geöffnet" });
      setShowReopenDialog(false);
      setLocation(`/document-appointment/${id}`);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
      setShowReopenDialog(false);
    },
  });
  
  const { data: appointment, isLoading } = useAppointment(id);

  const seriesId = appointment?.seriesId ?? undefined;
  const { data: seriesDetail } = useAppointmentSeriesDetail(seriesId ?? 0);

  const seriesCancelMutation = useMutation({
    mutationFn: async (data: { mode: "single" | "this_and_future" | "all_future" }) => {
      if (!seriesId) throw new Error("Kein Serien-ID");
      const result = await api.post(`/appointment-series/${seriesId}/appointments/${id}/cancel`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "appointments", "appointment-series");
      toast({ title: "Serientermine abgesagt" });
      setShowSeriesDeleteDialog(false);
      setLocation(appointment?.date ? `/?date=${appointment.date}` : "/");
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const { data: existingServiceRecord, isLoading: isLoadingServiceRecord } = useQuery<{
    id: number;
    status: string;
  } | null>({
    queryKey: [`/api/service-records/for-appointment/${id}`],
    queryFn: async () => {
      const result = await api.get<{ id: number; status: string } | null>(`/service-records/for-appointment/${id}`);
      return unwrapResult(result);
    },
    enabled: !!id && !!appointment && appointment.status === "completed",
  });

  const createServiceRecordMutation = useMutation({
    mutationFn: async ({ customerId, appointmentId }: { customerId: number; appointmentId: number }) => {
      const result = await api.post<{ id: number }>("/service-records/single", { customerId, appointmentId });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      invalidateRelated(queryClient, "service-records");
      toast({ title: "Leistungsnachweis erstellt" });
      setLocation(`/service-records/${data.id}`);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

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
        <div className="py-6 px-4 space-y-4" data-testid="loading-appointment">
          <div className="flex items-center gap-3">
            <div className="animate-pulse h-8 w-8 rounded bg-muted" />
            <div className="animate-pulse h-6 w-40 bg-muted rounded" />
          </div>
          <div className="animate-pulse h-40 w-full bg-muted rounded-xl" />
          <div className="animate-pulse h-24 w-full bg-muted rounded-xl" />
          <div className="animate-pulse h-32 w-full bg-muted rounded-xl" />
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
              {appointment.customerId ? (
                <Link
                  href={user?.isAdmin ? `/admin/customers/${appointment.customerId}` : `/customer/${appointment.customerId}`}
                  className="underline decoration-primary/30 underline-offset-4 hover:decoration-primary transition-colors"
                  data-testid="link-customer-detail"
                >
                  {appointment.customer.name}
                </Link>
              ) : appointment.prospectId && user?.isAdmin ? (
                <Link
                  href={`/admin/prospects/${appointment.prospectId}`}
                  className="underline decoration-primary/30 underline-offset-4 hover:decoration-primary transition-colors"
                  data-testid="link-prospect-detail"
                >
                  {appointment.customer.name}
                </Link>
              ) : (
                <span data-testid="text-prospect-name">{appointment.customer.name}</span>
              )}
            </h1>
            <div className="flex items-center text-muted-foreground text-sm mt-2">
              <MapPin className={`${iconSize.sm} mr-1.5 text-primary shrink-0`} />
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(appointment.customer.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary hover:underline"
                data-testid="link-customer-address"
              >
                {appointment.customer.address}
              </a>
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

        {isErstberatung && (appointment as any).prospectId && canConvert && (
          <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg" data-testid="card-prospect-link">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <UserPlus className={`${iconSize.sm} text-blue-600`} />
                <span className="text-sm font-medium text-blue-700">Verknüpft mit Interessent</span>
              </div>
              <Link href={`/admin/prospects?id=${(appointment as any).prospectId}`}>
                <Button size="sm" variant="outline" className="text-blue-700 border-blue-300" data-testid="button-view-prospect">
                  Zum Interessent
                  <ArrowRight className={`${iconSize.sm} ml-1`} />
                </Button>
              </Link>
            </div>
          </div>
        )}
      </div>

      {seriesId && seriesDetail && (
        <div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg" data-testid="banner-series-info">
          <div className="flex items-center gap-2">
            <Repeat className={`${iconSize.sm} text-primary`} />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-primary">
                Teil einer Serie
              </span>
              <span className="text-sm text-muted-foreground ml-2">
                {formatSeriesInfo(seriesDetail.series)}
              </span>
            </div>
            {user?.isAdmin && (
              <Link href={`/admin/appointment-series?id=${seriesId}`}>
                <Button variant="ghost" size="sm" className="text-xs text-primary h-7" data-testid="link-series-overview">
                  Zur Serie <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}

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
          
          {isCompleted && hasAnyDocumentedService && appointment.actualStart ? (
            <div className="py-2 border-b border-border/50">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Uhrzeit (geplant)</span>
                <span className="text-muted-foreground text-sm">
                  {formatTimeSlot(appointment.scheduledStart)} - {getEndTime(appointment)} Uhr
                </span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-muted-foreground">Uhrzeit (tatsächlich)</span>
                <span className="font-medium text-primary">
                  {formatTimeSlot(appointment.actualStart)}
                  {appointment.actualEnd ? ` - ${formatTimeSlot(appointment.actualEnd)} Uhr` : ""}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Uhrzeit</span>
              <span className="font-medium">
                {formatTimeSlot(appointment.scheduledStart)} - {getEndTime(appointment)} Uhr
              </span>
            </div>
          )}

          <div className="flex items-center justify-between py-2 border-b border-border/50">
            <span className="text-muted-foreground">Art</span>
            <span className="font-medium">
              {isErstberatung ? "Erstberatung" : appointment.isFahrtdienst ? (
                <span className="flex items-center gap-1.5">
                  <Car className="h-3.5 w-3.5 text-primary" />
                  Fahrtdienst
                </span>
              ) : "Kundentermin"}
            </span>
          </div>

          {appointment.isFahrtdienst && appointment.doctorAppointmentTime && (
            <div className="py-2 border-b border-border/50 space-y-1.5" data-testid="panel-fahrtdienst-detail">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm flex items-center gap-1">
                  <Car className="h-3.5 w-3.5" /> Abholzeit
                </span>
                <span className="font-medium text-primary">
                  {formatTimeSlot(appointment.scheduledStart)} Uhr
                </span>
              </div>
              {appointment.estimatedTravelMinutes != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Fahrtzeit</span>
                  <span>~{appointment.estimatedTravelMinutes} Min.</span>
                </div>
              )}
              {appointment.travelBufferMinutes != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Puffer</span>
                  <span>+{appointment.travelBufferMinutes} Min.</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">Arzt-Termin</span>
                <span className="font-medium">
                  {formatTimeSlot(appointment.doctorAppointmentTime)} Uhr
                </span>
              </div>
              {appointment.doctorName && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Arzt/Praxis</span>
                  <span>{appointment.doctorName}</span>
                </div>
              )}
              {appointment.doctorStrasse && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Adresse</span>
                  <span>{appointment.doctorStrasse}, {appointment.doctorPlz} {appointment.doctorStadt}</span>
                </div>
              )}
            </div>
          )}

          {(hasAnyService || (isCompleted && hasAnyDocumentedService)) && (
            <>
              {isCompleted && hasAnyDocumentedService && (
                <div className="flex items-center justify-between pt-2 pb-1">
                  <span className="flex-1" />
                  <span className="w-20 text-right text-xs text-muted-foreground uppercase tracking-wide">Geplant</span>
                  <span className="w-20 text-right text-xs font-semibold text-primary uppercase tracking-wide">Ist</span>
                </div>
              )}

              {services.map((service) => {
                const hasDocumented = service.actualDurationMinutes !== null && service.actualDurationMinutes > 0;
                const serviceColorKey = service.serviceCode as string;
                if (!service.plannedDurationMinutes && !(isCompleted && hasDocumented)) return null;

                const plannedMins = service.plannedDurationMinutes || 0;
                const actualMins = service.actualDurationMinutes || 0;
                const hasDifference = hasDocumented && plannedMins !== actualMins;
                
                return (
                  <div key={service.id} className="py-2 border-b border-border/50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${getServiceColors(serviceColorKey).bg}`} />
                        <span>{service.serviceName}</span>
                      </div>
                      {isCompleted && hasDocumented ? (
                        <div className="flex items-center gap-1">
                          <span className="w-20 text-right text-muted-foreground text-sm">
                            {plannedMins ? formatDuration(plannedMins) : "—"}
                          </span>
                          <span className={`w-20 text-right font-semibold ${hasDifference ? "text-amber-600" : "text-primary"}`}>
                            {formatDuration(actualMins)}
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

              {(() => {
                const totalPlanned = appointment.durationPromised || 0;
                const totalActual = services.reduce((sum, s) => sum + (s.actualDurationMinutes || 0), 0);
                const hasTotalDifference = isCompleted && hasAnyDocumentedService && totalPlanned !== totalActual;
                return (
                  <div className="flex items-center justify-between py-2 pt-2 border-t border-border">
                    <span className="font-medium">Gesamt</span>
                    {isCompleted && hasAnyDocumentedService ? (
                      <div className="flex items-center gap-1">
                        <span className="w-20 text-right text-muted-foreground text-sm">
                          {formatDuration(totalPlanned)}
                        </span>
                        <span className={`w-20 text-right font-semibold ${hasTotalDifference ? "text-amber-600" : "text-primary"}`}>
                          {formatDuration(totalActual)}
                        </span>
                      </div>
                    ) : (
                      <span className="font-medium">
                        {formatDuration(totalPlanned)}
                      </span>
                    )}
                  </div>
                );
              })()}
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
              <span>{formatKm(appointment.travelKilometers)} km</span>
            </div>
            
            {appointment.customerKilometers != null && appointment.customerKilometers > 0 && (
              <div className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                  <Car className={`${iconSize.xs} text-muted-foreground`} />
                  <span className="text-muted-foreground">Km für/mit Kunde</span>
                </div>
                <span>{formatKm(appointment.customerKilometers)} km</span>
              </div>
            )}
            
            {((appointment.travelKilometers || 0) + (appointment.customerKilometers || 0)) > 0 && (
              <div className="flex items-center justify-between pt-2 border-t border-border/50">
                <span className="font-medium">Gesamt</span>
                <span className="font-medium">
                  {formatKm((appointment.travelKilometers || 0) + (appointment.customerKilometers || 0))} km
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

      {isCompleted && !isLoadingServiceRecord && (
        <SectionCard
          title="Leistungsnachweis"
          icon={<FileText className={iconSize.sm} />}
          className="mb-4"
        >
          {existingServiceRecord ? (
            <div className="flex items-center justify-between">
              <StatusBadge
                type="record"
                value={existingServiceRecord.status}
                data-testid="badge-service-record-status"
              />
              <Link
                href={`/service-records/${existingServiceRecord.id}`}
                data-testid="link-service-record"
              >
                <Button variant="outline" size="sm">
                  {existingServiceRecord.status === "pending" ? "Leistungsnachweis unterschreiben" : "Leistungsnachweis anzeigen"}
                  <ArrowRight className={`${iconSize.sm} ml-1`} />
                </Button>
              </Link>
            </div>
          ) : (
            <Button
              className={`w-full ${componentStyles.btnPrimary}`}
              onClick={() => appointment.customerId && createServiceRecordMutation.mutate({ customerId: appointment.customerId, appointmentId: appointment.id })}
              disabled={createServiceRecordMutation.isPending}
              data-testid="button-create-service-record"
            >
              {createServiceRecordMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              <FileText className={`${iconSize.sm} mr-2`} />
              Leistungsnachweis erstellen
            </Button>
          )}
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

      {isCompleted && appointment.isLocked && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs text-amber-700" data-testid="text-locked-info">
            Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises und kann nicht mehr bearbeitet werden.
          </p>
        </div>
      )}

      {isCompleted && !appointment.isLocked && appointment.isMonthClosed && !user?.isAdmin && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-xs text-amber-700" data-testid="text-month-closed-info">
            Der Monat ist bereits abgeschlossen. Nur ein Admin kann die Dokumentation noch korrigieren.
          </p>
        </div>
      )}

      {isCompleted && !appointment.isLocked && (!appointment.isMonthClosed || user?.isAdmin) && (
        <div className="mt-6">
          <Button 
            variant="outline"
            className="w-full"
            size="lg"
            onClick={() => setShowReopenDialog(true)}
            data-testid="button-reopen"
          >
            <RotateCcw className={`${iconSize.sm} mr-2`} />
            Dokumentation korrigieren
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
            onClick={() => {
              if (seriesId) {
                setShowSeriesDeleteDialog(true);
              } else {
                setShowDeleteDialog(true);
              }
            }}
            data-testid="button-delete"
          >
            <Trash2 className={`${iconSize.sm} mr-2`} />
            Löschen
          </Button>
        </div>
      )}

      {isCompleted && user?.isAdmin && (
        <div className="mt-6">
          <Button
            variant="outline"
            className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
            data-testid="button-admin-delete"
          >
            <Trash2 className={`${iconSize.sm} mr-2`} />
            Termin löschen (Admin)
          </Button>
        </div>
      )}

      <div className="mt-4">
        <Button 
          variant="outline"
          className="w-full"
          onClick={() => setLocation(`/new-appointment?copyFrom=${appointment.id}`)}
          data-testid="button-copy-appointment"
        >
          <Copy className={`${iconSize.sm} mr-2`} />
          Termin kopieren
        </Button>
      </div>


      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className={`${iconSize.md} text-destructive`} />
              Termin löschen?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isCompleted && user?.isAdmin ? (
                <>
                  Möchten Sie den dokumentierten Termin bei <strong>{appointment.customer?.name}</strong> wirklich löschen?
                  Das verbrauchte Budget wird automatisch zurückgebucht.
                  {appointment.isLocked && " Der Termin ist Teil eines unterschriebenen Leistungsnachweises."}
                  {" "}Diese Aktion kann nicht rückgängig gemacht werden.
                </>
              ) : (
                <>
                  Möchten Sie den Termin bei {appointment.customer?.name} wirklich löschen?
                  Diese Aktion kann nicht rückgängig gemacht werden.
                </>
              )}
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

      <AlertDialog open={showReopenDialog} onOpenChange={setShowReopenDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className={`${iconSize.md} text-primary`} />
              Dokumentation korrigieren?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Die Dokumentation wird zur Korrektur geöffnet. Vorhandene Budget-Buchungen werden vorübergehend zurückgebucht und bei erneuter Dokumentation neu berechnet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => reopenMutation.mutate()}
              disabled={reopenMutation.isPending}
            >
              {reopenMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Zur Korrektur öffnen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showSeriesDeleteDialog} onOpenChange={setShowSeriesDeleteDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Repeat className={`${iconSize.md} text-destructive`} />
              Serientermin absagen
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                Dieser Termin gehört zu einer Serie. Welche Termine möchten Sie absagen?
                {appointment?.status === "completed" && (
                  <span className="block mt-2 text-amber-600 font-medium">
                    Dieser Termin ist bereits dokumentiert und kann nicht einzeln abgesagt werden. Sie können aber alle zukünftigen Termine der Serie absagen.
                  </span>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 py-2">
            <button
              onClick={() => {
                seriesCancelMutation.mutate({ mode: "single" });
              }}
              disabled={seriesCancelMutation.isPending || appointment?.status === "completed"}
              className="w-full p-4 rounded-lg border-2 text-left hover:border-destructive/50 hover:bg-destructive/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="button-series-delete-single"
            >
              <span className="font-semibold text-sm">Nur diesen Termin absagen</span>
              <span className="block text-xs text-muted-foreground mt-1">
                Alle anderen Serientermine bleiben bestehen
              </span>
            </button>
            <button
              onClick={() => {
                seriesCancelMutation.mutate({ mode: "this_and_future" });
              }}
              disabled={seriesCancelMutation.isPending}
              className="w-full p-4 rounded-lg border-2 text-left hover:border-destructive/50 hover:bg-destructive/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="button-series-delete-this-and-future"
            >
              <span className="font-semibold text-sm">Diesen und alle folgenden absagen</span>
              <span className="block text-xs text-muted-foreground mt-1">
                Ab diesem Termin werden alle zukünftigen Termine abgesagt
              </span>
            </button>
            <button
              onClick={() => {
                seriesCancelMutation.mutate({ mode: "all_future" });
              }}
              disabled={seriesCancelMutation.isPending}
              className="w-full p-4 rounded-lg border-2 text-left hover:border-destructive/50 hover:bg-destructive/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="button-series-delete-all-future"
            >
              <span className="font-semibold text-sm">Alle zukünftigen Termine absagen</span>
              <span className="block text-xs text-muted-foreground mt-1">
                Die gesamte Serie wird ab heute beendet
              </span>
            </button>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={seriesCancelMutation.isPending}>Abbrechen</AlertDialogCancel>
          </AlertDialogFooter>
          {seriesCancelMutation.isPending && (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </AlertDialogContent>
      </AlertDialog>

    </Layout>
  );
}
