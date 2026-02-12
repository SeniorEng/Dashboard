import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Car, Palmtree } from "lucide-react";
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

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
            <Users className={iconSize.sm} />
            Stunden {MONTH_NAMES[selectedMonth - 1]}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
            <Car className={iconSize.sm} />
            Kilometer {MONTH_NAMES[selectedMonth - 1]}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            <SummaryRow label="Anfahrt" value={`${timeOverview?.travel?.totalKilometers || 0} km`} color="text-amber-700" testId="text-anfahrt-km" />
            <SummaryRow label="Kundenfahrten" value={`${timeOverview?.travel?.customerKilometers || 0} km`} color="text-teal-700" testId="text-customer-km" />
            <div className="border-t pt-2 mt-2 flex justify-between items-center">
              <span className="text-sm font-medium text-gray-700">Gesamt</span>
              <span className="font-bold text-gray-900" data-testid="text-total-km">
                {(timeOverview?.travel?.totalKilometers || 0) + (timeOverview?.travel?.customerKilometers || 0)} km
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
            <Palmtree className={iconSize.sm} />
            Urlaub {selectedYear}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {vacationSummary ? (
            <div className="space-y-2">
              <SummaryRow label="Anspruch" value={`${vacationSummary.totalDays} Tage`} color="text-gray-700" testId="text-total-vacation" />
              {vacationSummary.carryOverDays > 0 && (
                <SummaryRow label="Übertrag (bis 01.04.)" value={`${vacationSummary.carryOverDays} Tage`} color="text-amber-700" testId="text-carry-over" />
              )}
              <SummaryRow label="Genommen" value={`${vacationSummary.usedDays} Tage`} color="text-green-700" testId="text-used-days" />
              <SummaryRow label="Geplant" value={`${vacationSummary.plannedDays} Tage`} color="text-blue-700" testId="text-planned-days" />
              <div className="border-t pt-2 mt-2">
                <SummaryRow label="Verfügbar" value={`${vacationSummary.remainingDays} Tage`} color="text-teal-700" testId="text-remaining-days" bold />
              </div>
              <div className="border-t pt-2 mt-2 flex justify-between items-center">
                <span className="text-sm text-gray-600">Krankheit</span>
                <span className="font-semibold text-red-700" data-testid="text-sick-days">
                  {vacationSummary.sickDays} Tage
                </span>
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-gray-400 text-sm">Laden...</div>
          )}
        </CardContent>
      </Card>
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
