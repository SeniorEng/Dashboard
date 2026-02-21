import { formatDateForDisplay } from "@shared/utils/datetime";
import { formatAddress } from "@shared/utils/format";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { iconSize } from "@/design-system";
import {
  User2,
  MapPin,
  Phone,
  Mail,
  Shield,
  Users,
  Calendar,
  FileText,
  PawPrint,
  Stethoscope,
  ClipboardList,
  History,
  Send,
} from "lucide-react";
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

function getSelectedServices(needsAssessment: CustomerDetail["needsAssessment"]): string[] {
  if (!needsAssessment) return [];
  return Object.entries(needsAssessment)
    .filter(([key, value]) => key.startsWith("service") && value === true)
    .map(([key]) => SERVICE_LABELS[key] || key);
}

interface CustomerOverviewTabProps {
  customer: CustomerDetail;
}

export function CustomerOverviewTab({ customer }: CustomerOverviewTabProps) {
  const selectedServices = getSelectedServices(customer.needsAssessment);

  const currentCareLevel = customer.careLevelHistory?.find((e) => !e.validTo);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard
          title="Kontaktdaten"
          icon={<User2 className={iconSize.sm} />}
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-gray-700">
              <Calendar className={`${iconSize.sm} text-gray-400`} />
              Geb.: {customer.geburtsdatum ? formatDateForDisplay(customer.geburtsdatum) : "Nicht angegeben"}
            </div>
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
        {(customer.pflegegrad != null && customer.pflegegrad > 0) && (
          <SectionCard
            title="Pflegegrad"
            icon={<Shield className={iconSize.sm} />}
          >
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
              </div>
              {currentCareLevel?.validFrom && (
                <p className="text-sm text-gray-500">
                  Seit {formatDateForDisplay(currentCareLevel.validFrom)}
                </p>
              )}
            </div>
          </SectionCard>
        )}
      </div>

      {customer.currentContract && (
        <SectionCard
          title="Vertrag"
          icon={<FileText className={iconSize.sm} />}
        >
          <div className="space-y-3" data-testid="text-contract">
            <div className="grid gap-3 grid-cols-2">
              {customer.currentContract.contractDate && (
                <div>
                  <p className="text-sm text-gray-500">Vertragsabschluss</p>
                  <p className="font-medium">{formatDateForDisplay(customer.currentContract.contractDate)}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-gray-500">Vertragsbeginn</p>
                <p className="font-medium" data-testid="text-contract-start">{formatDateForDisplay(customer.currentContract.contractStart)}</p>
              </div>
              {customer.currentContract.hoursPerPeriod > 0 && (
                <div>
                  <p className="text-sm text-gray-500">Vertragsumfang</p>
                  <p className="font-medium" data-testid="text-contract-hours">
                    {customer.currentContract.hoursPerPeriod} Std. / {formatPeriodType(customer.currentContract.periodType)}
                  </p>
                </div>
              )}
              <div>
                <p className="text-sm text-gray-500">Status</p>
                <StatusBadge type="contract" value={customer.currentContract.status} />
              </div>
            </div>
          </div>
        </SectionCard>
      )}

      {customer.currentContract?.vereinbarteLeistungen && (
        <SectionCard
          title="Vereinbarte Leistungen"
          icon={<ClipboardList className={iconSize.sm} />}
        >
          <p className="text-gray-700 whitespace-pre-wrap" data-testid="text-vereinbarte-leistungen">
            {customer.currentContract.vereinbarteLeistungen}
          </p>
        </SectionCard>
      )}

      {(selectedServices.length > 0 || customer.needsAssessment?.sonstigeLeistungen || customer.needsAssessment?.householdSize) && (
        <SectionCard
          title="Bedarfserfassung"
          icon={<ClipboardList className={iconSize.sm} />}
        >
          <div className="space-y-3">
            {selectedServices.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedServices.map((service, index) => (
                  <StatusBadge key={index} type="info" value={service} />
                ))}
              </div>
            )}
            {customer.needsAssessment?.sonstigeLeistungen && (
              <div className={selectedServices.length > 0 ? "pt-3 border-t" : ""}>
                <p className="text-sm text-gray-500 mb-1">Sonstige Leistungen</p>
                <p className="text-gray-700 text-sm">{customer.needsAssessment.sonstigeLeistungen}</p>
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

      {customer.vorerkrankungen && (
        <SectionCard
          title="Vorerkrankungen"
          icon={<Stethoscope className={iconSize.sm} />}
        >
          <p className="text-gray-700 whitespace-pre-wrap" data-testid="text-vorerkrankungen">
            {customer.vorerkrankungen}
          </p>
        </SectionCard>
      )}

      {customer.haustierVorhanden && (
        <SectionCard
          title="Haustier"
          icon={<PawPrint className={iconSize.sm} />}
        >
          <div className="space-y-1" data-testid="text-haustier">
            <StatusBadge type="warning" value="Haustier vorhanden" />
            {customer.haustierDetails && (
              <p className="text-gray-700 mt-2">{customer.haustierDetails}</p>
            )}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Versandart Unterlagen"
        icon={<Send className={iconSize.sm} />}
      >
        <p className="text-gray-700" data-testid="text-delivery-method">
          {customer.documentDeliveryMethod === "post" ? "Per Deutsche Post (gedruckt)" : "Per E-Mail (digital)"}
        </p>
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

      {customer.careLevelHistory && customer.careLevelHistory.length > 0 && (
        <SectionCard
          title="Pflegegrad-Verlauf"
          icon={<History className={iconSize.sm} />}
        >
          <div className="relative">
            <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />
            <div className="space-y-3">
              {customer.careLevelHistory.map((entry, index) => (
                <div key={entry.id} className="relative pl-10">
                  <div
                    className={`absolute left-2.5 w-3 h-3 rounded-full ${
                      index === 0 ? "bg-teal-500" : "bg-gray-300"
                    }`}
                  />
                  <div className="p-3 rounded-lg bg-gray-50">
                    <div className="flex items-center justify-between">
                      <StatusBadge type="pflegegrad" value={entry.pflegegrad} />
                      <span className="text-xs text-gray-500">
                        {formatDateForDisplay(entry.validFrom)}
                        {entry.validTo && ` - ${formatDateForDisplay(entry.validTo)}`}
                      </span>
                    </div>
                    {entry.notes && (
                      <p className="text-sm text-gray-600 mt-2">{entry.notes}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
