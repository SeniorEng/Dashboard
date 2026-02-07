import { memo, useState, useCallback, useRef, useMemo } from "react";
import { format, parseISO } from "date-fns";
import { de } from "date-fns/locale";
import { Card } from "@/components/ui/card";
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
import { MapPin, CheckCircle2, Clock, FileText, Pencil, Trash2, MoreVertical } from "lucide-react";
import { useLocation } from "wouter";
import type { AppointmentWithCustomer, AppointmentStatus } from "@shared/types";
import { getCardServiceInfo, canModifyAppointment } from "@shared/types";
import { formatTimeSlot, getEndTime } from "../utils";
import { useDeleteAppointment } from "../hooks";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface AppointmentCardProps {
  appointment: AppointmentWithCustomer;
  showDate?: boolean;
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

function AppointmentCardComponent({ appointment, showDate }: AppointmentCardProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [swiped, setSwiped] = useState(false);
  const startX = useRef(0);
  const deleteMutation = useDeleteAppointment();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  
  const canModify = canModifyAppointment(appointment.status as AppointmentStatus);
  const isCompleted = appointment.status === "completed";
  const serviceInfo = useMemo(() => 
    getCardServiceInfo(
      appointment.appointmentType,
      isCompleted ? (appointment.hauswirtschaftActualDauer ?? appointment.hauswirtschaftDauer) : appointment.hauswirtschaftDauer,
      isCompleted ? (appointment.alltagsbegleitungActualDauer ?? appointment.alltagsbegleitungDauer) : appointment.alltagsbegleitungDauer,
      isCompleted ? (appointment.erstberatungActualDauer ?? appointment.erstberatungDauer) : appointment.erstberatungDauer,
      appointment.serviceType
    ),
    [appointment.appointmentType, appointment.hauswirtschaftDauer, appointment.alltagsbegleitungDauer, appointment.erstberatungDauer, appointment.hauswirtschaftActualDauer, appointment.alltagsbegleitungActualDauer, appointment.erstberatungActualDauer, appointment.status, appointment.serviceType]
  );

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

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if (swiped) {
      e.preventDefault();
      e.stopPropagation();
      setSwiped(false);
      return;
    }
    navigate(`/appointment/${appointment.id}`);
  }, [swiped, navigate, appointment.id]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (swiped) {
        setSwiped(false);
      } else {
        navigate(`/appointment/${appointment.id}`);
      }
    }
  }, [swiped, navigate, appointment.id]);

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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Der Termin konnte nicht gelöscht werden.";
      toast({
        variant: "destructive",
        title: "Fehler",
        description: message,
      });
    }
    setShowDeleteDialog(false);
  }, [deleteMutation, appointment.id, toast]);

  const handleEditClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/edit-appointment/${appointment.id}`);
  }, [navigate, appointment.id]);

  return (
    <>
      <div 
        className="relative overflow-hidden rounded-xl group"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Swipe Actions Background (Mobile) */}
        {canModify && (
          <div className="absolute inset-y-0 right-0 flex items-stretch">
            <button 
              className="h-full w-16 bg-primary flex items-center justify-center text-primary-foreground"
              onClick={handleEditClick}
              data-testid={`button-edit-swipe-${appointment.id}`}
            >
              <Pencil className="w-5 h-5" />
            </button>
            <button 
              className="h-full w-16 bg-destructive flex items-center justify-center text-destructive-foreground"
              onClick={handleDeleteClick}
              data-testid={`button-delete-swipe-${appointment.id}`}
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Main Card */}
        <Card 
          className={`relative transition-transform duration-200 ease-out border-0 shadow-sm cursor-pointer hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
            swiped ? "-translate-x-32" : "translate-x-0"
          }`}
          onClick={handleCardClick}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          role="link"
          data-testid={`card-appointment-${appointment.id}`}
        >
          <div className="flex items-stretch">
            {/* Color-coded Left Border */}
            {serviceInfo.hasBoth ? (
              <div className="w-1.5 flex flex-col rounded-l-xl overflow-hidden">
                <div className="flex-1 bg-amber-500" />
                <div className="flex-1 bg-sky-500" />
              </div>
            ) : (
              <div className={`w-1.5 ${serviceInfo.borderClass} rounded-l-xl`} />
            )}

            {/* Time */}
            <div className="w-24 flex flex-col items-center justify-center py-4 px-2 text-center border-r border-border/30">
              <span className="text-base font-bold text-foreground leading-none">
                {formatTimeSlot(appointment.scheduledStart)}
              </span>
              <span className="text-sm font-medium text-muted-foreground leading-none mt-0.5">
                - {getEndTime(appointment)}
              </span>
            </div>

            {/* Content */}
            <div className="flex-1 py-3 px-4 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {showDate && (
                    <div className="text-xs text-muted-foreground mb-0.5">
                      {format(parseISO(appointment.date), "EEEE, d. MMM", { locale: de })}
                    </div>
                  )}
                  <h3 className="font-semibold text-foreground truncate">
                    {appointment.customer?.name}
                  </h3>
                  <div className="flex items-center text-xs text-muted-foreground mt-1">
                    <MapPin className="w-3 h-3 mr-1 shrink-0" />
                    <span className="truncate">{appointment.customer?.address}</span>
                  </div>
                </div>
                
                {/* Status Icon + Actions */}
                <div className="shrink-0 flex items-center gap-1">
                  {getStatusIcon(appointment.status)}
                  
                  {/* Desktop Actions Menu */}
                  {canModify && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button 
                            className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary transition-opacity"
                            data-testid={`button-menu-${appointment.id}`}
                          >
                            <MoreVertical className="w-4 h-4 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={handleEditClick} data-testid={`button-edit-${appointment.id}`}>
                            <Pencil className="w-4 h-4 mr-2" />
                            Bearbeiten
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={handleDeleteClick} 
                            className="text-destructive focus:text-destructive"
                            data-testid={`button-delete-${appointment.id}`}
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Löschen
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              </div>

              {/* Subtle Type Indicator */}
              <div className="mt-2 text-[11px] text-muted-foreground">
                {serviceInfo.label}
              </div>
            </div>
          </div>
        </Card>

        {/* Swipe Hint for Mobile */}
        {canModify && !swiped && (
          <div className="absolute inset-y-0 right-0 w-1 bg-gradient-to-l from-muted/50 to-transparent pointer-events-none md:hidden" />
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
