import { useState } from "react";
import { formatKm } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Car, Palmtree, ChevronDown, AlertTriangle } from "lucide-react";
import { iconSize } from "@/design-system";
import { MONTH_NAMES, formatMinutesToHours } from "../constants";

interface ServiceHours {
  hauswirtschaftMinutes?: number;
  alltagsbegleitungMinutes?: number;
  erstberatungMinutes?: number;
}

interface TravelInfo {
  totalMinutes?: number;
  totalKilometers?: number;
  customerKilometers?: number;
  timeEntryKilometers?: number;
}

interface TimeOverview {
  serviceHours?: ServiceHours;
  completedServiceHours?: ServiceHours;
  plannedServiceHours?: ServiceHours;
  travel?: TravelInfo;
  completedTravel?: Pick<TravelInfo, 'totalMinutes' | 'totalKilometers' | 'customerKilometers'>;
  plannedTravel?: Pick<TravelInfo, 'totalMinutes' | 'totalKilometers' | 'customerKilometers'>;
  timeEntries?: {
    pauseMinutes?: number;
    bueroarbeitMinutes?: number;
    vertriebMinutes?: number;
    schulungMinutes?: number;
    besprechungMinutes?: number;
    sonstigesMinutes?: number;
  };
}

interface VacationSummary {
  totalDays: number;
  carryOverDays: number;
  remainingDays: number;
  usedDays: number;
  plannedDays: number;
  sickDays: number;
}

interface TimeOverviewSummaryProps {
  timeOverview: TimeOverview | undefined;
  vacationSummary: VacationSummary | undefined;
  selectedMonth: number;
  selectedYear: number;
  isEuRentner?: boolean;
}

function CollapsibleCard({
  title,
  icon,
  defaultOpen = true,
  summaryText,
  testId,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  summaryText?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Card data-testid={testId}>
      <CardHeader
        className={`cursor-pointer select-none ${isOpen ? "pb-2" : ""}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
            {icon}
            {title}
          </CardTitle>
          <div className="flex items-center gap-2">
            {!isOpen && summaryText && (
              <span className="text-sm font-semibold text-gray-900">{summaryText}</span>
            )}
            <ChevronDown
              className={`${iconSize.sm} text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
            />
          </div>
        </div>
      </CardHeader>
      <div
        className={`overflow-hidden transition-all duration-200 ${isOpen ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"}`}
      >
        <CardContent className="pt-0">
          {children}
        </CardContent>
      </div>
    </Card>
  );
}

export function TimeOverviewSummary({ timeOverview, vacationSummary, selectedMonth, selectedYear, isEuRentner = false }: TimeOverviewSummaryProps) {
  const cHw = timeOverview?.completedServiceHours?.hauswirtschaftMinutes || 0;
  const cAb = timeOverview?.completedServiceHours?.alltagsbegleitungMinutes || 0;
  const cEb = timeOverview?.completedServiceHours?.erstberatungMinutes || 0;
  const cTravel = timeOverview?.completedTravel?.totalMinutes || 0;
  const sonstigesMinutes =
    (timeOverview?.timeEntries?.bueroarbeitMinutes || 0) +
    (timeOverview?.timeEntries?.vertriebMinutes || 0) +
    (timeOverview?.timeEntries?.schulungMinutes || 0) +
    (timeOverview?.timeEntries?.besprechungMinutes || 0) +
    (timeOverview?.timeEntries?.sonstigesMinutes || 0);
  const completedTotal = cHw + cAb + cEb + cTravel + sonstigesMinutes;

  const pHw = timeOverview?.plannedServiceHours?.hauswirtschaftMinutes || 0;
  const pAb = timeOverview?.plannedServiceHours?.alltagsbegleitungMinutes || 0;
  const pEb = timeOverview?.plannedServiceHours?.erstberatungMinutes || 0;
  const pTravel = timeOverview?.plannedTravel?.totalMinutes || 0;
  const plannedTotal = pHw + pAb + pEb + pTravel;
  const hasPlanned = plannedTotal > 0;

  const totalServiceMinutes = completedTotal + plannedTotal;

  const euRentnerMonthWarning = (() => {
    if (!isEuRentner) return null;
    const totalHours = totalServiceMinutes / 60;
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    const weeksInMonth = daysInMonth / 7;
    const maxMonthlyHours = 15 * weeksInMonth;
    if (totalHours >= maxMonthlyHours) {
      return { totalHours, maxMonthlyHours };
    }
    return null;
  })();

  const timeEntryKm = timeOverview?.travel?.timeEntryKilometers || 0;
  const completedTravelKm = timeOverview?.completedTravel?.totalKilometers || 0;
  const completedCustomerKm = timeOverview?.completedTravel?.customerKilometers || 0;
  const totalKm = completedTravelKm + completedCustomerKm + timeEntryKm;

  return (
    <div className="flex flex-col gap-4 mb-6">
      <CollapsibleCard
        title={`Stunden ${MONTH_NAMES[selectedMonth - 1]}`}
        icon={<Users className={iconSize.sm} />}
        defaultOpen={true}
        summaryText={formatMinutesToHours(totalServiceMinutes)}
        testId="card-hours-summary"
      >
        <div className="space-y-2">
          <div className={`grid grid-cols-1 ${hasPlanned ? "sm:grid-cols-2 gap-x-6" : ""} gap-y-0`}>
            <div className="space-y-2">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1" data-testid="label-completed-section">Dokumentiert</div>
              <SummaryRow label="Hauswirtschaft" value={formatMinutesToHours(cHw)} color="text-gray-700" testId="text-hauswirtschaft-hours" />
              <SummaryRow label="Alltagsbegleitung" value={formatMinutesToHours(cAb)} color="text-gray-700" testId="text-alltagsbegleitung-hours" />
              <SummaryRow label="Erstberatung" value={formatMinutesToHours(cEb)} color="text-gray-700" testId="text-erstberatung-hours" />
              <SummaryRow label="Anfahrt" value={formatMinutesToHours(cTravel)} color="text-gray-700" testId="text-travel-time-hours" />
              <SummaryRow label="Sonstiges" value={formatMinutesToHours(sonstigesMinutes)} color="text-gray-700" testId="text-sonstiges-hours" />
              <div className="border-t pt-2 mt-2 flex justify-between items-center">
                <span className="text-sm font-medium text-gray-700">Gesamt</span>
                <span className="font-bold text-gray-900" data-testid="text-completed-service-hours">
                  {formatMinutesToHours(completedTotal)}
                </span>
              </div>
            </div>
            {hasPlanned && (
              <div className="space-y-2 mt-3 sm:mt-0">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1" data-testid="label-planned-section">Geplant</div>
                <SummaryRow label="Hauswirtschaft" value={formatMinutesToHours(pHw)} color="text-gray-500" testId="text-planned-hauswirtschaft-hours" />
                <SummaryRow label="Alltagsbegleitung" value={formatMinutesToHours(pAb)} color="text-gray-500" testId="text-planned-alltagsbegleitung-hours" />
                <SummaryRow label="Erstberatung" value={formatMinutesToHours(pEb)} color="text-gray-500" testId="text-planned-erstberatung-hours" />
                <SummaryRow label="Anfahrt" value={formatMinutesToHours(pTravel)} color="text-gray-500" testId="text-planned-travel-time-hours" />
                <div className="border-t border-dashed pt-2 mt-2 flex justify-between items-center">
                  <span className="text-sm font-medium text-gray-500">Gesamt</span>
                  <span className="font-semibold text-gray-600" data-testid="text-planned-service-hours">
                    {formatMinutesToHours(plannedTotal)}
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="border-t pt-2 mt-2 flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700">Gesamt</span>
            <span className="font-bold text-gray-900" data-testid="text-total-service-hours">
              {formatMinutesToHours(totalServiceMinutes)}
            </span>
          </div>
          {(timeOverview?.timeEntries?.pauseMinutes || 0) > 0 && (
            <div className="flex justify-between items-center pt-1 text-gray-500">
              <span className="text-xs">davon Pause (unbezahlt)</span>
              <span className="text-xs font-medium" data-testid="text-pause-hours">
                {formatMinutesToHours(timeOverview?.timeEntries?.pauseMinutes || 0)}
              </span>
            </div>
          )}
          {euRentnerMonthWarning && (
            <div className="flex items-start gap-1.5 mt-3 p-2 rounded bg-red-50 border border-red-200" data-testid="text-eu-rentner-monthly-warning">
              <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
              <span className="text-xs text-red-700 font-medium">
                EU-Rentner-Grenze erreicht: {euRentnerMonthWarning.totalHours.toFixed(1).replace(".", ",")}h / max. {euRentnerMonthWarning.maxMonthlyHours.toFixed(1).replace(".", ",")}h (15h/Woche)
              </span>
            </div>
          )}
        </div>
      </CollapsibleCard>

      <CollapsibleCard
        title={`Kilometer ${MONTH_NAMES[selectedMonth - 1]}`}
        icon={<Car className={iconSize.sm} />}
        defaultOpen={true}
        summaryText={`${formatKm(totalKm)} km`}
        testId="card-km-summary"
      >
        <div className="space-y-2">
          <SummaryRow label="Anfahrt" value={`${formatKm(completedTravelKm)} km`} color="text-gray-700" testId="text-anfahrt-km" />
          {completedCustomerKm > 0 && (
            <SummaryRow label="Km mit Kunden" value={`${formatKm(completedCustomerKm)} km`} color="text-gray-700" testId="text-customer-km" />
          )}
          <SummaryRow label="Sonstige Fahrten" value={`${formatKm(timeEntryKm)} km`} color="text-gray-700" testId="text-time-entry-km" />
          <div className="border-t pt-2 mt-2 flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700">Gesamt</span>
            <span className="font-bold text-gray-900" data-testid="text-total-km">
              {formatKm(totalKm)} km
            </span>
          </div>
        </div>
      </CollapsibleCard>

      <CollapsibleCard
        title={`Urlaub ${selectedYear}`}
        icon={<Palmtree className={iconSize.sm} />}
        defaultOpen={false}
        summaryText={vacationSummary ? `${vacationSummary.remainingDays} Tage verfügbar` : undefined}
        testId="card-vacation-summary"
      >
        {vacationSummary ? (
          <div className="space-y-2">
            <SummaryRow label="Anspruch" value={`${vacationSummary.totalDays} ${vacationSummary.totalDays === 1 ? 'Tag' : 'Tage'}`} color="text-gray-700" testId="text-total-vacation" />
            {vacationSummary.carryOverDays > 0 && (
              <SummaryRow label="Übertrag (bis 01.04.)" value={`${vacationSummary.carryOverDays} ${vacationSummary.carryOverDays === 1 ? 'Tag' : 'Tage'}`} color="text-gray-700" testId="text-carry-over" />
            )}
            <SummaryRow label="Genommen" value={`${vacationSummary.usedDays} ${vacationSummary.usedDays === 1 ? 'Tag' : 'Tage'}`} color="text-gray-700" testId="text-used-days" />
            <SummaryRow label="Geplant" value={`${vacationSummary.plannedDays} ${vacationSummary.plannedDays === 1 ? 'Tag' : 'Tage'}`} color="text-gray-700" testId="text-planned-days" />
            <div className="border-t pt-2 mt-2">
              <SummaryRow label="Verfügbar" value={`${vacationSummary.remainingDays} ${vacationSummary.remainingDays === 1 ? 'Tag' : 'Tage'}`} color="text-gray-900" testId="text-remaining-days" bold />
            </div>
            <div className="border-t pt-2 mt-2 flex justify-between items-center">
              <span className="text-sm text-gray-600">Krankheit</span>
              <span className="font-semibold text-gray-700" data-testid="text-sick-days">
                {vacationSummary.sickDays} {vacationSummary.sickDays === 1 ? 'Tag' : 'Tage'}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-center py-4 text-gray-500 text-sm">Laden...</div>
        )}
      </CollapsibleCard>
    </div>
  );
}

function SummaryRow({ label, value, color, testId, bold }: { label: string; value: string; color: string; testId: string; bold?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`${bold ? "font-bold" : "font-semibold"} ${color}`} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
