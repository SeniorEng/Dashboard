/**
 * Task #1177 (Phase 3) — Übergeordnete Pipeline-Ansicht:
 * Interessent → In Anlage → Aktiv.
 *
 * Zeigt die drei Lebenszyklus-Stufen eines Kunden als Funnel. Die Zahlen
 * werden aus vorhandenen Quellen abgeleitet (Prospect-Stats, „in Anlage"-
 * Zähler, aktive Kunden mit Vertrag) — kein neuer Status-Store.
 */
import { useMemo } from "react";
import { useLocation } from "wouter";
import { ChevronRight, Users, ClipboardList, UserCheck } from "lucide-react";
import { iconSize } from "@/design-system";
import { useCustomers, useInIntakeCount } from "@/features/customers";

export function PipelineFunnel({ prospectStats }: { prospectStats?: Record<string, number> }) {
  const [, navigate] = useLocation();
  const { data: inIntakeData } = useInIntakeCount();
  const { data: activeData } = useCustomers({ status: "aktiv", hasActiveContract: "true", limit: 1 });

  const prospectCount = useMemo(
    () => Object.values(prospectStats ?? {}).reduce((sum, n) => sum + (n || 0), 0),
    [prospectStats],
  );
  const inIntakeCount = inIntakeData?.count ?? 0;
  const activeCount = activeData?.total ?? 0;

  const stages = [
    {
      key: "prospects",
      label: "Interessenten",
      count: prospectCount,
      icon: Users,
      onClick: () => navigate("/admin/prospects"),
      classes: "bg-blue-50 border-blue-200 text-blue-800",
    },
    {
      key: "in-intake",
      label: "In Anlage",
      count: inIntakeCount,
      icon: ClipboardList,
      onClick: () => navigate("/admin/customers"),
      classes: "bg-teal-50 border-teal-200 text-teal-800",
    },
    {
      key: "active",
      label: "Aktiv",
      count: activeCount,
      icon: UserCheck,
      onClick: () => navigate("/admin/customers"),
      classes: "bg-green-50 border-green-200 text-green-800",
    },
  ] as const;

  return (
    <div className="flex items-stretch gap-2 mb-4" data-testid="pipeline-funnel">
      {stages.map((stage, idx) => (
        <div key={stage.key} className="flex items-stretch flex-1 gap-2">
          <button
            type="button"
            onClick={stage.onClick}
            className={`flex-1 flex flex-col items-start justify-center px-4 py-3 rounded-lg border transition-colors hover:brightness-95 ${stage.classes}`}
            data-testid={`funnel-stage-${stage.key}`}
          >
            <div className="flex items-center gap-2 mb-1">
              <stage.icon className={iconSize.sm} />
              <span className="text-xs font-medium">{stage.label}</span>
            </div>
            <span className="text-2xl font-bold leading-none" data-testid={`funnel-count-${stage.key}`}>
              {stage.count}
            </span>
          </button>
          {idx < stages.length - 1 && (
            <div className="flex items-center text-muted-foreground">
              <ChevronRight className={iconSize.md} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
