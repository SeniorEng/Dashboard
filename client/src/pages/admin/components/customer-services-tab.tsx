import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { formatCurrency } from "@shared/utils/format";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { iconSize, componentStyles } from "@/design-system";
import { FileText, ClipboardList, Car, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
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

  interface CatalogService {
    id: number;
    name: string;
    unitType: string;
    defaultPriceCents: number;
    isBillable: boolean;
    isActive: boolean;
  }

  const { data: catalogServices, isLoading: pricesLoading } = useQuery<CatalogService[]>({
    queryKey: ["/api/services"],
    staleTime: 60000,
  });

  const unitLabel = (unitType: string) => {
    switch (unitType) {
      case "hours": return "/Std.";
      case "kilometers": return "/km";
      default: return " pauschal";
    }
  };

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
              <p className="text-sm font-medium text-gray-700 mb-3">Aktuelle Preise</p>
              {pricesLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                </div>
              ) : catalogServices && catalogServices.filter(s => s.isActive && s.isBillable).length > 0 ? (
                <div className="space-y-2">
                  {catalogServices.filter(s => s.isActive && s.isBillable).map(service => (
                    <div key={service.id} className="flex justify-between items-center py-2 px-3 bg-gray-50 rounded" data-testid={`text-service-price-${service.id}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-700">{service.name}</span>
                      </div>
                      <span className="text-sm font-semibold text-gray-900">
                        {formatCurrency(service.defaultPriceCents)}{unitLabel(service.unitType)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">Keine Preise hinterlegt</p>
              )}
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
