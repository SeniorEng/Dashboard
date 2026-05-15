import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointment } from "@/features/appointments";
import { useDeleteAppointment } from "@/features/appointments/hooks";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/patterns/status-badge";
import { SectionCard } from "@/components/patterns/section-card";
import { iconSize, componentStyles } from "@/design-system";
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
  FileText, ChevronLeft, Loader2,
  Pencil, Trash2, AlertTriangle, RotateCcw, Copy, Repeat, ArrowRight,
} from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useAppointmentSeriesDetail, formatSeriesInfo } from "@/features/appointments/hooks/use-appointment-series";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useAppointmentPolicy } from "@/features/appointments/use-appointment-policy";
import {
  AppointmentDocumentationDiagnosis,
  AppointmentTimeServicesCard,
  AppointmentTravelCard,
  AppointmentServiceRecordCard,
  AppointmentSeriesDeleteDialog,
  AppointmentCustomerHeader,
} from "@/features/appointments/components";

type AppointmentService = {
  id: number;
  serviceId: number;
  serviceName: string;
  serviceCode: string;
  serviceUnitType: string;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  details: string | null;
};

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
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

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

  // Hook MUSS vor den frühen Returns weiter unten stehen (React-Rules-of-Hooks):
  // bei isLoading→appointment-Wechsel würde sich sonst die Hook-Anzahl ändern.
  const policy = useAppointmentPolicy(user, appointment);

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

  const { data: appointmentServices } = useQuery<AppointmentService[]>({
    queryKey: [`/api/appointments/${id}/services`],
    queryFn: async () => {
      const result = await api.get<AppointmentService[]>(`/appointments/${id}/services`);
      return unwrapResult(result);
    },
    enabled: !!id && !!appointment,
  });

  const deleteMutation = useDeleteAppointment();

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
  }, [deleteMutation, id, toast, setLocation, appointment?.date]);

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

  // Berechtigungen kommen aus shared/policies/appointments — identisch zum Backend.
  // Per-Action-Gating: jede Schaltfläche prüft ihre eigene Policy-Entscheidung,
  // damit z. B. ein Teamleiter, der editieren aber nicht löschen darf, den
  // Bearbeiten-Button trotzdem sieht. `policy` wurde oben (vor den frühen
  // Returns) berechnet, um Rules-of-Hooks einzuhalten.
  const canEdit = policy?.edit.allowed ?? false;
  const canDelete = policy?.delete.allowed ?? false;
  const canDocument = policy?.document.allowed ?? false;
  const canReopen = policy?.reopen.allowed ?? false;
  const isErstberatung = appointment.appointmentType === "Erstberatung";

  const services = appointmentServices || [];
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

        <AppointmentCustomerHeader
          appointment={appointment}
          isAdmin={!!user?.isAdmin}
          isErstberatung={isErstberatung}
          canConvert={!!canConvert}
        />
      </div>

      {seriesId && seriesDetail && (
        <div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg" data-testid="banner-series-info">
          <div className="flex items-center gap-2">
            <Repeat className={`${iconSize.sm} text-primary`} />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-primary">Teil einer Serie</span>
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

      <AppointmentTimeServicesCard
        appointment={appointment}
        services={services}
        isCompleted={isCompleted}
        isErstberatung={isErstberatung}
      />

      {isCompleted && <AppointmentTravelCard appointment={appointment} />}

      {user?.isAdmin && (() => {
        const isPastScheduled =
          appointment.status === "scheduled" &&
          appointment.date < new Date().toISOString().slice(0, 10);
        const showDiagnose =
          appointment.status === "documenting" ||
          appointment.status === "expired_unsigned" ||
          isPastScheduled;
        return showDiagnose ? (
          <AppointmentDocumentationDiagnosis appointmentId={appointment.id} />
        ) : null;
      })()}

      {appointment.notes && (
        <SectionCard title="Notizen" className="mb-4">
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {appointment.notes}
          </p>
        </SectionCard>
      )}

      {isCompleted && !isLoadingServiceRecord && (
        <AppointmentServiceRecordCard
          existingServiceRecord={existingServiceRecord}
          onCreate={() =>
            appointment.customerId &&
            createServiceRecordMutation.mutate({
              customerId: appointment.customerId,
              appointmentId: appointment.id,
            })
          }
          isCreating={createServiceRecordMutation.isPending}
        />
      )}

      {canDocument && (
        <div className="mt-6">
          <Button
            className={`w-full ${componentStyles.btnPrimary}`}
            size="lg"
            onClick={() => setLocation(`/document-appointment/${appointment.id}`)}
            data-testid="button-document"
            title={policy?.document.allowed ? undefined : policy?.document.reason}
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

      {isCompleted && canReopen && (
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

      {(canEdit || canDelete) && (
        <div className="flex gap-3 mt-6">
          {canEdit && (
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setLocation(`/edit-appointment/${appointment.id}`)}
              data-testid="button-edit"
              title={policy?.edit.reason}
            >
              <Pencil className={`${iconSize.sm} mr-2`} />
              Bearbeiten
            </Button>
          )}
          {canDelete && (
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
              title={policy?.delete.reason}
            >
              <Trash2 className={`${iconSize.sm} mr-2`} />
              Löschen
            </Button>
          )}
        </div>
      )}

      {isCompleted && canDelete && (
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

      <AppointmentSeriesDeleteDialog
        open={showSeriesDeleteDialog}
        onOpenChange={setShowSeriesDeleteDialog}
        isCompleted={appointment?.status === "completed"}
        isPending={seriesCancelMutation.isPending}
        onChoose={(mode) => seriesCancelMutation.mutate({ mode })}
      />
    </Layout>
  );
}
