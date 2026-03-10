import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  User,
  Palmtree,
  Thermometer,
  Plus,
  Loader2,
} from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import { format, startOfWeek, addWeeks, subWeeks, addDays, isSameDay } from "date-fns";
import { de } from "date-fns/locale";

interface FreeSlot {
  start: string;
  end: string;
}

interface DayAppointment {
  scheduledStart: string | null;
  scheduledEnd: string | null;
  durationMinutes: number;
  customerName: string;
  status: string;
}

interface DayData {
  availability: { startTime: string | null; endTime: string | null }[];
  appointments: DayAppointment[];
  absence: "urlaub" | "krankheit" | null;
  freeSlots: FreeSlot[];
}

interface EmployeeWeekData {
  id: number;
  displayName: string;
  days: Record<string, DayData>;
}

interface WeeklyAvailabilityResponse {
  dates: string[];
  employees: EmployeeWeekData[];
}

const DAY_NAMES_SHORT = ["Mo", "Di", "Mi", "Do", "Fr"];

function getWeekStart(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

export default function AvailabilityPage() {
  const [, navigate] = useLocation();
  const today = new Date();
  const [currentWeekStart, setCurrentWeekStart] = useState(() => getWeekStart(today));
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [mobileSelectedDay, setMobileSelectedDay] = useState(0);

  const startDateStr = format(currentWeekStart, "yyyy-MM-dd");
  const weekDates = useMemo(() => {
    return Array.from({ length: 5 }, (_, i) => addDays(currentWeekStart, i));
  }, [currentWeekStart]);

  const { data, isLoading } = useQuery<WeeklyAvailabilityResponse>({
    queryKey: ["weekly-availability", startDateStr],
    queryFn: async () => {
      const result = await api.get<WeeklyAvailabilityResponse>(
        `/admin/employees/weekly-availability?startDate=${startDateStr}&days=5`
      );
      return unwrapResult(result);
    },
    staleTime: 30000,
  });

  const employees = useMemo(() => {
    if (!data?.employees) return [];
    if (selectedEmployeeId === null) return data.employees;
    return data.employees.filter((e) => e.id === selectedEmployeeId);
  }, [data, selectedEmployeeId]);

  const handleSlotClick = (employeeId: number, date: string, time: string) => {
    navigate(
      `/new-appointment?type=erstberatung&date=${date}&employeeId=${employeeId}&time=${time}`
    );
  };

  const isThisWeek = isSameDay(currentWeekStart, getWeekStart(today));

  return (
    <Layout variant="admin">
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/admin")}
          aria-label="Zurück"
          data-testid="button-back"
        >
          <ArrowLeft className={iconSize.md} />
        </Button>
        <div>
          <h1 className={componentStyles.pageTitle} data-testid="text-page-title">
            Mitarbeiter-Verfügbarkeit
          </h1>
          <p className="text-gray-600">Freie Zeiten für Erstberatungen planen</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentWeekStart(subWeeks(currentWeekStart, 1))}
            data-testid="button-prev-week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-sm font-medium min-w-[180px] text-center" data-testid="text-week-range">
            {format(currentWeekStart, "d. MMM", { locale: de })} –{" "}
            {format(addDays(currentWeekStart, 4), "d. MMM yyyy", { locale: de })}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentWeekStart(addWeeks(currentWeekStart, 1))}
            data-testid="button-next-week"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {!isThisWeek && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCurrentWeekStart(getWeekStart(today))}
              data-testid="button-today"
            >
              Heute
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={selectedEmployeeId ?? ""}
            onChange={(e) =>
              setSelectedEmployeeId(e.target.value ? parseInt(e.target.value) : null)
            }
            className="text-sm border border-border rounded-md px-2 py-1.5 bg-background"
            data-testid="select-employee-filter"
          >
            <option value="">Alle Mitarbeiter</option>
            {data?.employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="md:hidden flex gap-1 mb-3 overflow-x-auto">
        {weekDates.map((date, idx) => {
          const dateStr = format(date, "yyyy-MM-dd");
          const isToday = isSameDay(date, today);
          const isSelected = idx === mobileSelectedDay;
          return (
            <button
              key={dateStr}
              onClick={() => setMobileSelectedDay(idx)}
              className={`flex-1 min-w-[56px] py-2 px-1 rounded-lg text-center transition-colors ${
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : isToday
                  ? "bg-primary/10 text-primary"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted"
              }`}
              data-testid={`button-mobile-day-${idx}`}
            >
              <div className="text-xs font-medium">{DAY_NAMES_SHORT[idx]}</div>
              <div className="text-lg font-bold">{format(date, "d")}</div>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : employees.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          <Calendar className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
          <p>Keine Mitarbeiter mit Erstberatungs-Berechtigung gefunden.</p>
        </Card>
      ) : (
        <>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full border-collapse" data-testid="table-availability">
              <thead>
                <tr>
                  <th className="text-left text-sm font-medium text-muted-foreground p-2 w-[160px] sticky left-0 bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] z-10">
                    Mitarbeiter
                  </th>
                  {weekDates.map((date, idx) => {
                    const isToday = isSameDay(date, today);
                    return (
                      <th
                        key={idx}
                        className={`text-center text-sm font-medium p-2 min-w-[140px] ${
                          isToday ? "text-primary" : "text-muted-foreground"
                        }`}
                      >
                        <div>{DAY_NAMES_SHORT[idx]}</div>
                        <div className={`text-lg font-bold ${isToday ? "text-primary" : ""}`}>
                          {format(date, "d. MMM", { locale: de })}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => (
                  <tr key={emp.id} className="border-t border-border/40" data-testid={`row-employee-${emp.id}`}>
                    <td className="p-2 align-top sticky left-0 bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4] z-10">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                          {emp.displayName
                            .split(" ")
                            .map((n) => n[0])
                            .join("")
                            .slice(0, 2)}
                        </div>
                        <span className="text-sm font-medium truncate">{emp.displayName}</span>
                      </div>
                    </td>
                    {weekDates.map((date) => {
                      const dateStr = format(date, "yyyy-MM-dd");
                      const dayData = emp.days[dateStr];
                      return (
                        <td key={dateStr} className="p-1.5 align-top" data-testid={`cell-${emp.id}-${dateStr}`}>
                          <DayCell
                            dayData={dayData}
                            employeeId={emp.id}
                            dateStr={dateStr}
                            onSlotClick={handleSlotClick}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="md:hidden space-y-3">
            {employees.map((emp) => {
              const dateStr = format(weekDates[mobileSelectedDay], "yyyy-MM-dd");
              const dayData = emp.days[dateStr];
              return (
                <Card key={emp.id} className="p-3" data-testid={`mobile-card-${emp.id}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                      {emp.displayName
                        .split(" ")
                        .map((n) => n[0])
                        .join("")
                        .slice(0, 2)}
                    </div>
                    <span className="text-sm font-medium">{emp.displayName}</span>
                  </div>
                  <DayCell
                    dayData={dayData}
                    employeeId={emp.id}
                    dateStr={dateStr}
                    onSlotClick={handleSlotClick}
                  />
                </Card>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-6 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300" />
          Frei (klicken für Erstberatung)
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-gray-100 border border-gray-300" />
          Gebucht
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-red-100 border border-red-300" />
          Abwesend
        </div>
      </div>
    </Layout>
  );
}

function DayCell({
  dayData,
  employeeId,
  dateStr,
  onSlotClick,
}: {
  dayData?: DayData;
  employeeId: number;
  dateStr: string;
  onSlotClick: (employeeId: number, date: string, time: string) => void;
}) {
  if (!dayData) {
    return <div className="text-xs text-muted-foreground text-center py-2">–</div>;
  }

  if (dayData.absence) {
    return (
      <div
        className={`rounded-md px-2 py-1.5 text-center text-xs font-medium ${
          dayData.absence === "urlaub"
            ? "bg-green-50 text-green-700 border border-green-200"
            : "bg-red-50 text-red-700 border border-red-200"
        }`}
        data-testid={`absence-${employeeId}-${dateStr}`}
      >
        <div className="flex items-center justify-center gap-1">
          {dayData.absence === "urlaub" ? (
            <Palmtree className="h-3 w-3" />
          ) : (
            <Thermometer className="h-3 w-3" />
          )}
          {dayData.absence === "urlaub" ? "Urlaub" : "Krank"}
        </div>
      </div>
    );
  }

  const hasContent =
    dayData.freeSlots.length > 0 || dayData.appointments.length > 0 || dayData.availability.length > 0;

  if (!hasContent) {
    return (
      <div className="text-xs text-muted-foreground text-center py-2">
        Keine Verfügbarkeit
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {dayData.freeSlots.map((slot, i) => (
        <button
          key={`free-${i}`}
          onClick={() => onSlotClick(employeeId, dateStr, slot.start)}
          className="w-full text-left px-2 py-1 rounded text-xs bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400 transition-colors cursor-pointer group"
          data-testid={`slot-free-${employeeId}-${dateStr}-${i}`}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{slot.start} – {slot.end}</span>
            <Plus className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </button>
      ))}
      {dayData.appointments.map((appt, i) => (
        <div
          key={`appt-${i}`}
          className="px-2 py-1 rounded text-xs bg-gray-50 border border-gray-200 text-gray-600"
          data-testid={`slot-booked-${employeeId}-${dateStr}-${i}`}
        >
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {appt.scheduledStart}
              {appt.scheduledEnd ? `–${appt.scheduledEnd}` : ""}
            </span>
          </div>
          <div className="truncate ml-4 text-gray-500">{appt.customerName}</div>
        </div>
      ))}
    </div>
  );
}
