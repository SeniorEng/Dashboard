import { Badge } from "@/components/ui/badge";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/patterns/empty-state";
import { iconSize } from "@/design-system";
import { FileText, ClipboardList } from "lucide-react";
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
  const vereinbarteLeistungen = customer.currentContract?.vereinbarteLeistungen;

  return (
    <div className="space-y-4">
      <SectionCard
        title="Vertrag"
        icon={<FileText className={iconSize.sm} />}
      >
        {customer.currentContract ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              {customer.currentContract.hoursPerPeriod > 0 && (
                <div>
                  <p className="text-sm text-gray-500">Vertragsumfang</p>
                  <p className="font-medium text-lg" data-testid="text-contract-hours">
                    {customer.currentContract.hoursPerPeriod} Std. / {formatPeriodType(customer.currentContract.periodType)}
                  </p>
                </div>
              )}
              <div>
                <p className="text-sm text-gray-500">Vertragsbeginn</p>
                <p className="font-medium" data-testid="text-contract-start">
                  {formatDateForDisplay(customer.currentContract.contractStart)}
                </p>
              </div>
            </div>

            {vereinbarteLeistungen && (
              <div className="border-t pt-4">
                <p className="text-sm text-gray-500 mb-2">Vereinbarte Leistungen</p>
                <p className="text-gray-700 whitespace-pre-wrap" data-testid="text-vereinbarte-leistungen">
                  {vereinbarteLeistungen}
                </p>
              </div>
            )}
          </div>
        ) : (
          <EmptyState
            icon={<FileText className={iconSize.xl} />}
            title="Kein Vertrag"
            description="Kein aktiver Vertrag hinterlegt"
            className="py-6"
          />
        )}
      </SectionCard>

      {(selectedServices.length > 0 || customer.needsAssessment?.sonstigeLeistungen || customer.needsAssessment?.householdSize) && (
        <SectionCard
          title="Bedarfserfassung"
          icon={<ClipboardList className={iconSize.sm} />}
        >
          <div className="space-y-4">
            {selectedServices.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedServices.map((service, index) => (
                  <Badge key={index} variant="secondary" className="bg-teal-50 text-teal-700 border-teal-200">
                    {service}
                  </Badge>
                ))}
              </div>
            )}
            {customer.needsAssessment?.sonstigeLeistungen && (
              <div className={selectedServices.length > 0 ? "pt-3 border-t" : ""}>
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
        </SectionCard>
      )}
    </div>
  );
}
