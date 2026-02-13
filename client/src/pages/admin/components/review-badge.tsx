import { AlertTriangle, CalendarClock } from "lucide-react";
import { formatDateDisplay } from "@shared/utils/format";

export function getReviewStatus(reviewDueDate: string | null): "ok" | "warning" | "overdue" | "none" {
  if (!reviewDueDate) return "none";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(reviewDueDate + "T00:00:00");
  const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "overdue";
  if (diffDays <= 30) return "warning";
  return "ok";
}

export function ReviewBadge({ reviewDueDate }: { reviewDueDate: string | null }) {
  const status = getReviewStatus(reviewDueDate);
  if (status === "none") return null;

  const styles = {
    ok: "bg-green-100 text-green-700",
    warning: "bg-amber-100 text-amber-700",
    overdue: "bg-red-100 text-red-700",
  };

  const labels = {
    ok: `Prüfung bis ${formatDateDisplay(reviewDueDate!)}`,
    warning: `Prüfung fällig: ${formatDateDisplay(reviewDueDate!)}`,
    overdue: `Überfällig: ${formatDateDisplay(reviewDueDate!)}`,
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded inline-flex items-center gap-1 ${styles[status]}`}>
      {status === "overdue" && <AlertTriangle className="h-3 w-3" />}
      {status === "warning" && <CalendarClock className="h-3 w-3" />}
      {labels[status]}
    </span>
  );
}
