import { SectionCard } from "@/components/patterns/section-card";
import { iconSize, getServiceColors } from "@/design-system";
import { Calendar, Car, Users } from "lucide-react";
import { formatTimeSlot, getEndTime } from "@/features/appointments/utils";
import { formatDuration } from "@shared/types";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { computeNoShowWage } from "@shared/domain/no-show-wage";
import { formatKm } from "@/lib/utils";

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

interface Props {
  appointment: any;
  services: AppointmentService[];
  isCompleted: boolean;
  isErstberatung: boolean;
  isAdmin?: boolean;
}

export function AppointmentTimeServicesCard({ appointment, services, isCompleted, isErstberatung, isAdmin }: Props) {
  const hasAnyService = services.length > 0;
  const hasAnyDocumentedService = services.some(
    (s) => s.actualDurationMinutes !== null && s.actualDurationMinutes > 0,
  );

  // Task #167 — Leerfahrt (customer_no_show): keine Leistungsstunden, sondern
  // bezahlte Zeit = origin-gated Fahrtzeit + gedeckelte Wartezeit + Anfahrt-km
  // (SSoT computeNoShowWage). NICHT die geplante Dauer als "Gesamt" anzeigen.
  const isNoShow = appointment.status === "customer_no_show";
  const noShowWage = isNoShow
    ? computeNoShowWage({
        travelOriginType: appointment.travelOriginType,
        travelMinutes: appointment.travelMinutes,
        noShowWaitMinutes: appointment.noShowWaitMinutes,
        noShowKilometers: appointment.noShowKilometers,
      })
    : null;

  return (
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
              year: "numeric",
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

        {isAdmin && appointment.coVisitGroupId && (
          <div className="flex items-center justify-between py-2 border-b border-border/50" data-testid="row-co-visit">
            <span className="text-muted-foreground">Einsatz</span>
            <span className="flex items-center gap-1.5 font-medium text-teal-700">
              <Users className="h-3.5 w-3.5" />
              Zwei-Kräfte-Einsatz
            </span>
          </div>
        )}

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
                <span>{[appointment.doctorStrasse, appointment.doctorNr].filter(Boolean).join(" ")}, {appointment.doctorPlz} {appointment.doctorStadt}</span>
              </div>
            )}
          </div>
        )}

        {isNoShow && noShowWage && (
          <div className="py-2 border-t border-border" data-testid="section-no-show-leerfahrt">
            <div className="flex items-center gap-2 mb-2 text-amber-700">
              <Car className={iconSize.sm} />
              <span className="font-medium">Leerfahrt (Kunde nicht angetroffen)</span>
            </div>
            <div className="flex items-center justify-between py-1 text-sm">
              <span className="text-muted-foreground">Fahrtzeit</span>
              <span className="font-medium" data-testid="text-no-show-travel-minutes">{formatDuration(noShowWage.travelMinutes)}</span>
            </div>
            <div className="flex items-center justify-between py-1 text-sm">
              <span className="text-muted-foreground">Wartezeit</span>
              <span className="font-medium" data-testid="text-no-show-wait-minutes">{formatDuration(noShowWage.waitMinutes)}</span>
            </div>
            <div className="flex items-center justify-between py-1 text-sm">
              <span className="text-muted-foreground">Anfahrt-km</span>
              <span className="font-medium" data-testid="text-no-show-km">{formatKm(noShowWage.kilometers)} km</span>
            </div>
            <div className="flex items-center justify-between py-2 pt-2 border-t border-border">
              <span className="font-medium">Bezahlte Zeit</span>
              <span className="font-semibold text-amber-700" data-testid="text-no-show-paid-minutes">{formatDuration(noShowWage.paidMinutes)}</span>
            </div>
          </div>
        )}

        {!isNoShow && (hasAnyService || (isCompleted && hasAnyDocumentedService)) && (
          <>
            {isCompleted && hasAnyDocumentedService && (
              <div className="hidden sm:flex items-center justify-between pt-2 pb-1">
                <span className="flex-1" />
                <span className="w-24 text-right text-xs text-muted-foreground uppercase tracking-wide whitespace-nowrap">Geplant</span>
                <span className="w-24 text-right text-xs font-semibold text-primary uppercase tracking-wide whitespace-nowrap">Ist</span>
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
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${getServiceColors(serviceColorKey).bg}`} />
                      <span className="truncate">{service.serviceName}</span>
                    </div>
                    {isCompleted && hasDocumented ? (
                      <div className="flex items-center justify-end gap-3 pl-4 sm:pl-0 sm:gap-1">
                        <span className="text-sm text-muted-foreground whitespace-nowrap sm:w-24 sm:text-right" data-testid={`text-service-planned-${service.id}`}>
                          <span className="sm:hidden text-[10px] uppercase tracking-wide mr-1.5">Plan</span>
                          {plannedMins ? formatDuration(plannedMins) : "—"}
                        </span>
                        <span className={`font-semibold whitespace-nowrap sm:w-24 sm:text-right ${hasDifference ? "text-amber-600" : "text-primary"}`} data-testid={`text-service-actual-${service.id}`}>
                          <span className="sm:hidden text-[10px] text-muted-foreground uppercase tracking-wide mr-1.5">Ist</span>
                          {formatDuration(actualMins)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground pl-4 sm:pl-0 text-right whitespace-nowrap">
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
                <div className="flex flex-col gap-1 py-2 pt-2 border-t border-border sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <span className="font-medium">Gesamt</span>
                  {isCompleted && hasAnyDocumentedService ? (
                    <div className="flex items-center justify-end gap-3 sm:gap-1">
                      <span className="text-sm text-muted-foreground whitespace-nowrap sm:w-24 sm:text-right" data-testid="text-total-planned">
                        <span className="sm:hidden text-[10px] uppercase tracking-wide mr-1.5">Plan</span>
                        {formatDuration(totalPlanned)}
                      </span>
                      <span className={`font-semibold whitespace-nowrap sm:w-24 sm:text-right ${hasTotalDifference ? "text-amber-600" : "text-primary"}`} data-testid="text-total-actual">
                        <span className="sm:hidden text-[10px] text-muted-foreground uppercase tracking-wide mr-1.5">Ist</span>
                        {formatDuration(totalActual)}
                      </span>
                    </div>
                  ) : (
                    <span className="font-medium text-right whitespace-nowrap">
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
  );
}
