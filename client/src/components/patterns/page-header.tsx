/**
 * PageHeader Component
 * 
 * Responsive page header with optional back button, title, subtitle, badges and actions.
 * Stacks vertically on mobile with full-width buttons, horizontal layout on larger screens.
 */

import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { componentStyles } from "@/design-system";

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
    <div className={cn(componentStyles.pageHeader, className)}>
      {/* Top row: Back button + Title (always horizontal) */}
      <div className={componentStyles.pageHeaderTop}>
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
        <div className={componentStyles.pageHeaderTitleWrap}>
          <h1 className={componentStyles.pageTitle}>{title}</h1>
          {subtitle && (
            <p className={componentStyles.pageSubtitle}>{subtitle}</p>
          )}
          {badge && (
            <div className={componentStyles.pageHeaderBadges}>{badge}</div>
          )}
        </div>
      </div>
      
      {/* Actions: Full-width on mobile, inline on desktop */}
      {actions && (
        <div className={componentStyles.pageHeaderActions}>{actions}</div>
      )}
    </div>
  );
}
