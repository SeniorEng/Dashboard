import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

function PageSkeleton({ variant = "default" }: { variant?: "default" | "detail" | "list" }) {
  if (variant === "detail") {
    return (
      <div className="space-y-6" data-testid="skeleton-detail">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (variant === "list") {
    return (
      <div className="space-y-3" data-testid="skeleton-list">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-4 rounded-xl border border-border/40">
            <Skeleton className="h-10 w-10 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="skeleton-default">
      <div className="flex items-center gap-3 mb-6">
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export { Skeleton, PageSkeleton };
