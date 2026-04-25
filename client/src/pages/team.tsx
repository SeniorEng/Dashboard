import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, Palmtree, Thermometer, Ban } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import { format, startOfWeek, addWeeks, subWeeks, addDays, isSameDay } from "date-fns";
import { de } from "date-fns/locale";
import { useAuth } from "@/hooks/use-auth";

interface FreeSlot { start: string; end: string }
interface BlockerSlot { startTime: string; endTime: string }
interface DayAppointment {
  scheduledStart: string | null;
  scheduledEnd: string | null;
  durationMinutes: number | null;
  customerName: string;
  status: string;
}
interface DayData {
  availability: { startTime: string | null; endTime: string | null }[];
  appointments: DayAppointment[];
  absence: "urlaub" | "krankheit" | null;
  blockers: "fullday" | BlockerSlot[] | null;
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

function timeToMin(t: string | null): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function dayLoadMinutes(day: DayData): number {
  let sum = 0;
  for (const appt of day.appointments) {
    const start = timeToMin(appt.scheduledStart);
    const end = timeToMin(appt.scheduledEnd);
    if (start !== null && end !== null && end > start) {
      sum += end - start;
    } else if (appt.durationMinutes && appt.durationMinutes > 0) {
      sum += appt.durationMinutes;
    }
  }
  return sum;
}

function formatHours(mins: number): string {
  if (mins <= 0) return "0h";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function TeamPage() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const today = new Date();
  const [currentWeekStart, setCurrentWeekStart] = useState(() => getWeekStart(today));

  const startDateStr = format(currentWeekStart, "yyyy-MM-dd");
  const weekDates = useMemo(
    () => Array.from({ length: 5 }, (_, i) => addDays(currentWeekStart, i)),
    [currentWeekStart]
  );

  const { data, isLoading } = useQuery<WeeklyAvailabilityResponse>({
    queryKey: ["team-weekly-availability", startDateStr],
    queryFn: async () => {
      const result = await api.get<WeeklyAvailabilityResponse>(
        `/team/weekly-availability?startDate=${startDateStr}&days=5`
      );
      return unwrapResult(result);
    },
    staleTime: 30000,
  });

  const employees = data?.employees ?? [];
  const dates = data?.dates ?? [];
  const isThisWeek = isSameDay(currentWeekStart, getWeekStart(today));

  return (
    <Layout>
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/")}
          aria-label="Zurück"
          data-testid="button-back"
        >
          <ArrowLeft className={iconSize.md} />
        </Button>
        <div>
          <h1 className={componentStyles.pageTitle} data-testid="text-page-title">Mein Team</h1>
          <p className="text-sm text-muted-foreground" data-testid="text-page-subtitle">
            Wöchentliche Verfügbarkeit & Auslastung deines Teams
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentWeekStart(subWeeks(currentWeekStart, 1))}
            data-testid="button-prev-week"
          >
            <ChevronLeft className={iconSize.sm} />
          </Button>
          <div className="text-sm font-medium px-2" data-testid="text-week-range">
            {format(currentWeekStart, "dd.MM.", { locale: de })} – {format(addDays(currentWeekStart, 4), "dd.MM.yyyy", { locale: de })}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentWeekStart(addWeeks(currentWeekStart, 1))}
            data-testid="button-next-week"
          >
            <ChevronRight className={iconSize.sm} />
          </Button>
          {!isThisWeek && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCurrentWeekStart(getWeekStart(today))}
              data-testid="button-this-week"
            >
              Diese Woche
            </Button>
          )}
        </div>
        <div className="text-xs text-muted-foreground" data-testid="text-team-size">
          {employees.length} Mitarbeiter
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : employees.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground" data-testid="text-empty-team">
          Aktuell sind dir keine Mitarbeiter zugeordnet.
        </Card>
      ) : (
        <div className="space-y-4">
          {employees.map((emp) => (
            <Card key={emp.id} className="p-4" data-testid={`card-employee-${emp.id}`}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold" data-testid={`text-employee-name-${emp.id}`}>
                  {emp.displayName}
                  {user && emp.id === user.id && (
                    <span className="ml-2 text-xs text-muted-foreground">(du)</span>
                  )}
                </h2>
              </div>

              <div className="grid grid-cols-5 gap-2">
                {dates.map((date, idx) => {
                  const day = emp.days[date];
                  const load = day ? dayLoadMinutes(day) : 0;
                  const dayLabel = DAY_NAMES_SHORT[idx] ?? format(weekDates[idx], "EEE", { locale: de });

                  return (
                    <div
                      key={date}
                      className="border border-border rounded-md p-2 min-h-[110px] flex flex-col"
                      data-testid={`cell-day-${emp.id}-${date}`}
                    >
                      <div className="text-xs font-medium text-muted-foreground mb-1">
                        {dayLabel} {format(weekDates[idx], "dd.MM.", { locale: de })}
                      </div>

                      {day?.absence === "urlaub" && (
                        <div className="flex items-center gap-1 text-xs text-amber-700" data-testid={`badge-urlaub-${emp.id}-${date}`}>
                          <Palmtree className="h-3 w-3" /> Urlaub
                        </div>
                      )}
                      {day?.absence === "krankheit" && (
                        <div className="flex items-center gap-1 text-xs text-red-700" data-testid={`badge-krankheit-${emp.id}-${date}`}>
                          <Thermometer className="h-3 w-3" /> Krank
                        </div>
                      )}
                      {day?.blockers === "fullday" && (
                        <div className="flex items-center gap-1 text-xs text-slate-700" data-testid={`badge-blocker-${emp.id}-${date}`}>
                          <Ban className="h-3 w-3" /> Blocker
                        </div>
                      )}

                      {!day?.absence && day?.blockers !== "fullday" && (
                        <>
                          <div className="text-xs text-foreground" data-testid={`text-load-${emp.id}-${date}`}>
                            Auslastung: <span className="font-medium">{formatHours(load)}</span>
                          </div>
                          <div className="text-xs text-muted-foreground" data-testid={`text-appointments-count-${emp.id}-${date}`}>
                            {day?.appointments.length ?? 0} Termine
                          </div>
                          {day?.freeSlots && day.freeSlots.length > 0 && (
                            <div className="mt-1 text-[10px] text-emerald-700" data-testid={`text-freeslots-${emp.id}-${date}`}>
                              Frei: {day.freeSlots.map((s) => `${s.start}–${s.end}`).join(", ")}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
    </Layout>
  );
}
