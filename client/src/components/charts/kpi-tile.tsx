import { ReactNode } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { Sparkline } from "./sparkline";

interface KpiTileProps {
  title: string;
  icon?: ReactNode;
  value: string;
  subValue?: string;
  delta?: { abs: number | null; pct: number | null };
  deltaLabel?: string;
  /** Higher is better (true) or lower is better (false). Affects coloring of trend arrow. */
  higherIsBetter?: boolean;
  sparkline?: number[];
  sparklineColor?: string;
  href?: string;
  testId: string;
  children?: ReactNode;
  badge?: { label: string; className: string };
  footer?: ReactNode;
}

function deltaColor(delta: number | null | undefined, higherIsBetter: boolean): string {
  if (delta == null || delta === 0) return "text-gray-500";
  const positive = delta > 0;
  const good = higherIsBetter ? positive : !positive;
  return good ? "text-emerald-600" : "text-red-600";
}

export function KpiTile({
  title,
  icon,
  value,
  subValue,
  delta,
  deltaLabel = "Vormonat",
  higherIsBetter = true,
  sparkline,
  sparklineColor = "#0d9488",
  href,
  testId,
  children,
  badge,
  footer,
}: KpiTileProps) {
  const content = (
    <Card
      className={`h-full transition-all ${href ? "hover:shadow-md hover:border-teal-300 cursor-pointer" : ""}`}
      data-testid={testId}
    >
      <CardContent className="p-5 flex flex-col h-full">
        <div className="flex items-center gap-2 mb-2">
          {icon && <div className="text-teal-600 shrink-0">{icon}</div>}
          <span className="font-semibold text-sm">{title}</span>
          {badge && (
            <span
              className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium ${badge.className}`}
              data-testid={`${testId}-badge`}
            >
              {badge.label}
            </span>
          )}
        </div>

        <div className="flex items-baseline gap-2 flex-wrap mb-1">
          <span className="text-2xl sm:text-3xl font-bold" data-testid={`${testId}-value`}>{value}</span>
          {subValue && (
            <span className="text-xs text-muted-foreground" data-testid={`${testId}-subvalue`}>{subValue}</span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 mt-auto pt-2">
          <div className="min-w-0">
            {delta && delta.abs !== null && (
              <div
                className={`flex items-center gap-0.5 text-xs ${deltaColor(delta.abs, higherIsBetter)}`}
                data-testid={`${testId}-delta`}
              >
                {delta.abs > 0
                  ? <ArrowUpRight className="w-3.5 h-3.5" />
                  : delta.abs < 0
                  ? <ArrowDownRight className="w-3.5 h-3.5" />
                  : <Minus className="w-3.5 h-3.5" />}
                <span className="font-medium">
                  {delta.abs > 0 ? "+" : ""}{delta.abs}
                  {delta.pct !== null && ` (${delta.pct > 0 ? "+" : ""}${delta.pct}%)`}
                </span>
                <span className="text-muted-foreground ml-1">{deltaLabel}</span>
              </div>
            )}
            {delta && delta.abs === null && (
              <div className="text-xs text-muted-foreground" data-testid={`${testId}-delta-empty`}>
                Kein Vergleichswert
              </div>
            )}
          </div>
          {sparkline && sparkline.length > 0 && (
            <div className="shrink-0" style={{ color: sparklineColor }}>
              <Sparkline values={sparkline} testId={`${testId}-sparkline`} color={sparklineColor} />
            </div>
          )}
        </div>

        {children && <div className="mt-3 pt-3 border-t border-border/60">{children}</div>}
        {footer && <div className="mt-3 pt-3 border-t border-border/60 text-xs">{footer}</div>}
      </CardContent>
    </Card>
  );

  if (href) {
    return (
      <Link href={href} data-testid={`${testId}-link`} className="block h-full">
        {content}
      </Link>
    );
  }
  return content;
}
