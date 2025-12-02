import { memo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { MapPin, ChevronRight, CheckCircle2, PlayCircle, FileText, Pencil, Trash2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import type { AppointmentWithCustomer } from "@shared/types";
import { getStatusColor, getAppointmentTypeColor, getServiceColor, getStatusLabel, formatTimeSlot, getEndTime } from "../utils";
import { useDeleteAppointment } from "../hooks";
import { useToast } from "@/hooks/use-toast";

interface AppointmentCardProps {
  appointment: AppointmentWithCustomer;
}

function AppointmentCardComponent({ appointment }: AppointmentCardProps) {
  const [, setLocation] = useLocation();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const deleteMutation = useDeleteAppointment();
  const { toast } = useToast();
  
  const statusColor = getStatusColor(appointment.status);
  const typeColor = getAppointmentTypeColor(appointment.appointmentType);
  const serviceColor = getServiceColor(appointment.serviceType);
  const statusLabel = getStatusLabel(appointment.status);
  
  const isCompleted = appointment.status === "completed";
  const canModify = !isCompleted;

  const handleEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLocation(`/edit-appointment/${appointment.id}`);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShowDeleteDialog(true);
  };

  const handleConfirmDelete = async () => {
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
  };

  return (
    <>
      <Link 
        href={`/appointment/${appointment.id}`} 
        className="block group transition-all duration-200 hover:-translate-y-1"
        data-testid={`card-appointment-${appointment.id}`}
      >
        <Card className="overflow-hidden border-border/60 shadow-sm hover:shadow-md hover:border-primary/30 transition-all bg-card">
          <CardContent className="p-0">
            <div className="flex items-stretch">
              {/* Time Column */}
              <div className="w-24 flex flex-col items-center justify-center bg-secondary/30 border-r border-border/50 p-3 text-center">
                <span className="text-base font-bold text-foreground">{formatTimeSlot(appointment.scheduledStart)}</span>
                <span className="text-xs text-muted-foreground">bis</span>
                <span className="text-base font-bold text-foreground">{getEndTime(appointment)}</span>
              </div>

              {/* Main Content */}
              <div className="flex-1 p-4">
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge 
                      variant="outline" 
                      className={`rounded-full text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 ${typeColor}`}
                    >
                      {appointment.appointmentType}
                    </Badge>
                    {appointment.serviceType && (
                      <Badge 
                        variant="outline" 
                        className={`rounded-full text-[10px] font-medium px-2 py-0.5 ${serviceColor}`}
                      >
                        {appointment.serviceType}
                      </Badge>
                    )}
                  </div>
                  <div className={`text-[10px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1 shrink-0 ${statusColor}`}>
                    {appointment.status === "completed" && <CheckCircle2 className="w-3 h-3" />}
                    {appointment.status === "in-progress" && <PlayCircle className="w-3 h-3" />}
                    {appointment.status === "documenting" && <FileText className="w-3 h-3" />}
                    {statusLabel}
                  </div>
                </div>

                {appointment.customer && (
                  <div className="mb-1">
                    <h3 className="font-bold text-foreground leading-tight">{appointment.customer.name}</h3>
                    <div className="flex items-center text-xs text-muted-foreground mt-1">
                      <MapPin className="w-3 h-3 mr-1" />
                      <span className="truncate max-w-[200px]">{appointment.customer.address}</span>
                    </div>
                  </div>
                )}

                {/* Action Buttons - Only for non-completed appointments */}
                {canModify && (
                  <div className="flex gap-2 mt-3 pt-2 border-t border-border/30">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 px-3 text-xs"
                      onClick={handleEdit}
                      data-testid={`button-edit-${appointment.id}`}
                    >
                      <Pencil className="w-3 h-3 mr-1" /> Bearbeiten
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-8 px-3 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={handleDeleteClick}
                      data-testid={`button-delete-${appointment.id}`}
                    >
                      <Trash2 className="w-3 h-3 mr-1" /> Löschen
                    </Button>
                  </div>
                )}
              </div>
              
              {/* Action Arrow */}
              <div className="w-10 flex items-center justify-center text-muted-foreground/30 group-hover:text-primary transition-colors">
                <ChevronRight className="w-6 h-6" />
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>

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
