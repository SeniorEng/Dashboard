import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { formatAddress } from "@shared/utils/format";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { SectionCard } from "@/components/patterns/section-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { iconSize } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { customerKeys } from "@/features/customers";
import {
  User2,
  MapPin,
  Phone,
  Mail,
  Shield,
  Users,
  Calendar,
  CreditCard,
  FileText,
  PawPrint,
  Stethoscope,
  ClipboardList,
  History,
  Wallet,
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

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

interface CustomerOverviewTabProps {
  customer: CustomerDetail;
}

export function CustomerOverviewTab({ customer }: CustomerOverviewTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isToggling, setIsToggling] = useState(false);

  const togglePrivatePayment = useMutation({
    mutationFn: async (accepts: boolean) => {
      setIsToggling(true);
      const result = await api.patch<CustomerDetail>(`/admin/customers/${customer.id}`, {
        acceptsPrivatePayment: accepts,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerKeys.detail(customer.id) });
      toast({ title: "Abrechnungseinstellung aktualisiert" });
      setIsToggling(false);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
      setIsToggling(false);
    },
  });

  const selectedServices = getSelectedServices(customer.needsAssessment);
  const budget = customer.budgetSummary;

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
      </div>

      <SectionCard
        title="Abrechnung"
        icon={<CreditCard className={iconSize.sm} />}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-gray-700">Private Zuzahlung</p>
              <p className="text-xs text-gray-500">
                Restbeträge über das Budget hinaus werden privat mit MwSt. berechnet
              </p>
            </div>
            <Switch
              checked={customer.acceptsPrivatePayment ?? false}
              onCheckedChange={(checked) => togglePrivatePayment.mutate(checked)}
              disabled={isToggling}
              data-testid="switch-accepts-private-payment"
            />
          </div>

          {budget && (
            <div className="border-t pt-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-gray-500">Budget verfügbar</p>
                  <p className={`font-semibold ${budget.availableCents > 0 ? "text-green-700" : "text-red-600"}`} data-testid="text-budget-available">
                    {formatCents(budget.availableCents)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Verbraucht (gesamt)</p>
                  <p className="font-semibold text-gray-800" data-testid="text-budget-used">
                    {formatCents(budget.totalUsedCents)}
                  </p>
                </div>
                {budget.monthlyLimitCents !== null && (
                  <>
                    <div>
                      <p className="text-gray-500">Monatslimit</p>
                      <p className="font-medium text-gray-700">{formatCents(budget.monthlyLimitCents)}</p>
                    </div>
                    <div>
                      <p className="text-gray-500">Diesen Monat verbraucht</p>
                      <p className="font-medium text-gray-700">{formatCents(budget.currentMonthUsedCents)}</p>
                    </div>
                  </>
                )}
              </div>
              {budget.availableCents <= 0 && customer.acceptsPrivatePayment && (
                <div className="mt-2 p-2 rounded bg-amber-50 border border-amber-200">
                  <p className="text-xs text-amber-800 font-medium">
                    <Wallet className="inline h-3 w-3 mr-1" />
                    Budget aufgebraucht — weitere Leistungen werden privat berechnet
                  </p>
                </div>
              )}
              {budget.availableCents <= 0 && !customer.acceptsPrivatePayment && (
                <div className="mt-2 p-2 rounded bg-red-50 border border-red-200">
                  <p className="text-xs text-red-800 font-medium">
                    Budget aufgebraucht — private Zuzahlung ist nicht aktiviert
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </SectionCard>

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
                <Badge className={customer.currentContract.status === "active" ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-700 border-gray-200"}>
                  {customer.currentContract.status === "active" ? "Aktiv" : customer.currentContract.status === "paused" ? "Pausiert" : "Beendet"}
                </Badge>
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
                  <Badge key={index} variant="secondary" className="bg-teal-50 text-teal-700 border-teal-200">
                    {service}
                  </Badge>
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
            <Badge className="bg-amber-50 text-amber-700 border-amber-200">Haustier vorhanden</Badge>
            {customer.haustierDetails && (
              <p className="text-gray-700 mt-2">{customer.haustierDetails}</p>
            )}
          </div>
        </SectionCard>
      )}

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
