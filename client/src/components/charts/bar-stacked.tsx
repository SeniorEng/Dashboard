export function BarStacked({ segments, max }: { segments: { value: number; color: string }[]; max: number }) {
  return (
    <div className="w-full bg-gray-100 rounded-full h-2.5 flex overflow-hidden">
      {segments.map((seg, i) => {
        const width = max > 0 ? Math.min((seg.value / max) * 100, 100) : 0;
        if (width === 0) return null;
        return (
          <div
            key={i}
            className={`h-2.5 ${seg.color} transition-all ${i === 0 ? "rounded-l-full" : ""} ${i === segments.length - 1 || segments.slice(i + 1).every(s => s.value === 0) ? "rounded-r-full" : ""}`}
            style={{ width: `${width}%` }}
          />
        );
      })}
    </div>
  );
}
