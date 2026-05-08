import { PROSPECT_STATUSES, PROSPECT_STATUS_LABELS } from "@shared/schema";

export function PipelineStats({ stats, activeStatus, onStatusClick }: { stats: Record<string, number>; activeStatus: string; onStatusClick: (status: string) => void }) {
  return (
    <div className="grid grid-cols-3 md:grid-cols-9 gap-2 mb-4" data-testid="pipeline-stats">
      {PROSPECT_STATUSES.map((status) => (
        <div
          key={status}
          onClick={() => onStatusClick(status)}
          className={`flex flex-col items-center justify-start text-center px-1.5 py-2 rounded-lg border min-h-[72px] md:min-h-[76px] cursor-pointer transition-all ${
            activeStatus === status
              ? "bg-primary/10 border-primary ring-2 ring-primary/30"
              : "bg-white/60 hover:bg-white/80"
          }`}
          data-testid={`stat-box-${status}`}
        >
          <div className="text-lg font-bold leading-none mb-1" data-testid={`stat-count-${status}`}>
            {stats[status] || 0}
          </div>
          <div className="text-[10px] md:text-xs leading-tight text-muted-foreground break-words hyphens-auto w-full">
            {PROSPECT_STATUS_LABELS[status]}
          </div>
        </div>
      ))}
    </div>
  );
}
