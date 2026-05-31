/**
 * Task #875 (Budget GF Phase 5) — Reservation/Ledger state machine (I3).
 *
 * Holds (`budget_reservations`) und Ledger-Buchungen (`budget_ledger`) sind
 * Zustands-Automaten mit STRENG erlaubten Übergängen. Jeder mutierende
 * Storage-Pfad MUSS seinen Übergang hier validieren, damit kein illegaler
 * Sprung (z.B. captured → released, oder reversed → consumed) je persistiert
 * werden kann. Pur & deterministisch — keine DB, keine Zeit.
 *
 * Reservierungs-Lebenszyklus:
 *
 *     hold ──capture──▶ captured   (Abschluss: Hold wird zur Ledger-Buchung)
 *      │
 *      ├──release────▶ released    (Storno/Reschedule/Reopen: Hold freigeben)
 *      │
 *      └──expire─────▶ expired     (Lifecycle-Sweep: verwaister/abgelaufener Hold)
 *
 * `captured`, `released`, `expired` sind TERMINAL — von dort gibt es keinen
 * weiteren Übergang (R5 post-or-void-once). Ein erneuter Reschedule legt einen
 * NEUEN Hold an, statt einen terminalen wiederzubeleben.
 */
import type {
  BudgetReservationState,
  BudgetLedgerState,
} from "../../schema/budget";

const RESERVATION_TRANSITIONS: Record<
  BudgetReservationState,
  ReadonlyArray<BudgetReservationState>
> = {
  hold: ["captured", "released", "expired"],
  captured: [],
  released: [],
  expired: [],
};

const LEDGER_TRANSITIONS: Record<
  BudgetLedgerState,
  ReadonlyArray<BudgetLedgerState>
> = {
  // Eine `consumed`-Zeile kann nur durch eine SEPARATE `reversed`-Zeile
  // storniert werden (append-only); der Übergang beschreibt die logische
  // Beziehung, nicht ein In-Place-Update.
  consumed: ["reversed"],
  reversed: [],
};

export function isValidReservationTransition(
  from: BudgetReservationState,
  to: BudgetReservationState,
): boolean {
  return (RESERVATION_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalReservationState(
  state: BudgetReservationState,
): boolean {
  return (RESERVATION_TRANSITIONS[state] ?? []).length === 0;
}

/**
 * Wirft, wenn der Übergang nicht erlaubt ist. Aufrufer im Storage-Layer rufen
 * dies VOR jeder State-Mutation auf, damit ein illegaler Sprung früh und
 * typsicher scheitert (statt eine inkonsistente Zeile zu persistieren).
 */
export function assertReservationTransition(
  from: BudgetReservationState,
  to: BudgetReservationState,
): void {
  if (!isValidReservationTransition(from, to)) {
    throw new Error(
      `Ungültiger Reservierungs-Übergang: ${from} → ${to}. ` +
        `Erlaubt ab '${from}': ${(RESERVATION_TRANSITIONS[from] ?? []).join(", ") || "(terminal)"}.`,
    );
  }
}

export function isValidLedgerTransition(
  from: BudgetLedgerState,
  to: BudgetLedgerState,
): boolean {
  return (LEDGER_TRANSITIONS[from] ?? []).includes(to);
}

export function assertLedgerTransition(
  from: BudgetLedgerState,
  to: BudgetLedgerState,
): void {
  if (!isValidLedgerTransition(from, to)) {
    throw new Error(
      `Ungültiger Ledger-Übergang: ${from} → ${to}. ` +
        `Erlaubt ab '${from}': ${(LEDGER_TRANSITIONS[from] ?? []).join(", ") || "(terminal)"}.`,
    );
  }
}
