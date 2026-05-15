import { SectionCard } from "@/components/patterns/section-card";
import { iconSize } from "@/design-system";
import { ArrowRight, Car, Home } from "lucide-react";
import { formatKm } from "@/lib/utils";

interface Props {
  appointment: any;
}

export function AppointmentTravelCard({ appointment }: Props) {
  return (
    <SectionCard title="Fahrt" icon={<Car className={iconSize.sm} />} className="mb-4">
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between py-1">
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

        <div className="flex items-center justify-between py-1">
          <div className="flex items-center gap-2">
            <Car className={`${iconSize.xs} text-muted-foreground`} />
            <span className="text-muted-foreground">Anfahrt</span>
          </div>
          <span>{formatKm(appointment.travelKilometers)} km</span>
        </div>

        {appointment.customerKilometers != null && appointment.customerKilometers > 0 && (
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <Car className={`${iconSize.xs} text-muted-foreground`} />
              <span className="text-muted-foreground">Km für/mit Kunde</span>
            </div>
            <span>{formatKm(appointment.customerKilometers)} km</span>
          </div>
        )}

        {((appointment.travelKilometers || 0) + (appointment.customerKilometers || 0)) > 0 && (
          <div className="flex items-center justify-between pt-2 border-t border-border/50">
            <span className="font-medium">Gesamt</span>
            <span className="font-medium">
              {formatKm((appointment.travelKilometers || 0) + (appointment.customerKilometers || 0))} km
            </span>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
