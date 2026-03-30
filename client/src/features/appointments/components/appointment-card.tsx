import { memo, useCallback, useMemo } from "react";
import { format, parseISO } from "date-fns";
import { de } from "date-fns/locale";
import { Card } from "@/components/ui/card";
import { MapPin, CheckCircle2, Clock, FileText, Phone, Navigation, User, Repeat } from "lucide-react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import type { AppointmentWithCustomer } from "@shared/types";
import { useAuth } from "@/hooks/use-auth";
import { getCardServiceInfoFromAppointment } from "@shared/types";
import { api, unwrapResult } from "@/lib/api";
import { formatTimeSlot, getEndTime } from "../utils";

interface AppointmentCardProps {
  appointment: AppointmentWithCustomer;
  showDate?: boolean;
  isSubstitute?: boolean;
}

function getStatusIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "in-progress":
      return <Clock className="w-4 h-4 text-blue-500" />;
    case "documenting":
      return <FileText className="w-4 h-4 text-orange-500" />;
    default:
      return null;
  }
}

function AppointmentCardComponent({ appointment, showDate, isSubstitute }: AppointmentCardProps) {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const serviceInfo = useMemo(() => 
    getCardServiceInfoFromAppointment(appointment),
    [appointment.appointmentType, appointment.serviceType, appointment.durationPromised, appointment.status]
  );

  const handlePrefetch = useCallback(() => {
    queryClient.prefetchQuery({
      queryKey: ["appointments", appointment.id],
      queryFn: async () => {
        const result = await api.get<AppointmentWithCustomer>(`/appointments/${appointment.id}`);
        return unwrapResult(result);
      },
      staleTime: 30000,
    });
  }, [queryClient, appointment.id]);

  const handleCardClick = useCallback(() => {
    navigate(`/appointment/${appointment.id}`);
  }, [navigate, appointment.id]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigate(`/appointment/${appointment.id}`);
    }
  }, [navigate, appointment.id]);

  return (
    <div 
      className={`rounded-xl transition-opacity duration-200 ${
        isSubstitute ? "opacity-50 hover:opacity-75" :
        appointment.status === "completed" ? "opacity-60 hover:opacity-100" : ""
      }`}
      onMouseEnter={handlePrefetch}
      onFocus={handlePrefetch}
    >
      <Card 
        className={`shadow-sm cursor-pointer hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 overflow-hidden ${
          isSubstitute ? "border border-dashed border-border/50" : "border-0"
        }`}
        onClick={handleCardClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="link"
        data-testid={`card-appointment-${appointment.id}`}
      >
        <div className="flex items-stretch">
          {serviceInfo.hasBoth ? (
            <div className="w-1.5 flex flex-col overflow-hidden">
              <div className="flex-1 bg-amber-500" />
              <div className="flex-1 bg-sky-500" />
            </div>
          ) : (
            <div className={`w-1.5 ${serviceInfo.borderClass}`} />
          )}

          <div className="w-[4.5rem] flex flex-col items-center justify-center py-2.5 px-1.5 text-center border-r border-border/30">
            {appointment.status === "completed" && appointment.actualStart ? (
              <>
                <span className="text-sm font-bold text-primary leading-none">
                  {formatTimeSlot(appointment.actualStart)}
                </span>
                <span className="text-xs font-medium text-primary/70 leading-none mt-0.5">
                  – {appointment.actualEnd ? formatTimeSlot(appointment.actualEnd) : getEndTime(appointment)}
                </span>
              </>
            ) : (
              <>
                <span className="text-sm font-bold text-foreground leading-none">
                  {formatTimeSlot(appointment.scheduledStart)}
                </span>
                <span className="text-xs font-medium text-muted-foreground leading-none mt-0.5">
                  – {getEndTime(appointment)}
                </span>
              </>
            )}
          </div>

          <div className="flex-1 py-2.5 px-3 min-w-0">
            {showDate && (
              <div className="text-xs text-muted-foreground mb-0.5">
                {format(parseISO(appointment.date), "EEEE, d. MMM", { locale: de })}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <h3 className="font-semibold text-sm text-foreground truncate">
                {appointment.customer?.name}
              </h3>
              {appointment.seriesId && (
                <Repeat className="w-3 h-3 text-primary/60 shrink-0" data-testid={`icon-series-${appointment.id}`} />
              )}
              {getStatusIcon(appointment.status)}
            </div>
            <div className="flex items-center text-xs text-muted-foreground mt-0.5">
              <MapPin className="w-3 h-3 mr-1 shrink-0" />
              <span className="truncate">{appointment.customer?.address || "Keine Adresse"}</span>
            </div>
            {isSubstitute && appointment.assignedEmployeeName && (
              <div className="flex items-center text-xs text-muted-foreground mt-0.5" data-testid={`text-substitute-${appointment.id}`}>
                <User className="w-3 h-3 mr-1 shrink-0" />
                <span className="truncate">Vertretung: {appointment.assignedEmployeeName}</span>
              </div>
            )}
            {!isSubstitute && user?.isAdmin && appointment.assignedEmployeeName && (
              <div className="flex items-center text-xs text-muted-foreground mt-0.5" data-testid={`text-employee-${appointment.id}`}>
                <User className="w-3 h-3 mr-1 shrink-0" />
                <span className="truncate">{appointment.assignedEmployeeName}</span>
              </div>
            )}
            <div className="text-[11px] text-muted-foreground/70 mt-0.5">
              {serviceInfo.label}
            </div>
          </div>

          {!isSubstitute && (() => {
            const phoneNumber = appointment.customer?.telefon || appointment.customer?.festnetz;
            const hasPhone = !!phoneNumber;
            const hasAddress = !!appointment.customer?.address;
            if (!hasPhone && !hasAddress) return null;
            return (
              <div className="shrink-0 flex flex-col border-l border-border/30">
                {hasPhone && (
                  <a
                    href={`tel:${phoneNumber}`}
                    className={`flex-1 flex items-center justify-center px-3 bg-green-50 text-green-600 hover:bg-green-100 active:bg-green-200 transition-colors ${hasAddress ? "border-b border-border/30" : ""}`}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Anrufen"
                    data-testid={`button-call-${appointment.id}`}
                  >
                    <Phone className="w-4 h-4" />
                  </a>
                )}
                {hasAddress && (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(appointment.customer!.address!)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center px-3 bg-blue-50 text-blue-600 hover:bg-blue-100 active:bg-blue-200 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                    aria-label="In Google Maps öffnen"
                    data-testid={`button-maps-${appointment.id}`}
                  >
                    <Navigation className="w-4 h-4" />
                  </a>
                )}
              </div>
            );
          })()}
        </div>
      </Card>
    </div>
  );
}

export const AppointmentCard = memo(AppointmentCardComponent);
