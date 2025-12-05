import { useState, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointment } from "@/features/appointments";
import { useDeleteAppointment } from "@/features/appointments/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  MapPin, Clock, Calendar, FileText, ChevronLeft, Loader2, 
  Pencil, Trash2, CheckCircle2, AlertTriangle, Phone
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatTimeSlot, getEndTime } from "@/features/appointments/utils";
import { 
  formatDuration, 
  canModifyAppointment,
  type AppointmentStatus
} from "@shared/types";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { formatDateForDisplay } from "@shared/utils/date";

export default function AppointmentDetail() {
  const [, params] = useRoute("/appointment/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const id = params?.id ? parseInt(params.id) : 0;
  
  const { data: appointment, isLoading } = useAppointment(id);
  const deleteMutation = useDeleteAppointment();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleDelete = useCallback(async () => {
    try {
      await deleteMutation.mutateAsync(id);
      toast({
        title: "Termin gelöscht",
        description: "Der Termin wurde erfolgreich gelöscht.",
      });
      setLocation("/");
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Fehler",
        description: error.message || "Der Termin konnte nicht gelöscht werden.",
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

  const hasHauswirtschaft = !!appointment.hauswirtschaftDauer;
  const hasAlltagsbegleitung = !!appointment.alltagsbegleitungDauer;
  const hasErstberatung = !!appointment.erstberatungDauer;

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
          <ChevronLeft className={`${iconSize.sm} mr-1`} /> Zurück
        </Button>

        <div className="mb-4">
          <StatusBadge type="status" value={appointment.status} />
        </div>

        {appointment.customer && (
          <div className="mb-6">
            <h1 className="text-2xl font-bold leading-tight" data-testid="text-customer-name">
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
      </div>

      <SectionCard
        title="Termindetails"
        icon={<Calendar className={iconSize.sm} />}
        className="mb-4"
      >
        <div className="space-y-4">
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
            <span className="text-muted-foreground">Dauer</span>
            <span className="font-medium">
              {appointment.durationPromised ? formatDuration(appointment.durationPromised) : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between py-2">
            <span className="text-muted-foreground">Art</span>
            <span className="font-medium">
              {isErstberatung ? "Erstberatung" : "Kundentermin"}
            </span>
          </div>
        </div>
      </SectionCard>

      {(hasHauswirtschaft || hasAlltagsbegleitung || hasErstberatung) && (
        <SectionCard
          title="Geplante Leistungen"
          icon={<FileText className={iconSize.sm} />}
          className="mb-4"
        >
          <div className="space-y-3">
            {hasHauswirtschaft && (
              <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${getServiceColors('hauswirtschaft').bg}`} />
                  <span>Hauswirtschaft</span>
                </div>
                <span className="text-muted-foreground">
                  {formatDuration(appointment.hauswirtschaftDauer!)}
                </span>
              </div>
            )}
            {hasAlltagsbegleitung && (
              <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${getServiceColors('alltagsbegleitung').bg}`} />
                  <span>Alltagsbegleitung</span>
                </div>
                <span className="text-muted-foreground">
                  {formatDuration(appointment.alltagsbegleitungDauer!)}
                </span>
              </div>
            )}
            {hasErstberatung && (
              <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${getServiceColors('erstberatung').bg}`} />
                  <span>Erstberatung</span>
                </div>
                <span className="text-muted-foreground">
                  {formatDuration(appointment.erstberatungDauer!)}
                </span>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {appointment.customer?.needs && appointment.customer.needs.length > 0 && (
        <SectionCard title="Kundenbedürfnisse" className="mb-4">
          <ul className="space-y-2">
            {appointment.customer.needs.map((need, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <div className="w-1.5 h-1.5 rounded-full bg-primary/60" />
                {need}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {appointment.notes && (
        <SectionCard title="Notizen" className="mb-4">
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {appointment.notes}
          </p>
        </SectionCard>
      )}

      {appointment.status === "completed" && (
        <Card className="mb-4 border-green-200 bg-green-50/50">
          <CardContent className="py-4">
            <div className="flex items-center gap-3 text-green-800">
              <CheckCircle2 className={iconSize.md} />
              <div>
                <p className="font-medium">Termin abgeschlossen</p>
                {appointment.travelKilometers && (
                  <p className="text-sm text-green-700">Gefahrene Kilometer: {appointment.travelKilometers} km</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
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

      {!canModify && (
        <div className="mt-6">
          <Button 
            variant="outline" 
            className="w-full"
            onClick={() => setLocation("/")}
            data-testid="button-back-dashboard"
          >
            Zurück zur Übersicht
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
    </Layout>
  );
}
