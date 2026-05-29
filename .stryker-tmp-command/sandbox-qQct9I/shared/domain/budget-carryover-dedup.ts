/**
 * Task #601 / #684 / #716 — §45b-Carryover-Dedup als pure Funktion.
 *
 * Der manuelle Pfad (`upsertCarryoverAllocation`) und der automatische
 * Pfad (`ensureYearlyCarryover45b`) müssen dieselbe Dedup-Logik anwenden,
 * sonst entsteht eine Doppel-Anlage (Year-Dedup + Window-Dedup, siehe
 * Task #601). Beide rufen jetzt diesen pure Service.
 *
 * Wichtig (Task #684): Das Dedup-Set umfasst aktive UND soft-gelöschte
 * Zeilen — eine vom Admin gelöschte Carryover-Zeile ist ein expliziter
 * „nicht regenerieren"-Marker.
 */
// @ts-nocheck


export interface CarryoverWindow {
  targetYear: number;
  /** Inklusive (Y-01-01). */
  validFrom: string;
  /** Inklusive (Y-06-30, gem. SGB XI §45b Abs. 3). */
  expiresAt: string;
}

/**
 * Kanonisches Carryover-Fenster für ein Quelljahr.
 * `2024 → { targetYear: 2025, validFrom: "2025-01-01", expiresAt: "2025-06-30" }`.
 */
export function carryoverWindowFor(sourceYear: number): CarryoverWindow {
  const targetYear = sourceYear + 1;
  return {
    targetYear,
    validFrom: `${targetYear}-01-01`,
    expiresAt: `${targetYear}-06-30`,
  };
}

export interface ExistingCarryoverRow {
  year: number;
  validFrom: string;
  expiresAt: string | null;
}

/**
 * Liefert die beiden Dedup-Schlüssel-Sets (Year, Window), die der
 * Auto-Carryover-Pfad zum Skip-Check braucht.
 *
 * - `years` blockiert Doppel-Anlage neben einer manuell gesetzten Zeile,
 *   die ggf. mit `year = sourceYear` (Legacy-Konvention) statt `targetYear`
 *   geführt wird.
 * - `windows` ist der defensive Fallback gegen Convention-Drift — falls
 *   beide Pfade unterschiedliche `year`-Werte schreiben, kollidieren sie
 *   noch immer am identischen Gültigkeitsfenster.
 */
export function buildCarryoverDedupSets(
  existing: ReadonlyArray<ExistingCarryoverRow>,
): { years: ReadonlySet<number>; windows: ReadonlySet<string> } {
  return {
    years: new Set(existing.map(a => a.year)),
    windows: new Set(existing.map(a => `${a.validFrom}|${a.expiresAt ?? ""}`)),
  };
}

/**
 * Soll der Auto-Carryover für `sourceYear` einen Insert sparen, weil schon
 * eine Zeile (aktiv oder soft-deleted) für dieses Fenster existiert?
 */
export function shouldSkipAutoCarryover(
  existing: ReadonlyArray<ExistingCarryoverRow>,
  sourceYear: number,
): boolean {
  const win = carryoverWindowFor(sourceYear);
  const windowKey = `${win.validFrom}|${win.expiresAt}`;
  return existing.some(
    a => a.year === win.targetYear || `${a.validFrom}|${a.expiresAt ?? ""}` === windowKey,
  );
}
