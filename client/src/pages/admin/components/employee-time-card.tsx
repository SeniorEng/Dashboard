import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { iconSize } from "@/design-system";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Users, Unlock, Plus, Pencil, Trash2, Lock, Settings, CalendarCheck, MapPin } from "lucide-react";
import type { TimeEntryType, TimeEntryWithUser, AppointmentWithCustomerName } from "@/lib/api/types";
import { TIME_ENTRY_TYPE_CONFIG } from "@/features/time-tracking/constants";

const APPOINTMENT_STATUS_LABELS: Record<string, { label: string; color: string; bgColor: string }> = {
  planned: { label: "Geplant", color: "text-blue-700", bgColor: "bg-blue-50" },
  confirmed: { label: "Bestätigt", color: "text-blue-700", bgColor: "bg-blue-50" },
  in_progress: { label: "Läuft", color: "text-amber-700", bgColor: "bg-amber-50" },
  completed: { label: "Abgeschlossen", color: "text-green-700", bgColor: "bg-green-50" },
  documented: { label: "Dokumentiert", color: "text-teal-700", bgColor: "bg-teal-50" },
  cancelled: { label: "Abgesagt", color: "text-red-700", bgColor: "bg-red-50" },
  invoiced: { label: "Abgerechnet", color: "text-purple-700", bgColor: "bg-purple-50" },
};

interface EmployeeTimeCardProps {
  employeeName: string;
  employeeEntries: TimeEntryWithUser[];
  employeeAppointments?: AppointmentWithCustomerName[];
  employeeId?: number;
  isClosed: boolean;
  onCloseMonth: (userId: number, userName: string) => void;
  onReopenMonth: (userId: number, userName: string) => void;
  onAddEntry: (userId: number, userName: string) => void;
  onEditVacation: (userId: number, userName: string) => void;
  onEditEntry: (entry: TimeEntryWithUser) => void;
  onDeleteEntry: (id: number, label: string) => void;
}

type TimelineItem =
  | { type: "entry"; date: string; sortTime: string; data: TimeEntryWithUser }
  | { type: "appointment"; date: string; sortTime: string; data: AppointmentWithCustomerName };

export function EmployeeTimeCard({
  employeeName,
  employeeEntries,
  employeeAppointments = [],
  employeeId,
  isClosed,
  onCloseMonth,
  onReopenMonth,
  onAddEntry,
  onEditVacation,
  onEditEntry,
  onDeleteEntry,
}: EmployeeTimeCardProps) {
  const timeline: TimelineItem[] = [
    ...employeeEntries.map((entry): TimelineItem => ({
      type: "entry",
      date: entry.entryDate,
      sortTime: entry.startTime || "00:00",
      data: entry,
    })),
    ...employeeAppointments.map((appt): TimelineItem => ({
      type: "appointment",
      date: appt.date,
      sortTime: appt.scheduledStart || "00:00",
      data: appt,
    })),
  ].sort((a, b) => {
    const dateComp = a.date.localeCompare(b.date);
    if (dateComp !== 0) return dateComp;
    return a.sortTime.localeCompare(b.sortTime);
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className={iconSize.md} />
            {employeeName}
            {isClosed && <StatusBadge type="month" value="closed" size="sm" />}
          </CardTitle>
          <div className="flex items-center gap-1 flex-wrap">
            {employeeId && !isClosed && (
              <Button
                variant="ghost"
                size="sm"
                className="text-teal-700 hover:text-teal-800 hover:bg-teal-50"
                onClick={() => onCloseMonth(employeeId, employeeName)}
                data-testid={`button-close-month-${employeeId}`}
              >
                <Lock className={`${iconSize.sm} mr-1`} />
                Abschließen
              </Button>
            )}
            {employeeId && isClosed && (
              <Button
                variant="ghost"
                size="sm"
                className="text-amber-700 hover:text-amber-800 hover:bg-amber-50"
                onClick={() => onReopenMonth(employeeId, employeeName)}
                data-testid={`button-reopen-month-${employeeId}`}
              >
                <Unlock className={`${iconSize.sm} mr-1`} />
                Wiedereröffnen
              </Button>
            )}
            {employeeId && (
              <Button
                variant="ghost"
                size="sm"
                className="text-blue-700 hover:text-blue-800 hover:bg-blue-50"
                onClick={() => onAddEntry(employeeId, employeeName)}
                data-testid={`button-add-entry-${employeeId}`}
              >
                <Plus className={`${iconSize.sm} mr-1`} />
                Eintrag
              </Button>
            )}
            {employeeId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onEditVacation(employeeId, employeeName)}
                data-testid={`button-edit-vacation-${employeeId}`}
              >
                <Settings className={`${iconSize.sm} mr-1`} />
                Urlaubskontingent
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {timeline.length === 0 ? (
          <p className="text-sm text-gray-500">Keine Einträge oder Termine in diesem Monat.</p>
        ) : (
          <div className="space-y-2">
            {timeline.map((item) => {
              if (item.type === "entry") {
                return <TimeEntryRow key={`entry-${item.data.id}`} entry={item.data} onEdit={onEditEntry} onDelete={onDeleteEntry} />;
              }
              return <AppointmentRow key={`appt-${item.data.id}`} appointment={item.data} />;
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TimeEntryRow({ entry, onEdit, onDelete }: { entry: TimeEntryWithUser; onEdit: (e: TimeEntryWithUser) => void; onDelete: (id: number, label: string) => void }) {
  const config = TIME_ENTRY_TYPE_CONFIG[entry.entryType as TimeEntryType];
  const Icon = config.icon;
  const isAutoGenerated = (entry as any).isAutoGenerated;

  return (
    <div
      className={`p-3 rounded-lg ${config.bgColor} flex items-center justify-between group`}
      data-testid={`time-entry-${entry.id}`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Icon className={`${iconSize.md} ${config.color} shrink-0`} />
        <div className="min-w-0">
          <div className={`font-medium ${config.color} flex items-center gap-2`}>
            {config.label}
            {isAutoGenerated && (
              <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">Auto</span>
            )}
          </div>
          <div className="text-sm text-gray-600">
            {formatDateForDisplay(entry.entryDate, { weekday: "short", day: "numeric", month: "short" })}
            {entry.startTime && entry.endTime && (
              <span className="ml-2">
                {entry.startTime.slice(0, 5)} - {entry.endTime.slice(0, 5)}
              </span>
            )}
            {entry.isFullDay && <span className="ml-2">(Ganztägig)</span>}
          </div>
          {entry.notes && (
            <div className="text-xs text-gray-500 truncate mt-0.5">{entry.notes}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0">
        {!isAutoGenerated && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onEdit(entry)}
              aria-label="Bearbeiten"
              data-testid={`button-edit-entry-${entry.id}`}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={() => onDelete(
                entry.id,
                `${config.label} am ${formatDateForDisplay(entry.entryDate, { day: "numeric", month: "short" })}`,
              )}
              aria-label="Löschen"
              data-testid={`button-delete-entry-${entry.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function AppointmentRow({ appointment }: { appointment: AppointmentWithCustomerName }) {
  const statusConfig = APPOINTMENT_STATUS_LABELS[appointment.status] || { label: appointment.status, color: "text-gray-700", bgColor: "bg-gray-50" };

  return (
    <div
      className={`p-3 rounded-lg bg-white border border-gray-200 flex items-center justify-between`}
      data-testid={`appointment-row-${appointment.id}`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <CalendarCheck className={`${iconSize.md} text-gray-500 shrink-0`} />
        <div className="min-w-0">
          <div className="font-medium text-gray-800 flex items-center gap-2">
            <span>Termin bei {appointment.customerName}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusConfig.color} ${statusConfig.bgColor}`}>
              {statusConfig.label}
            </span>
          </div>
          <div className="text-sm text-gray-600">
            {formatDateForDisplay(appointment.date, { weekday: "short", day: "numeric", month: "short" })}
            {appointment.scheduledStart && (
              <span className="ml-2">
                {appointment.scheduledStart.slice(0, 5)}
                {appointment.scheduledEnd && ` - ${appointment.scheduledEnd.slice(0, 5)}`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            {appointment.serviceType && (
              <span className="text-xs text-gray-500">{appointment.serviceType === "hauswirtschaft" ? "Hauswirtschaft" : appointment.serviceType === "alltagsbegleitung" ? "Alltagsbegleitung" : appointment.serviceType === "erstberatung" ? "Erstberatung" : appointment.serviceType}</span>
            )}
            {appointment.travelKilometers != null && appointment.travelKilometers > 0 && (
              <span className="text-xs text-gray-400 flex items-center gap-0.5">
                <MapPin className="h-3 w-3" />
                {appointment.travelKilometers} km
              </span>
            )}
          </div>
          {appointment.notes && (
            <div className="text-xs text-gray-500 truncate mt-0.5">{appointment.notes}</div>
          )}
        </div>
      </div>
    </div>
  );
}
