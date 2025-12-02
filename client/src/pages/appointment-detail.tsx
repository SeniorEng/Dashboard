import { useState, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { useAppointment } from "@/features/appointments";
import { useDeleteAppointment } from "@/features/appointments/hooks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} Min.`;
  if (m === 0) return `${h} Std.`;
  return `${h} Std. ${m} Min.`;
}

function getStatusInfo(status: string): { label: string; color: string; icon: React.ReactNode } {
  switch (status) {
    case "completed":
      return { 
        label: "Abgeschlossen", 
        color: "bg-green-100 text-green-800 border-green-200",
        icon: <CheckCircle2 className="w-4 h-4" />
      };
    case "in-progress":
      return { 
        label: "Läuft", 
        color: "bg-blue-100 text-blue-800 border-blue-200",
        icon: <Clock className="w-4 h-4" />
      };
    case "documenting":
      return { 
        label: "Dokumentation", 
        color: "bg-orange-100 text-orange-800 border-orange-200",
        icon: <FileText className="w-4 h-4" />
      };
    default:
      return { 
        label: "Geplant", 
        color: "bg-gray-100 text-gray-800 border-gray-200",
        icon: <Calendar className="w-4 h-4" />
      };
  }
}

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

  const isCompleted = appointment.status === "completed";
  const canModify = !isCompleted;
  const statusInfo = getStatusInfo(appointment.status);
  const isErstberatung = appointment.appointmentType === "Erstberatung";

  const hasHauswirtschaft = !!appointment.hauswirtschaftDauer;
  const hasAlltagsbegleitung = !!appointment.alltagsbegleitungDauer;

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

        {/* Status Badge */}
        <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium border ${statusInfo.color} mb-4`}>
          {statusInfo.icon}
          {statusInfo.label}
        </div>

        {/* Customer Info */}
        {appointment.customer && (
          <div className="mb-6">
            <h1 className="text-2xl font-bold leading-tight" data-testid="text-customer-name">
              {appointment.customer.name}
            </h1>
            <div className="flex items-center text-muted-foreground text-sm mt-2">
              <MapPin className="w-4 h-4 mr-1.5 text-primary shrink-0" />
              <span>{appointment.customer.address}</span>
            </div>
            {appointment.customer.telefon && (
              <div className="flex items-center text-muted-foreground text-sm mt-1">
                <Phone className="w-4 h-4 mr-1.5 text-primary shrink-0" />
                <a href={`tel:${appointment.customer.telefon}`} className="hover:text-primary">
                  {appointment.customer.telefon}
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Appointment Details Card */}
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="w-4 h-4 text-primary" />
            Termindetails
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Date & Time */}
          <div className="flex items-center justify-between py-2 border-b border-border/50">
            <span className="text-muted-foreground">Datum</span>
            <span className="font-medium">
              {new Date(appointment.date).toLocaleDateString("de-DE", { 
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
        </CardContent>
      </Card>

      {/* Services Card - Only for Kundentermin */}
      {!isErstberatung && (hasHauswirtschaft || hasAlltagsbegleitung) && (
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              Geplante Leistungen
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {hasHauswirtschaft && (
              <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-amber-500" />
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
                  <div className="w-2 h-2 rounded-full bg-sky-500" />
                  <span>Alltagsbegleitung</span>
                </div>
                <span className="text-muted-foreground">
                  {formatDuration(appointment.alltagsbegleitungDauer!)}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Customer Needs - for Erstberatung or if customer has needs */}
      {appointment.customer?.needs && appointment.customer.needs.length > 0 && (
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Kundenbedürfnisse</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {appointment.customer.needs.map((need, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/60" />
                  {need}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Notes Card */}
      {appointment.notes && (
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Notizen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {appointment.notes}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Completed Info */}
      {isCompleted && (
        <Card className="mb-4 border-green-200 bg-green-50/50">
          <CardContent className="py-4">
            <div className="flex items-center gap-3 text-green-800">
              <CheckCircle2 className="w-5 h-5" />
              <div>
                <p className="font-medium">Termin abgeschlossen</p>
                {appointment.kilometers && (
                  <p className="text-sm text-green-700">Gefahrene Kilometer: {appointment.kilometers} km</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action Buttons */}
      {canModify && (
        <div className="flex gap-3 mt-6">
          <Button 
            variant="outline" 
            className="flex-1"
            onClick={() => setLocation(`/edit-appointment/${appointment.id}`)}
            data-testid="button-edit"
          >
            <Pencil className="w-4 h-4 mr-2" />
            Bearbeiten
          </Button>
          <Button 
            variant="outline" 
            className="flex-1 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
            data-testid="button-delete"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Löschen
          </Button>
        </div>
      )}

      {/* Completed - Back Button */}
      {isCompleted && (
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

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
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
