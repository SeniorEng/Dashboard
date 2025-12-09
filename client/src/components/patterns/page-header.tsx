/**
 * PageHeader Component
 * 
 * Consistent page header with optional back button, title, subtitle, and actions.
 */

import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  backHref,
  backLabel,
  actions,
  badge,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex items-center justify-between gap-3 mb-6", className)}>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {backHref && (
          <Link href={backHref}>
            <Button 
              variant="ghost" 
              size="icon" 
              className="shrink-0"
              data-testid="button-back"
              aria-label={backLabel || "Zurück"}
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">{title}</h1>
          {subtitle && (
            <p className="text-sm text-gray-600 mt-0.5 truncate">{subtitle}</p>
          )}
          {badge && (
            <div className="flex items-center gap-2 mt-1">{badge}</div>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">{actions}</div>
      )}
    </div>
  );
}
