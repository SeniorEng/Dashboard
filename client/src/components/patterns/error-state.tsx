/**
 * ErrorState Component
 * 
 * Consistent error state display with icon, title, description, and retry action.
 */

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw } from "lucide-react";
import { iconSize } from "@/design-system";

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = "Fehler beim Laden",
  description = "Die Daten konnten nicht geladen werden. Bitte versuchen Sie es erneut.",
  onRetry,
  retryLabel = "Erneut versuchen",
  className,
}: ErrorStateProps) {
  return (
    <div className={cn(
      "flex flex-col items-center justify-center py-12 text-center",
      className
    )} data-testid="error-state">
      <div className="text-red-400 mb-4">
        <AlertCircle className={iconSize["2xl"]} />
      </div>
      <h3 className="text-lg font-medium text-foreground mb-2">
        {title}
      </h3>
      <p className="text-muted-foreground mb-4 max-w-sm">
        {description}
      </p>
      {onRetry && (
        <Button
          variant="outline"
          onClick={onRetry}
          className="gap-2"
          data-testid="button-retry"
        >
          <RefreshCw className={iconSize.sm} />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
