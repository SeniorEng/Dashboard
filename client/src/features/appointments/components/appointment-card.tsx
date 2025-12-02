import { memo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MapPin, ChevronRight, CheckCircle2, PlayCircle, FileText } from "lucide-react";
import { Link } from "wouter";
import type { AppointmentWithCustomer } from "@shared/types";
import { getStatusColor, getAppointmentTypeColor, getServiceColor, getStatusLabel } from "../utils";

interface AppointmentCardProps {
  appointment: AppointmentWithCustomer;
}

function AppointmentCardComponent({ appointment }: AppointmentCardProps) {
  const statusColor = getStatusColor(appointment.status);
  const typeColor = getAppointmentTypeColor(appointment.appointmentType);
  const serviceColor = getServiceColor(appointment.serviceType);
  const statusLabel = getStatusLabel(appointment.status);

  return (
    <Link 
      href={`/appointment/${appointment.id}`} 
      className="block group transition-all duration-200 hover:-translate-y-1"
      data-testid={`card-appointment-${appointment.id}`}
    >
      <Card className="overflow-hidden border-border/60 shadow-sm hover:shadow-md hover:border-primary/30 transition-all bg-card">
        <CardContent className="p-0">
          <div className="flex items-stretch">
            {/* Time Column */}
            <div className="w-20 flex flex-col items-center justify-center bg-secondary/30 border-r border-border/50 p-3 text-center">
              <span className="text-lg font-bold text-foreground">{appointment.scheduledStart}</span>
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Uhr</span>
            </div>

            {/* Main Content */}
            <div className="flex-1 p-4">
              <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Primary badge: Appointment Type */}
                  <Badge 
                    variant="outline" 
                    className={`rounded-full text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 ${typeColor}`}
                  >
                    {appointment.appointmentType}
                  </Badge>
                  {/* Secondary badge: Service Type (only for Kundentermin) */}
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
            </div>
            
            {/* Action Arrow */}
            <div className="w-10 flex items-center justify-center text-muted-foreground/30 group-hover:text-primary transition-colors">
              <ChevronRight className="w-6 h-6" />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export const AppointmentCard = memo(AppointmentCardComponent);
