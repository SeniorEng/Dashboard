/**
 * StatusBadge Component
 * 
 * Semantic badge for displaying status, Pflegegrad, or service type.
 */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { 
  getStatusColors, 
  getServiceColors, 
  getPflegegradColors 
} from "@/design-system";
import { 
  Clock, 
  Play, 
  FileText, 
  CheckCircle2, 
  XCircle,
  Heart,
} from "lucide-react";

interface StatusBadgeProps {
  type: "status" | "service" | "pflegegrad";
  value: string | number;
  showIcon?: boolean;
  className?: string;
}

const statusLabels: Record<string, string> = {
  scheduled: "Geplant",
  "in-progress": "Unterwegs",
  documenting: "Dokumentation",
  completed: "Abgeschlossen",
  cancelled: "Abgesagt",
};

const statusIcons: Record<string, React.ReactNode> = {
  scheduled: <Clock className="h-3 w-3" />,
  "in-progress": <Play className="h-3 w-3" />,
  documenting: <FileText className="h-3 w-3" />,
  completed: <CheckCircle2 className="h-3 w-3" />,
  cancelled: <XCircle className="h-3 w-3" />,
};

const serviceLabels: Record<string, string> = {
  hauswirtschaft: "Hauswirtschaft",
  alltagsbegleitung: "Alltagsbegleitung",
  erstberatung: "Erstberatung",
};

export function StatusBadge({
  type,
  value,
  showIcon = true,
  className,
}: StatusBadgeProps) {
  if (type === "status") {
    const status = String(value);
    const colors = getStatusColors(status);
    const label = statusLabels[status] || status;
    const icon = statusIcons[status];

    return (
      <Badge 
        variant="outline" 
        className={cn(colors.bg, colors.text, colors.border, className)}
      >
        {showIcon && icon && <span className="mr-1">{icon}</span>}
        {label}
      </Badge>
    );
  }

  if (type === "service") {
    const service = String(value);
    const colors = getServiceColors(service);
    const label = serviceLabels[service] || service;

    return (
      <Badge 
        variant="outline" 
        className={cn(colors.bgLight, colors.text, colors.border, className)}
      >
        {label}
      </Badge>
    );
  }

  if (type === "pflegegrad") {
    const pg = Number(value);
    if (pg === 0) return null;
    
    const colors = getPflegegradColors(pg);

    return (
      <Badge 
        variant="outline" 
        className={cn(colors.bg, colors.text, colors.border, className)}
      >
        {showIcon && <Heart className="h-3 w-3 mr-1" />}
        PG {pg}
      </Badge>
    );
  }

  return null;
}
