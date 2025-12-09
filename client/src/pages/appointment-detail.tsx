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
  Pencil, Trash2, CheckCircle2, AlertTriangle, Phone, Car, Home, ArrowRight, Minus, Plus
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

  const hasHauswirtschaft = !!appointment.hauswirtschaftDauer;
  const hasAlltagsbegleitung = !!appointment.alltagsbegleitungDauer;
  const hasErstberatung = !!appointment.erstberatungDauer;

  const hasDocumentedHauswirtschaft = !!appointment.hauswirtschaftActualDauer;
  const hasDocumentedAlltagsbegleitung = !!appointment.alltagsbegleitungActualDauer;
  const hasDocumentedErstberatung = !!appointment.erstberatungActualDauer;
  const hasAnyDocumentedService = hasDocumentedHauswirtschaft || hasDocumentedAlltagsbegleitung || hasDocumentedErstberatung;
  const isCompleted = appointment.status === "completed";

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
          title="Geplant"
          icon={<Clock className={iconSize.sm} />}
          className="mb-4"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-border/50">
              <span className="text-muted-foreground">Zeitfenster</span>
              <span className="font-medium">
                {formatTimeSlot(appointment.scheduledStart)} - {getEndTime(appointment)} Uhr
              </span>
            </div>
            {hasHauswirtschaft && (
              <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${getServiceColors('hauswirtschaft').bg}`} />
                  <span>Hauswirtschaft</span>
                  {isCompleted && !hasDocumentedHauswirtschaft && (
                    <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Entfernt</span>
                  )}
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
                  {isCompleted && !hasDocumentedAlltagsbegleitung && (
                    <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Entfernt</span>
                  )}
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
            <div className="flex items-center justify-between py-2 pt-2 border-t border-border">
              <span className="font-medium">Gesamt geplant</span>
              <span className="font-medium">
                {formatDuration(appointment.durationPromised || 0)}
              </span>
            </div>
          </div>
        </SectionCard>
      )}

      {isCompleted && hasAnyDocumentedService && (
        <SectionCard
          title="Dokumentiert"
          icon={<CheckCircle2 className={iconSize.sm} />}
          className="mb-4"
        >
          <div className="space-y-4">
            {hasDocumentedHauswirtschaft && (
              <div className="py-2 border-b border-border/50">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${getServiceColors('hauswirtschaft').bg}`} />
                    <span className="font-medium">Hauswirtschaft</span>
                    {!hasHauswirtschaft && (
                      <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded flex items-center gap-0.5">
                        <Plus className={iconSize.xs} /> Neu
                      </span>
                    )}
                    {hasHauswirtschaft && appointment.hauswirtschaftDauer !== appointment.hauswirtschaftActualDauer && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        appointment.hauswirtschaftActualDauer! > appointment.hauswirtschaftDauer! 
                          ? "bg-blue-100 text-blue-700" 
                          : "bg-amber-100 text-amber-700"
                      }`}>
                        {appointment.hauswirtschaftActualDauer! > appointment.hauswirtschaftDauer! ? "+" : ""}
                        {appointment.hauswirtschaftActualDauer! - appointment.hauswirtschaftDauer!} Min.
                      </span>
                    )}
                  </div>
                  <span className="font-medium text-primary">
                    {formatDuration(appointment.hauswirtschaftActualDauer!)}
                  </span>
                </div>
                {appointment.hauswirtschaftDetails && (
                  <p className="text-sm text-muted-foreground mt-1 ml-4">
                    {appointment.hauswirtschaftDetails}
                  </p>
                )}
              </div>
            )}
            {hasDocumentedAlltagsbegleitung && (
              <div className="py-2 border-b border-border/50">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${getServiceColors('alltagsbegleitung').bg}`} />
                    <span className="font-medium">Alltagsbegleitung</span>
                    {!hasAlltagsbegleitung && (
                      <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded flex items-center gap-0.5">
                        <Plus className={iconSize.xs} /> Neu
                      </span>
                    )}
                    {hasAlltagsbegleitung && appointment.alltagsbegleitungDauer !== appointment.alltagsbegleitungActualDauer && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        appointment.alltagsbegleitungActualDauer! > appointment.alltagsbegleitungDauer! 
                          ? "bg-blue-100 text-blue-700" 
                          : "bg-amber-100 text-amber-700"
                      }`}>
                        {appointment.alltagsbegleitungActualDauer! > appointment.alltagsbegleitungDauer! ? "+" : ""}
                        {appointment.alltagsbegleitungActualDauer! - appointment.alltagsbegleitungDauer!} Min.
                      </span>
                    )}
                  </div>
                  <span className="font-medium text-primary">
                    {formatDuration(appointment.alltagsbegleitungActualDauer!)}
                  </span>
                </div>
                {appointment.alltagsbegleitungDetails && (
                  <p className="text-sm text-muted-foreground mt-1 ml-4">
                    {appointment.alltagsbegleitungDetails}
                  </p>
                )}
              </div>
            )}
            {hasDocumentedErstberatung && (
              <div className="py-2 border-b border-border/50">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${getServiceColors('erstberatung').bg}`} />
                    <span className="font-medium">Erstberatung</span>
                    {hasErstberatung && appointment.erstberatungDauer !== appointment.erstberatungActualDauer && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        appointment.erstberatungActualDauer! > appointment.erstberatungDauer! 
                          ? "bg-blue-100 text-blue-700" 
                          : "bg-amber-100 text-amber-700"
                      }`}>
                        {appointment.erstberatungActualDauer! > appointment.erstberatungDauer! ? "+" : ""}
                        {appointment.erstberatungActualDauer! - appointment.erstberatungDauer!} Min.
                      </span>
                    )}
                  </div>
                  <span className="font-medium text-primary">
                    {formatDuration(appointment.erstberatungActualDauer!)}
                  </span>
                </div>
                {appointment.erstberatungDetails && (
                  <p className="text-sm text-muted-foreground mt-1 ml-4">
                    {appointment.erstberatungDetails}
                  </p>
                )}
              </div>
            )}
            
            <div className="py-2 pt-3 border-t border-border">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium">Gesamt dokumentiert</span>
                <span className="font-medium text-primary">
                  {formatDuration(
                    (appointment.hauswirtschaftActualDauer || 0) + 
                    (appointment.alltagsbegleitungActualDauer || 0) + 
                    (appointment.erstberatungActualDauer || 0)
                  )}
                </span>
              </div>
              
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
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
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Car className={`${iconSize.xs} text-muted-foreground`} />
                    <span className="text-muted-foreground">Anfahrt</span>
                  </div>
                  <span>{appointment.travelKilometers || 0} km</span>
                </div>
                
                {appointment.customerKilometers && appointment.customerKilometers > 0 && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Car className={`${iconSize.xs} text-muted-foreground`} />
                      <span className="text-muted-foreground">Km für/mit Kunde</span>
                    </div>
                    <span>{appointment.customerKilometers} km</span>
                  </div>
                )}
                
                <div className="flex items-center justify-between pt-2 border-t border-border/50">
                  <span className="font-medium">Gesamt Kilometer</span>
                  <span className="font-medium">
                    {(appointment.travelKilometers || 0) + (appointment.customerKilometers || 0)} km
                  </span>
                </div>
              </div>
            </div>
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
