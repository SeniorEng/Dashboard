/**
 * SectionCard Component
 * 
 * Consistent card with optional header, icon, and actions.
 * Use for grouping related content.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SectionCardProps {
  title?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  variant?: "default" | "muted" | "tinted";
  noPadding?: boolean;
}

const variantClasses = {
  default: "bg-white",
  muted: "bg-white/80 backdrop-blur-sm",
  tinted: "bg-gray-50",
};

export function SectionCard({
  title,
  icon,
  actions,
  children,
  className,
  variant = "default",
  noPadding = false,
}: SectionCardProps) {
  const hasHeader = title || icon || actions;

  return (
    <Card className={cn(variantClasses[variant], className)}>
      {hasHeader && (
        <CardHeader className={cn(
          "flex flex-row items-center justify-between",
          noPadding ? "pb-0" : "pb-2"
        )}>
          <CardTitle className="text-sm font-medium text-gray-500 flex items-center gap-2">
            {icon}
            {title}
          </CardTitle>
          {actions}
        </CardHeader>
      )}
      <CardContent className={noPadding ? "p-0" : undefined}>
        {children}
      </CardContent>
    </Card>
  );
}
