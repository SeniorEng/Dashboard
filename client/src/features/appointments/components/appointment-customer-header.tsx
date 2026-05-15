import { Link } from "wouter";
import { MapPin, Phone, UserPlus, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { iconSize, componentStyles } from "@/design-system";
import { formatPhoneForDisplay } from "@shared/utils/phone";

interface Props {
  appointment: any;
  isAdmin: boolean;
  isErstberatung: boolean;
  canConvert: boolean;
}

export function AppointmentCustomerHeader({ appointment, isAdmin, isErstberatung, canConvert }: Props) {
  if (!appointment.customer) return null;

  return (
    <>
      <div className="mb-6">
        <h1 className={componentStyles.pageTitle} data-testid="text-customer-name">
          {appointment.customerId ? (
            <Link
              href={isAdmin ? `/admin/customers/${appointment.customerId}` : `/customer/${appointment.customerId}`}
              className="underline decoration-primary/30 underline-offset-4 hover:decoration-primary transition-colors"
              data-testid="link-customer-detail"
            >
              {appointment.customer.name}
            </Link>
          ) : appointment.prospectId && isAdmin ? (
            <Link
              href={`/admin/prospects/${appointment.prospectId}`}
              className="underline decoration-primary/30 underline-offset-4 hover:decoration-primary transition-colors"
              data-testid="link-prospect-detail"
            >
              {appointment.customer.name}
            </Link>
          ) : (
            <span data-testid="text-prospect-name">{appointment.customer.name}</span>
          )}
        </h1>
        <div className="flex items-center text-muted-foreground text-sm mt-2">
          <MapPin className={`${iconSize.sm} mr-1.5 text-primary shrink-0`} />
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(appointment.customer.address)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary hover:underline"
            data-testid="link-customer-address"
          >
            {appointment.customer.address}
          </a>
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

      {isErstberatung && appointment.prospectId && canConvert && (
        <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg" data-testid="card-prospect-link">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <UserPlus className={`${iconSize.sm} text-blue-600`} />
              <span className="text-sm font-medium text-blue-700">Verknüpft mit Interessent</span>
            </div>
            <Link href={`/admin/prospects?id=${appointment.prospectId}`}>
              <Button size="sm" variant="outline" className="text-blue-700 border-blue-300" data-testid="button-view-prospect">
                Zum Interessent
                <ArrowRight className={`${iconSize.sm} ml-1`} />
              </Button>
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
