/**
 * Task #875 (Budget GF Phase 5) — Reconciliation classifier (R4/N7/I16).
 *
 * Beim Abschluss eines geplanten Termins werden die dokumentierten IST-Kosten
 * gegen den beim Planen geschriebenen HOLD abgeglichen. Es gibt genau drei
 * Fälle (north star „reconciliation cases a/b/c"):
 *
 *   (a) partial_capture   — IST ≤ Hold. Es wird nur der IST-Betrag gebucht,
 *                           der Rest des Holds wird FREIGEGEBEN (released).
 *   (b) same_pot_extend   — IST > Hold, aber der Mehrbetrag passt noch in die
 *                           freie Kapazität DERSELBEN Töpfe. Hold wird voll
 *                           gebucht + der Mehrbetrag zusätzlich aus den gleichen
 *                           Töpfen nachgezogen.
 *   (c) cross_pot_overflow — IST > Hold UND der Mehrbetrag übersteigt die freie
 *                           Kapazität der gleichen Töpfe. Der Überlauf braucht
 *                           den privaten (uncapped) Topf; fehlt der, ist es ein
 *                           harter Über-Budget-Abschluss (`OverBudgetCompletionError`).
 *
 * Pur & deterministisch — keine DB, keine Zeit. Vollständig golden-test-bar.
 * Alle Beträge in nicht-negativen Cent (Aufrufer klemmt vorher).
 */

export type ReconciliationCase =
  | "partial_capture"
  | "same_pot_extend"
  | "cross_pot_overflow";

export interface ReconciliationInput {
  /** Reservierter Gesamt-Hold in Cent. */
  holdCents: number;
  /** Dokumentierte Ist-Kosten in Cent. */
  actualCents: number;
  /**
   * Noch freie Kapazität in DENSELBEN (statutarischen) Töpfen ZUSÄTZLICH zum
   * Hold — d.h. die aktuell verfügbare Restkapazität dieser Töpfe (der Hold
   * selbst ist hier bereits abgezogen).
   */
  samePotHeadroomCents: number;
  /** Kann der Kunde Überlauf privat zahlen (uncapped Topf vorhanden)? */
  isPrivateCapable: boolean;
}

export interface ReconciliationResult {
  case: ReconciliationCase;
  /** In die statutarischen Töpfe zu buchender Betrag (Hold ± Anpassung). */
  captureCents: number;
  /** Anteil des Holds, der freigegeben wird (nur case a > 0). */
  releaseCents: number;
  /** Zusätzlich aus denselben Töpfen nachzuziehen (case b/c > 0). */
  extendCents: number;
  /** Überlauf, der den privaten Topf braucht (nur case c > 0). */
  overflowCents: number;
  /** Case c: privater Topf nötig. */
  requiresPrivatePot: boolean;
  /** Case c ohne Privatzahlungs-Fähigkeit ⇒ `OverBudgetCompletionError`. */
  hardBlocked: boolean;
}

function clampNonNegative(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function classifyReconciliation(
  input: ReconciliationInput,
): ReconciliationResult {
  const hold = clampNonNegative(input.holdCents);
  const actual = clampNonNegative(input.actualCents);
  const headroom = clampNonNegative(input.samePotHeadroomCents);

  // (a) IST ≤ Hold — Teil-Capture, Rest freigeben.
  if (actual <= hold) {
    return {
      case: "partial_capture",
      captureCents: actual,
      releaseCents: hold - actual,
      extendCents: 0,
      overflowCents: 0,
      requiresPrivatePot: false,
      hardBlocked: false,
    };
  }

  const delta = actual - hold;

  // (b) Mehrbetrag passt noch in die freie Kapazität derselben Töpfe.
  if (delta <= headroom) {
    return {
      case: "same_pot_extend",
      captureCents: actual,
      releaseCents: 0,
      extendCents: delta,
      overflowCents: 0,
      requiresPrivatePot: false,
      hardBlocked: false,
    };
  }

  // (c) Mehrbetrag übersteigt die freie Kapazität ⇒ Überlauf in privaten Topf.
  const overflow = delta - headroom;
  return {
    case: "cross_pot_overflow",
    captureCents: hold + headroom + (input.isPrivateCapable ? overflow : 0),
    releaseCents: 0,
    extendCents: headroom,
    overflowCents: overflow,
    requiresPrivatePot: true,
    hardBlocked: !input.isPrivateCapable,
  };
}
