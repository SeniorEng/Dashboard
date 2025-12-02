import { memo, useState, useCallback, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { MapPin, CheckCircle2, Clock, FileText, Pencil, Trash2 } from "lucide-react";
import { Link } from "wouter";
import type { AppointmentWithCustomer } from "@shared/types";
import { formatTimeSlot, getEndTime } from "../utils";
import { useDeleteAppointment } from "../hooks";
import { useToast } from "@/hooks/use-toast";

interface AppointmentCardProps {
  appointment: AppointmentWithCustomer;
}

function getTypeColor(appointmentType: string, serviceType: string | null): string {
  if (appointmentType === "Erstberatung") {
    return "bg-purple-500";
  }
  if (serviceType === "Hauswirtschaft") {
    return "bg-amber-500";
  }
  if (serviceType === "Alltagsbegleitung") {
    return "bg-sky-500";
  }
  return "bg-teal-500";
}

function getStatusIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-5 h-5 text-green-500" />;
    case "in-progress":
      return <Clock className="w-5 h-5 text-blue-500 animate-pulse" />;
    case "documenting":
      return <FileText className="w-5 h-5 text-orange-500" />;
    default:
      return null;
  }
}

function AppointmentCardComponent({ appointment }: AppointmentCardProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [swiped, setSwiped] = useState(false);
  const startX = useRef(0);
  const deleteMutation = useDeleteAppointment();
  const { toast } = useToast();
  
  const isCompleted = appointment.status === "completed";
  const canModify = !isCompleted;
  const typeColor = getTypeColor(appointment.appointmentType, appointment.serviceType);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!canModify) return;
    startX.current = e.touches[0].clientX;
  }, [canModify]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!canModify) return;
    const endX = e.changedTouches[0].clientX;
    const diff = startX.current - endX;
    if (diff > 50) {
      setSwiped(true);
    } else if (diff < -50) {
      setSwiped(false);
    }
  }, [canModify]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowDeleteDialog(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    try {
      await deleteMutation.mutateAsync(appointment.id);
      toast({
        title: "Termin gelöscht",
        description: "Der Termin wurde erfolgreich gelöscht.",
      });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Fehler",
        description: error.message || "Der Termin konnte nicht gelöscht werden.",
      });
    }
    setShowDeleteDialog(false);
  }, [deleteMutation, appointment.id, toast]);

  const handleCloseSwipe = useCallback(() => {
    setSwiped(false);
  }, []);

  return (
    <>
      <div 
        className="relative overflow-hidden rounded-xl"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Swipe Actions Background */}
        {canModify && (
          <div className="absolute inset-y-0 right-0 flex items-stretch">
            <Link href={`/edit-appointment/${appointment.id}`}>
              <button 
                className="h-full w-16 bg-primary flex items-center justify-center text-primary-foreground"
                data-testid={`button-edit-${appointment.id}`}
              >
                <Pencil className="w-5 h-5" />
              </button>
            </Link>
            <button 
              className="h-full w-16 bg-destructive flex items-center justify-center text-destructive-foreground"
              onClick={handleDeleteClick}
              data-testid={`button-delete-${appointment.id}`}
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Main Card */}
        <Card 
          className={`relative transition-transform duration-200 ease-out border-0 shadow-sm ${
            swiped ? "-translate-x-32" : "translate-x-0"
          }`}
          onClick={swiped ? handleCloseSwipe : undefined}
        >
          <Link 
            href={`/appointment/${appointment.id}`}
            className="block"
            data-testid={`card-appointment-${appointment.id}`}
          >
            <div className="flex items-stretch">
              {/* Color-coded Left Border */}
              <div className={`w-1.5 ${typeColor} rounded-l-xl`} />

              {/* Time */}
              <div className="w-20 flex flex-col items-center justify-center py-4 px-2 text-center border-r border-border/30">
                <span className="text-lg font-bold text-foreground leading-none">
                  {formatTimeSlot(appointment.scheduledStart)}
                </span>
                <span className="text-[10px] text-muted-foreground mt-0.5">bis</span>
                <span className="text-sm font-medium text-muted-foreground leading-none">
                  {getEndTime(appointment)}
                </span>
              </div>

              {/* Content */}
              <div className="flex-1 py-3 px-4 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-foreground truncate">
                      {appointment.customer?.name}
                    </h3>
                    <div className="flex items-center text-xs text-muted-foreground mt-1">
                      <MapPin className="w-3 h-3 mr-1 shrink-0" />
                      <span className="truncate">{appointment.customer?.address}</span>
                    </div>
                  </div>
                  
                  {/* Status Icon */}
                  <div className="shrink-0">
                    {getStatusIcon(appointment.status)}
                  </div>
                </div>

                {/* Subtle Type Indicator */}
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {appointment.appointmentType}
                  {appointment.serviceType && ` · ${appointment.serviceType}`}
                </div>
              </div>
            </div>
          </Link>
        </Card>

        {/* Swipe Hint for Desktop */}
        {canModify && !swiped && (
          <div className="absolute inset-y-0 right-0 w-1 bg-gradient-to-l from-muted/50 to-transparent pointer-events-none" />
        )}
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Termin löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Möchten Sie den Termin bei {appointment.customer?.name} wirklich löschen? 
              Diese Aktion kann nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export const AppointmentCard = memo(AppointmentCardComponent);
