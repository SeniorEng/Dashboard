import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Car, Palmtree, ChevronDown } from "lucide-react";
import { iconSize } from "@/design-system";
import { MONTH_NAMES, formatMinutesToHours } from "../constants";

interface TimeOverview {
  serviceHours?: {
    hauswirtschaftMinutes?: number;
    alltagsbegleitungMinutes?: number;
    erstberatungMinutes?: number;
  };
  travel?: {
    totalMinutes?: number;
    totalKilometers?: number;
    customerKilometers?: number;
  };
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
        className="pb-2 cursor-pointer select-none"
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
              className={`${iconSize.sm} text-gray-400 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
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

export function TimeOverviewSummary({ timeOverview, vacationSummary, selectedMonth, selectedYear }: TimeOverviewSummaryProps) {
  const hw = timeOverview?.serviceHours?.hauswirtschaftMinutes || 0;
  const ab = timeOverview?.serviceHours?.alltagsbegleitungMinutes || 0;
  const eb = timeOverview?.serviceHours?.erstberatungMinutes || 0;
  const travel = timeOverview?.travel?.totalMinutes || 0;
  const sonstigesMinutes =
    (timeOverview?.timeEntries?.bueroarbeitMinutes || 0) +
    (timeOverview?.timeEntries?.vertriebMinutes || 0) +
    (timeOverview?.timeEntries?.schulungMinutes || 0) +
    (timeOverview?.timeEntries?.besprechungMinutes || 0) +
    (timeOverview?.timeEntries?.sonstigesMinutes || 0);
  const totalServiceMinutes = hw + ab + eb + travel + sonstigesMinutes;

  const totalKm = (timeOverview?.travel?.totalKilometers || 0) + (timeOverview?.travel?.customerKilometers || 0);

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
          <SummaryRow label="Hauswirtschaft" value={formatMinutesToHours(hw)} color="text-teal-700" testId="text-hauswirtschaft-hours" />
          <SummaryRow label="Alltagsbegleitung" value={formatMinutesToHours(ab)} color="text-blue-700" testId="text-alltagsbegleitung-hours" />
          <SummaryRow label="Erstberatung" value={formatMinutesToHours(eb)} color="text-purple-700" testId="text-erstberatung-hours" />
          <SummaryRow label="Anfahrt" value={formatMinutesToHours(travel)} color="text-amber-700" testId="text-travel-time-hours" />
          <SummaryRow label="Sonstiges" value={formatMinutesToHours(sonstigesMinutes)} color="text-gray-700" testId="text-sonstiges-hours" />
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
        </div>
      </CollapsibleCard>

      <CollapsibleCard
        title={`Kilometer ${MONTH_NAMES[selectedMonth - 1]}`}
        icon={<Car className={iconSize.sm} />}
        defaultOpen={true}
        summaryText={`${totalKm} km`}
        testId="card-km-summary"
      >
        <div className="space-y-2">
          <SummaryRow label="Anfahrt" value={`${timeOverview?.travel?.totalKilometers || 0} km`} color="text-amber-700" testId="text-anfahrt-km" />
          <SummaryRow label="Kundenfahrten" value={`${timeOverview?.travel?.customerKilometers || 0} km`} color="text-teal-700" testId="text-customer-km" />
          <div className="border-t pt-2 mt-2 flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700">Gesamt</span>
            <span className="font-bold text-gray-900" data-testid="text-total-km">
              {totalKm} km
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
              <SummaryRow label="Übertrag (bis 01.04.)" value={`${vacationSummary.carryOverDays} ${vacationSummary.carryOverDays === 1 ? 'Tag' : 'Tage'}`} color="text-amber-700" testId="text-carry-over" />
            )}
            <SummaryRow label="Genommen" value={`${vacationSummary.usedDays} ${vacationSummary.usedDays === 1 ? 'Tag' : 'Tage'}`} color="text-green-700" testId="text-used-days" />
            <SummaryRow label="Geplant" value={`${vacationSummary.plannedDays} ${vacationSummary.plannedDays === 1 ? 'Tag' : 'Tage'}`} color="text-blue-700" testId="text-planned-days" />
            <div className="border-t pt-2 mt-2">
              <SummaryRow label="Verfügbar" value={`${vacationSummary.remainingDays} ${vacationSummary.remainingDays === 1 ? 'Tag' : 'Tage'}`} color="text-teal-700" testId="text-remaining-days" bold />
            </div>
            <div className="border-t pt-2 mt-2 flex justify-between items-center">
              <span className="text-sm text-gray-600">Krankheit</span>
              <span className="font-semibold text-red-700" data-testid="text-sick-days">
                {vacationSummary.sickDays} {vacationSummary.sickDays === 1 ? 'Tag' : 'Tage'}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-center py-4 text-gray-400 text-sm">Laden...</div>
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
