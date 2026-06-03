import { formatGermanDate } from "@shared/utils/datetime";
import { WEEKDAY_NAMES_SHORT } from "../constants";

interface DayButtonProps {
  dayStr: string;
  day: Date;
  index: number;
  isSelected: boolean;
  isDayToday: boolean;
  appointmentCount: number;
  holidayName?: string;
  isWeekend: boolean;
  onSelect: (day: Date) => void;
}

export function DayButton({ dayStr, day, index, isSelected, isDayToday, appointmentCount, holidayName, isWeekend, onSelect }: DayButtonProps) {
  const hasAppointments = appointmentCount > 0;

  let bgClass: string;
  if (isSelected) {
    bgClass = holidayName
      ? "bg-red-600 text-white shadow-md"
      : "bg-primary text-primary-foreground shadow-md";
  } else if (holidayName) {
    bgClass = "bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100";
  } else if (isDayToday) {
    bgClass = hasAppointments ? "bg-primary/15 text-primary ring-1 ring-primary/30" : "bg-primary/10 text-primary hover:bg-primary/20";
  } else if (hasAppointments) {
    bgClass = "bg-primary/8 ring-1 ring-primary/20 hover:bg-primary/15";
  } else if (isWeekend) {
    bgClass = "bg-muted/30 text-muted-foreground hover:bg-muted/60";
  } else {
    bgClass = "bg-background hover:bg-muted";
  }

  return (
    <button
      onClick={() => onSelect(day)}
      className={`relative flex flex-col items-center justify-center flex-1 h-14 rounded-lg transition-all ${isWeekend && !isSelected ? "max-w-[32px]" : "max-w-[44px]"} ${bgClass}`}
      data-testid={`weekday-${dayStr}`}
      title={holidayName || undefined}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
        {WEEKDAY_NAMES_SHORT[index]}
      </span>
      <span className={`font-semibold ${isWeekend && !isSelected ? "text-sm" : "text-base"} ${isDayToday && !isSelected && !holidayName ? "text-primary" : ""}`}>
        {formatGermanDate(day, "d")}
      </span>
      <span className={`text-[9px] font-semibold leading-none h-[10px] flex items-center justify-center ${
        hasAppointments
          ? isSelected ? "text-white/80" : holidayName ? "text-red-600" : "text-primary"
          : holidayName
            ? isSelected ? "text-white/70" : "text-red-400"
            : isSelected ? "text-white/50" : isWeekend ? "text-muted-foreground/60" : "text-muted-foreground/45"
      }`}>
        {hasAppointments ? appointmentCount : holidayName ? "●" : 0}
      </span>
    </button>
  );
}
