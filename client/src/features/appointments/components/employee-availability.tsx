import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api";
import { CalendarCheck, Clock, User, Palmtree, Thermometer } from "lucide-react";
import { iconSize } from "@/design-system";

interface AvailabilitySlot {
  startTime: string | null;
  endTime: string | null;
}

interface EmployeeAppointment {
  scheduledStart: string | null;
  scheduledEnd: string | null;
  durationMinutes: number;
  customerName: string;
}

interface EmployeeAvailabilityData {
  id: number;
  displayName: string;
  availability: AvailabilitySlot[];
  appointments: EmployeeAppointment[];
  absence: "urlaub" | "krankheit" | null;
}

interface EmployeeAvailabilityProps {
  date: string;
  selectedEmployeeId?: string;
  onSelectEmployee: (employeeId: string) => void;
}

function formatEndTime(start: string | null, durationMinutes: number): string | null {
  if (!start) return null;
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + durationMinutes;
  const endH = Math.floor(total / 60) % 24;
  const endM = total % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

export function EmployeeAvailability({ date, selectedEmployeeId, onSelectEmployee }: EmployeeAvailabilityProps) {
  const { data: employees, isLoading } = useQuery({
    queryKey: ["/api/admin/employees/availability", date],
    queryFn: async (): Promise<EmployeeAvailabilityData[]> => {
      return api.get(`/api/admin/employees/availability?date=${date}`).then(unwrapResult) as Promise<EmployeeAvailabilityData[]>;
    },
    enabled: !!date,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground text-center py-3">
        Verfügbarkeiten werden geladen...
      </div>
    );
  }

  if (!employees || employees.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-3">
        Keine Mitarbeiter mit Erstberatungs-Berechtigung gefunden.
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="employee-availability-section">
      <div className="flex items-center gap-1.5 text-sm font-medium text-gray-600">
        <CalendarCheck className={iconSize.sm} />
        Verfügbarkeit am gewählten Tag
      </div>
      <div className="space-y-2">
        {employees.map((emp) => (
          <button
            key={emp.id}
            type="button"
            onClick={() => !emp.absence && onSelectEmployee(emp.id.toString())}
            disabled={!!emp.absence}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              selectedEmployeeId === emp.id.toString()
                ? "border-teal-500 bg-teal-50 ring-1 ring-teal-500"
                : emp.absence
                  ? "border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed"
                  : "border-gray-200 hover:border-teal-300 hover:bg-teal-50/50 cursor-pointer"
            }`}
            data-testid={`availability-card-${emp.id}`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <User className={`${iconSize.sm} text-gray-500`} />
                <span className="font-medium text-sm">{emp.displayName}</span>
              </div>
              {emp.absence === "urlaub" && (
                <span className="flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full" data-testid={`badge-absence-${emp.id}`}>
                  <Palmtree className="h-3 w-3" />
                  Urlaub
                </span>
              )}
              {emp.absence === "krankheit" && (
                <span className="flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 px-2 py-0.5 rounded-full" data-testid={`badge-absence-${emp.id}`}>
                  <Thermometer className="h-3 w-3" />
                  Krank
                </span>
              )}
              {!emp.absence && emp.availability.length > 0 && (
                <span className="text-xs font-medium text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full" data-testid={`badge-available-${emp.id}`}>
                  Verfügbar
                </span>
              )}
            </div>

            {!emp.absence && (
              <div className="ml-6 space-y-1">
                {emp.availability.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {emp.availability.map((slot, i) => (
                      <span
                        key={i}
                        className="text-xs px-2 py-0.5 bg-emerald-50 border border-emerald-200 rounded text-emerald-700"
                        data-testid={`slot-available-${emp.id}-${i}`}
                      >
                        {slot.startTime} – {slot.endTime}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-gray-400">Keine Verfügbarkeit gemeldet</span>
                )}

                {emp.appointments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {emp.appointments.map((appt, i) => {
                      const end = appt.scheduledEnd || formatEndTime(appt.scheduledStart, appt.durationMinutes);
                      return (
                        <span
                          key={i}
                          className="text-xs px-2 py-0.5 bg-gray-100 border border-gray-200 rounded text-gray-500 flex items-center gap-1"
                          data-testid={`slot-booked-${emp.id}-${i}`}
                        >
                          <Clock className="h-3 w-3" />
                          {appt.scheduledStart}{end ? ` – ${end}` : ""} {appt.customerName}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Tippe auf einen Mitarbeiter, um ihn zuzuweisen.
      </p>
    </div>
  );
}
