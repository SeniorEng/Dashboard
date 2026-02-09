import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { formatCurrency } from "@shared/utils/format";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { iconSize, componentStyles } from "@/design-system";
import { FileText, ClipboardList, Car } from "lucide-react";
import type { CustomerDetail } from "@/lib/api/types";

const SERVICE_LABELS: Record<string, string> = {
  serviceHaushaltHilfe: "Haushaltshilfe",
  serviceMahlzeiten: "Mahlzeiten",
  serviceReinigung: "Reinigung",
  serviceWaeschePflege: "Wäschepflege",
  serviceEinkauf: "Einkauf",
  serviceTagesablauf: "Tagesablauf",
  serviceAlltagsverrichtungen: "Alltagsverrichtungen",
  serviceTerminbegleitung: "Terminbegleitung",
  serviceBotengaenge: "Botengänge",
  serviceGrundpflege: "Grundpflege",
  serviceFreizeitbegleitung: "Freizeitbegleitung",
  serviceDemenzbetreuung: "Demenzbetreuung",
  serviceGesellschaft: "Gesellschaft",
  serviceSozialeKontakte: "Soziale Kontakte",
  serviceFreizeitgestaltung: "Freizeitgestaltung",
  serviceKreativ: "Kreative Beschäftigung",
};

function formatPeriodType(type: string): string {
  switch (type) {
    case "week": return "Woche";
    case "month": return "Monat";
    case "year": return "Jahr";
    default: return type;
  }
}

export function getSelectedServices(needsAssessment: CustomerDetail["needsAssessment"]): string[] {
  if (!needsAssessment) return [];
  return Object.entries(needsAssessment)
    .filter(([key, value]) => key.startsWith("service") && value === true)
    .map(([key]) => SERVICE_LABELS[key] || key);
}

interface CustomerServicesTabProps {
  customer: CustomerDetail;
}

export function CustomerServicesTab({ customer }: CustomerServicesTabProps) {
  const selectedServices = getSelectedServices(customer.needsAssessment);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Vertrag & Preise"
        icon={<FileText className={iconSize.sm} />}
      >
        {customer.currentContract ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-sm text-gray-500">Vertragsumfang</p>
                <p className="font-medium text-lg">
                  {customer.currentContract.hoursPerPeriod} Std. / {formatPeriodType(customer.currentContract.periodType)}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Vertragsbeginn</p>
                <p className="font-medium">
                  {formatDateForDisplay(customer.currentContract.contractStart)}
                </p>
              </div>
            </div>
            
            <div className="border-t pt-4">
              <p className="text-sm font-medium text-gray-700 mb-3">Vereinbarte Stundensätze</p>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100">
                  <p className="text-sm text-gray-600">Hauswirtschaft</p>
                  <p className="text-xl font-semibold text-gray-900">
                    {formatCurrency(customer.currentContract.hauswirtschaftRateCents)}/Std.
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-sky-50 border border-sky-100">
                  <p className="text-sm text-gray-600">Alltagsbegleitung</p>
                  <p className="text-xl font-semibold text-gray-900">
                    {formatCurrency(customer.currentContract.alltagsbegleitungRateCents)}/Std.
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-100">
                  <div className="flex items-center gap-1">
                    <Car className={`${iconSize.xs} text-gray-400`} />
                    <p className="text-sm text-gray-600">Kilometer</p>
                  </div>
                  <p className="text-xl font-semibold text-gray-900">
                    {formatCurrency(customer.currentContract.kilometerRateCents)}/km
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<FileText className={iconSize.xl} />}
            title="Kein Vertrag"
            description="Kein aktiver Vertrag hinterlegt"
            action={
              <Button size="sm" className={componentStyles.btnPrimary}>
                Vertrag anlegen
              </Button>
            }
            className="py-6"
          />
        )}
      </SectionCard>

      <SectionCard
        title="Leistungsumfang"
        icon={<ClipboardList className={iconSize.sm} />}
      >
        {selectedServices.length > 0 ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {selectedServices.map((service, index) => (
                <Badge key={index} variant="secondary" className="bg-teal-50 text-teal-700 border-teal-200">
                  {service}
                </Badge>
              ))}
            </div>
            {customer.needsAssessment?.sonstigeLeistungen && (
              <div className="pt-3 border-t">
                <p className="text-sm text-gray-500 mb-1">Sonstige Leistungen</p>
                <p className="text-gray-700">{customer.needsAssessment.sonstigeLeistungen}</p>
              </div>
            )}
            {customer.needsAssessment?.householdSize && (
              <div className="pt-3 border-t">
                <p className="text-sm text-gray-500">Haushaltsgröße</p>
                <p className="text-gray-700">{customer.needsAssessment.householdSize} Person(en)</p>
              </div>
            )}
          </div>
        ) : (
          <EmptyState
            icon={<ClipboardList className={iconSize.xl} />}
            title="Keine Leistungen"
            description="Keine Leistungen erfasst"
            className="py-6"
          />
        )}
      </SectionCard>
    </div>
  );
}
