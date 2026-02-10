import { Button } from "@/components/ui/button";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { formatAddress } from "@shared/utils/format";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { SectionCard } from "@/components/patterns/section-card";
import { iconSize } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import {
  User2,
  MapPin,
  Phone,
  Mail,
  Heart,
  Shield,
  Users,
  Calendar,
  CreditCard,
} from "lucide-react";
import type { CustomerDetail } from "@/lib/api/types";

interface CustomerOverviewTabProps {
  customer: CustomerDetail;
}

export function CustomerOverviewTab({ customer }: CustomerOverviewTabProps) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard
          title="Kontaktdaten"
          icon={<User2 className={iconSize.sm} />}
        >
          <div className="space-y-3">
            {customer.geburtsdatum && (
              <div className="flex items-center gap-2 text-gray-700">
                <Calendar className={`${iconSize.sm} text-gray-400`} />
                Geb.: {formatDateForDisplay(customer.geburtsdatum)}
              </div>
            )}
            <div className="flex items-center gap-2 text-gray-700">
              <MapPin className={`${iconSize.sm} text-gray-400`} />
              {formatAddress(customer)}
            </div>
            {(customer.telefon || customer.festnetz) && (
              <div className="flex items-center gap-2 text-gray-700">
                <Phone className={`${iconSize.sm} text-gray-400`} />
                {customer.telefon ? formatPhoneForDisplay(customer.telefon) : customer.festnetz}
              </div>
            )}
            {customer.email && (
              <div className="flex items-center gap-2 text-gray-700">
                <Mail className={`${iconSize.sm} text-gray-400`} />
                {customer.email}
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Zuständige Mitarbeiter"
          icon={<Users className={iconSize.sm} />}
        >
          <div className="space-y-3">
            <div>
              <p className="text-sm text-gray-500">Hauptzuständig</p>
              <p className="font-medium">
                {customer.primaryEmployee?.displayName || "Nicht zugewiesen"}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Vertretung</p>
              <p className="font-medium">
                {customer.backupEmployee?.displayName || "Nicht zugewiesen"}
              </p>
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Pflegekasse"
        icon={<Heart className={iconSize.sm} />}
      >
        {customer.currentInsurance ? (
          <div className="space-y-2">
            <p className="font-medium text-gray-900">
              {customer.currentInsurance.providerName}
            </p>
            <p className="text-sm text-gray-600">
              Vers.-Nr.: {customer.currentInsurance.versichertennummer}
            </p>
            <p className="text-xs text-gray-500">
              Seit {formatDateForDisplay(customer.currentInsurance.validFrom)}
            </p>
          </div>
        ) : (
          <p className="text-gray-500">Keine Pflegekasse hinterlegt</p>
        )}
      </SectionCard>

      <SectionCard
        title="Abrechnung"
        icon={<CreditCard className={iconSize.sm} />}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Private Zuzahlung:</span>
          {customer.acceptsPrivatePayment ? (
            <Badge className="bg-blue-50 text-blue-700 border-blue-200">Aktiviert</Badge>
          ) : (
            <Badge variant="outline" className="text-gray-500">Nicht aktiviert</Badge>
          )}
        </div>
        {customer.acceptsPrivatePayment && (
          <p className="text-xs text-gray-500 mt-1">
            Restbeträge über das Budget hinaus werden privat mit MwSt. berechnet
          </p>
        )}
      </SectionCard>

      {customer.needsAssessment?.anamnese && (
        <SectionCard
          title="Anamnese / Besonderheiten"
          icon={<Shield className={iconSize.sm} />}
        >
          <p className="text-gray-700 whitespace-pre-wrap">
            {customer.needsAssessment.anamnese}
          </p>
        </SectionCard>
      )}
    </div>
  );
}
