import {
  Palmtree,
  Thermometer,
  Coffee,
  Briefcase,
  FileText,
} from "lucide-react";
import type { TimeEntryType } from "@/lib/api/types";
import { parseLocalDate } from "@shared/utils/datetime";

export const TIME_ENTRY_TYPE_CONFIG: Record<TimeEntryType, { label: string; icon: React.ElementType; color: string; bgColor: string }> = {
  urlaub: { label: "Urlaub", icon: Palmtree, color: "text-green-700", bgColor: "bg-green-100" },
  krankheit: { label: "Krankheit", icon: Thermometer, color: "text-red-700", bgColor: "bg-red-100" },
  pause: { label: "Pause", icon: Coffee, color: "text-amber-700", bgColor: "bg-amber-100" },
  bueroarbeit: { label: "Büroarbeit", icon: Briefcase, color: "text-blue-700", bgColor: "bg-blue-100" },
  vertrieb: { label: "Vertrieb", icon: Briefcase, color: "text-purple-700", bgColor: "bg-purple-100" },
  schulung: { label: "Schulung", icon: FileText, color: "text-indigo-700", bgColor: "bg-indigo-100" },
  besprechung: { label: "Besprechung", icon: FileText, color: "text-teal-700", bgColor: "bg-teal-100" },
  sonstiges: { label: "Sonstiges", icon: FileText, color: "text-gray-700", bgColor: "bg-gray-100" },
};

export const FULL_DAY_TYPES: TimeEntryType[] = ["urlaub", "krankheit"];

export const WEEKDAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

export const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

export function formatMinutesToHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}min`;
}

export function isEntryLocked(entryDate: string, entryType: string): boolean {
  const lockedTypes = ["urlaub", "krankheit"];
  if (!lockedTypes.includes(entryType)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const entry = parseLocalDate(entryDate);
  return entry < today;
}
