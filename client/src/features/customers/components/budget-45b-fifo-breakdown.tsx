import { formatEuroDE } from "@shared/utils/money";
import { formatDateForDisplay } from "@shared/utils/datetime";
import type { BudgetFifo45bBreakdownDTO, BudgetFifoPotDTO } from "@shared/api/budget";

/**
 * Task #1129 — read-only §45b FIFO-Aufschlüsselung.
 *
 * Zeigt die zwei §45b-Töpfe in FIFO-Reihenfolge (Vorjahres-Übertrag zuerst,
 * dann laufendes Jahr) je als segmentierten Balken: abgerechnet · dokumentiert ·
 * sonstiger Verbrauch · geplant/blockiert (Holds) · frei. Keine eigene
 * Berechnung — alle Werte stammen aus `/budget/:id/fifo-breakdown`, dessen
 * Summen exakt mit den §45b-Kartenzahlen rekonzilieren.
 */

const SEGMENTS = [
  { key: "consumedBilledCents", label: "Abgerechnet", color: "bg-primary" },
  { key: "consumedDocumentedCents", label: "Dokumentiert", color: "bg-primary/55" },
  { key: "consumedOtherCents", label: "Sonstiger Verbrauch", color: "bg-primary/25" },
  { key: "plannedCents", label: "Geplant / blockiert", color: "bg-amber-400" },
  { key: "remainingCents", label: "Frei", color: "bg-muted-foreground/20" },
] as const;

const POT_LABEL: Record<BudgetFifoPotDTO["potType"], string> = {
  carryover: "Vorjahres-Übertrag",
  current_year: "Laufendes Jahr",
};

function pct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function PotBar({ pot, expiresAt }: { pot: BudgetFifoPotDTO; expiresAt: string | null }) {
  const allocated = pot.allocatedCents;
  return (
    <div data-testid={`fifo-pot-${pot.potType}`}>
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-xs font-medium">
          {POT_LABEL[pot.potType]}
          {pot.potType === "carryover" && expiresAt && (
            <span className="text-muted-foreground font-normal" data-testid="fifo-carryover-expiry">
              {" "}· verfällt {formatDateForDisplay(expiresAt)}
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground" data-testid={`fifo-pot-allocated-${pot.potType}`}>
          {formatEuroDE(allocated)}
        </span>
      </div>
      <div className="flex w-full h-2.5 rounded-full overflow-hidden bg-muted" data-testid={`fifo-bar-${pot.potType}`}>
        {SEGMENTS.map((seg) => {
          const value = pot[seg.key];
          if (value <= 0) return null;
          return (
            <div
              key={seg.key}
              className={seg.color}
              style={{ width: `${pct(value, allocated)}%` }}
              data-testid={`fifo-seg-${pot.potType}-${seg.key}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-muted-foreground">
        {SEGMENTS.map((seg) => {
          const value = pot[seg.key];
          if (value <= 0) return null;
          return (
            <span key={seg.key} className="flex items-center gap-1">
              <span className={`inline-block w-2 h-2 rounded-sm ${seg.color}`} />
              {seg.label}: <span className="font-medium text-foreground" data-testid={`fifo-val-${pot.potType}-${seg.key}`}>{formatEuroDE(value)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function Budget45bFifoBreakdown({ data }: { data: BudgetFifo45bBreakdownDTO }) {
  const pots = data.pots.filter((p) => p.allocatedCents > 0);
  if (pots.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t space-y-3" data-testid="fifo-breakdown">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Aufschlüsselung (FIFO)</span>
        <span className="text-[11px] text-muted-foreground">
          {formatEuroDE(data.totalAvailableCents)} von {formatEuroDE(data.totalAllocatedCents)} frei
        </span>
      </div>
      {pots.map((pot) => (
        <PotBar key={pot.potType} pot={pot} expiresAt={data.carryoverExpiresAt} />
      ))}
    </div>
  );
}
