import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { colors, getStatusColors, getServiceColors, getPflegegradColors } from "@/design-system";
import {
  Clock,
  Play,
  FileText,
  CheckCircle2,
  XCircle,
  Heart,
  Lock,
  Bot,
} from "lucide-react";

type BadgeColor = keyof typeof colors.badge;

type StatusBadgeType =
  | "status"
  | "service"
  | "pflegegrad"
  | "record"
  | "contract"
  | "activity"
  | "billable"
  | "system"
  | "month"
  | "info"
  | "warning"
  | "counter"
  | "need";

interface StatusBadgeProps {
  type: StatusBadgeType;
  value: string | number;
  showIcon?: boolean;
  size?: "sm" | "default";
  className?: string;
  "data-testid"?: string;
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

const recordLabels: Record<string, string> = {
  undocumented: "Termine offen",
  ready: "Bereit",
  pending: "Warte auf Unterschrift",
  employee_signed: "Warte auf Kundenunterschrift",
  completed: "Abgeschlossen",
};

const recordColors: Record<string, BadgeColor> = {
  undocumented: "red",
  ready: "emerald",
  pending: "amber",
  employee_signed: "blue",
  completed: "green",
};

const contractLabels: Record<string, string> = {
  active: "Aktiv",
  paused: "Pausiert",
  ended: "Beendet",
};

const contractColors: Record<string, BadgeColor> = {
  active: "green",
  paused: "amber",
  ended: "gray",
};

const activityLabels: Record<string, string> = {
  active: "Aktiv",
  inactive: "Inaktiv",
};

const activityColors: Record<string, BadgeColor> = {
  active: "green",
  inactive: "gray",
};

const billableLabels: Record<string, string> = {
  billable: "Abrechenbar",
  "not-billable": "Nicht abrechenbar",
};

const billableColors: Record<string, BadgeColor> = {
  billable: "green",
  "not-billable": "gray",
};

const systemLabels: Record<string, string> = {
  system: "System",
  default: "Standard",
};

const systemColors: Record<string, BadgeColor> = {
  system: "purple",
  default: "blue",
};

const monthLabels: Record<string, string> = {
  open: "Offen",
  closed: "Abgeschlossen",
};

const monthColors: Record<string, BadgeColor> = {
  open: "amber",
  closed: "green",
};

const monthIcons: Record<string, React.ReactNode> = {
  open: <Clock className="h-3 w-3" />,
  closed: <CheckCircle2 className="h-3 w-3" />,
};

function getBadgeColorClasses(color: BadgeColor) {
  const c = colors.badge[color];
  return `${c.bg} ${c.text} ${c.border}`;
}

function renderColoredBadge(
  label: string,
  color: BadgeColor,
  icon: React.ReactNode | null,
  showIcon: boolean,
  size: "sm" | "default",
  className?: string,
  testId?: string,
) {
  return (
    <Badge
      variant="outline"
      className={cn(
        getBadgeColorClasses(color),
        size === "sm" && "text-[10px] px-1.5 py-0",
        className,
      )}
      data-testid={testId}
    >
      {showIcon && icon && <span className="mr-1">{icon}</span>}
      {label}
    </Badge>
  );
}

export function StatusBadge({
  type,
  value,
  showIcon = true,
  size = "default",
  className,
  "data-testid": testId,
}: StatusBadgeProps) {
  const v = String(value);

  if (type === "status") {
    const c = getStatusColors(v);
    return (
      <Badge
        variant="outline"
        className={cn(c.bg, c.text, c.border, size === "sm" && "text-[10px] px-1.5 py-0", className)}
        data-testid={testId}
      >
        {showIcon && statusIcons[v] && <span className="mr-1">{statusIcons[v]}</span>}
        {statusLabels[v] || v}
      </Badge>
    );
  }

  if (type === "service") {
    const c = getServiceColors(v);
    return (
      <Badge
        variant="outline"
        className={cn(c.bgLight, c.text, c.border, size === "sm" && "text-[10px] px-1.5 py-0", className)}
        data-testid={testId}
      >
        {serviceLabels[v] || v}
      </Badge>
    );
  }

  if (type === "pflegegrad") {
    const pg = Number(value);
    if (pg === 0) return null;
    const c = getPflegegradColors(pg);
    return (
      <Badge
        variant="outline"
        className={cn(c.bg, c.text, c.border, size === "sm" && "text-[10px] px-1.5 py-0", className)}
        data-testid={testId}
      >
        {showIcon && <Heart className="h-3 w-3 mr-1" />}
        PG {pg}
      </Badge>
    );
  }

  if (type === "record") {
    const color = recordColors[v] || "gray";
    return renderColoredBadge(recordLabels[v] || v, color, null, false, size, className, testId);
  }

  if (type === "contract") {
    return renderColoredBadge(contractLabels[v] || v, contractColors[v] || "gray", null, false, size, className, testId);
  }

  if (type === "activity") {
    return renderColoredBadge(activityLabels[v] || v, activityColors[v] || "gray", null, false, size, className, testId);
  }

  if (type === "billable") {
    return renderColoredBadge(billableLabels[v] || v, billableColors[v] || "gray", null, false, size, className, testId);
  }

  if (type === "system") {
    return renderColoredBadge(systemLabels[v] || v, systemColors[v] || "purple", null, false, size, className, testId);
  }

  if (type === "month") {
    const icon = monthIcons[v] || null;
    return renderColoredBadge(monthLabels[v] || v, monthColors[v] || "gray", icon, showIcon, size, className, testId);
  }

  if (type === "info") {
    return renderColoredBadge(v, "teal", null, false, size, className, testId);
  }

  if (type === "warning") {
    return renderColoredBadge(v, "amber", null, false, size, className, testId);
  }

  if (type === "need") {
    return renderColoredBadge(v, "rose", null, false, size, className, testId);
  }

  if (type === "counter") {
    return (
      <Badge
        variant="outline"
        className={cn(getBadgeColorClasses("teal"), size === "sm" && "text-[10px] px-1.5 py-0", className)}
        data-testid={testId}
      >
        {value}
      </Badge>
    );
  }

  return null;
}
