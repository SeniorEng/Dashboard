import { useState } from "react";

interface SparklineProps {
  values: number[];
  /** Optional `YYYY-MM` strings, one per value. When provided, a month axis and
   *  hover-tooltip are rendered, and points after the current month are greyed. */
  periods?: string[];
  width?: number;
  height?: number;
  color?: string;
  testId?: string;
}

const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function currentPeriodKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function Sparkline({ values, periods, width, height = 28, color = "currentColor", testId }: SparklineProps) {
  const hasAxis = !!periods && periods.length === values.length && values.length > 1;
  const w = width ?? (hasAxis ? 140 : 96);
  const axisH = hasAxis ? 12 : 0;
  const totalH = height + axisH;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!values || values.length === 0) {
    return <div className="text-xs text-muted-foreground" style={{ width: w, height: totalH }} data-testid={testId}>—</div>;
  }

  // Compute "today" cutoff: index of the last period <= current month.
  let cutoff = values.length - 1;
  if (hasAxis) {
    const now = currentPeriodKey();
    let last = -1;
    for (let i = 0; i < periods!.length; i++) {
      if (periods![i] <= now) last = i;
    }
    cutoff = last >= 0 ? last : -1; // -1 → all future
  }

  // Range based on past values only (so future zeros don't distort the axis).
  const visibleValues = hasAxis && cutoff >= 0 ? values.slice(0, cutoff + 1) : values;
  const min = Math.min(...visibleValues);
  const max = Math.max(...visibleValues);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;

  const coords = values.map((v, i) => {
    const x = i * stepX;
    const clamped = Math.max(min, Math.min(max, v));
    const y = height - ((clamped - min) / range) * (height - 4) - 2;
    return { x, y };
  });

  const pastPoints = cutoff >= 0
    ? coords.slice(0, cutoff + 1).map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")
    : "";
  const futurePoints = hasAxis && cutoff < values.length - 1
    ? coords.slice(Math.max(cutoff, 0)).map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")
    : "";

  const lastReal = cutoff >= 0 ? coords[cutoff] : null;

  const tooltip = hoverIdx !== null && hasAxis ? (() => {
    const period = periods![hoverIdx];
    const [yStr, mStr] = period.split("-");
    const m = parseInt(mStr, 10);
    return `${MONTH_NAMES[m - 1]} ${yStr} · ${values[hoverIdx]}`;
  })() : null;

  const tooltipLeft = hoverIdx !== null ? coords[hoverIdx].x : 0;

  return (
    <div className="relative inline-block leading-none" style={{ width: w }} data-testid={testId}>
      <svg width={w} height={totalH} viewBox={`0 0 ${w} ${totalH}`} className="overflow-visible block">
        {pastPoints && (
          <polyline
            points={pastPoints}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {futurePoints && (
          <polyline
            points={futurePoints}
            fill="none"
            stroke={color}
            strokeOpacity={0.25}
            strokeDasharray="2,2"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {lastReal && <circle cx={lastReal.x} cy={lastReal.y} r={2} fill={color} />}

        {hasAxis && coords.map((c, i) => (
          <circle
            key={`hit-${i}`}
            cx={c.x}
            cy={c.y}
            r={Math.max(stepX / 2, 6)}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            style={{ cursor: "pointer" }}
          />
        ))}

        {hoverIdx !== null && hasAxis && (
          <circle
            cx={coords[hoverIdx].x}
            cy={coords[hoverIdx].y}
            r={3}
            fill={color}
            stroke="white"
            strokeWidth={1}
            style={{ pointerEvents: "none" }}
          />
        )}

        {hasAxis && periods!.map((p, i) => {
          const m = parseInt(p.split("-")[1] ?? "0", 10);
          const isFuture = i > cutoff;
          // Anchor first/last labels at the edge so they don't get clipped.
          const anchor = i === 0 ? "start" : i === periods!.length - 1 ? "end" : "middle";
          return (
            <text
              key={`lbl-${i}`}
              x={i * stepX}
              y={totalH - 2}
              fontSize="7"
              textAnchor={anchor}
              fill={isFuture ? "#cbd5e1" : "#94a3b8"}
              style={{ userSelect: "none" }}
            >
              {MONTH_LETTERS[m - 1] ?? ""}
            </text>
          );
        })}
      </svg>
      {tooltip && (
        <div
          className="absolute z-10 whitespace-nowrap rounded bg-gray-900 text-white text-[10px] px-1.5 py-0.5 pointer-events-none shadow"
          style={{ left: tooltipLeft, top: -20, transform: "translateX(-50%)" }}
          data-testid={testId ? `${testId}-tooltip` : undefined}
        >
          {tooltip}
        </div>
      )}
    </div>
  );
}
export { Sparkline };
