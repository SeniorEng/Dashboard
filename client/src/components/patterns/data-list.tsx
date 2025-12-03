/**
 * DataList Components
 * 
 * Consistent list styling for displaying data items.
 */

import { cn } from "@/lib/utils";

interface DataListProps {
  children: React.ReactNode;
  className?: string;
  gap?: "sm" | "md" | "lg";
}

const gapClasses = {
  sm: "space-y-2",
  md: "space-y-3",
  lg: "space-y-4",
};

export function DataList({ 
  children, 
  className,
  gap = "md" 
}: DataListProps) {
  return (
    <div className={cn(gapClasses[gap], className)}>
      {children}
    </div>
  );
}

interface DataListItemProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  interactive?: boolean;
}

export function DataListItem({ 
  children, 
  className,
  onClick,
  interactive = false,
}: DataListItemProps) {
  const Component = onClick ? "button" : "div";
  
  return (
    <Component
      onClick={onClick}
      className={cn(
        "w-full text-left p-4 rounded-xl bg-white shadow-sm border border-gray-100",
        (onClick || interactive) && "hover:shadow-md transition-shadow cursor-pointer",
        className
      )}
    >
      {children}
    </Component>
  );
}
