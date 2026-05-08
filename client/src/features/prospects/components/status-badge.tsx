import { Badge } from "@/components/ui/badge";
import { PROSPECT_STATUS_LABELS, type ProspectStatus } from "@shared/schema";
import { STATUS_COLORS } from "./prospect-status-constants";

export function StatusBadge({ status }: { status: string }) {
  const label = PROSPECT_STATUS_LABELS[status as ProspectStatus] || status;
  const colorClass = STATUS_COLORS[status as ProspectStatus] || "bg-gray-100 text-gray-800";
  return <Badge className={`${colorClass} font-medium`} data-testid={`badge-status-${status}`}>{label}</Badge>;
}
