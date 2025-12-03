/**
 * PageShell Component
 * 
 * Consistent page wrapper with standard background and container.
 * Use this instead of ad-hoc page backgrounds.
 */

import { cn } from "@/lib/utils";

interface PageShellProps {
  children: React.ReactNode;
  className?: string;
  maxWidth?: "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl";
}

const maxWidthClasses = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
};

export function PageShell({ 
  children, 
  className,
  maxWidth = "4xl" 
}: PageShellProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
      <div className={cn(
        "container mx-auto px-4 py-6",
        maxWidthClasses[maxWidth],
        className
      )}>
        {children}
      </div>
    </div>
  );
}
