/**
 * Task #873 (Budget GF Phase 3) — Typisierte Hard-Block-Ablehnung.
 *
 * Wird geworfen, wenn die statutorische Topf-Kaskade (`planCascade`) einen Rest
 * (`outstandingCents > 0`) lässt UND der Kunde keinen privaten (uncapped) Topf
 * besitzt — d.h. Pflegekasse ohne Privatabrechnung. Vor Phase 3 war dies ein
 * generischer `Error`; die Routen entschieden allein über `message.includes(
 * "Budget reicht nicht")`. Diese Klasse macht die Ablehnung typsicher
 * unterscheidbar (Invariante I5), behält aber die exakte deutsche Meldung bei,
 * damit die bestehenden Routen-Checks (`appointment-documentation.ts`,
 * `appointment-import.ts`) unverändert greifen.
 */
import { formatEuroDE } from "../../utils/money";

export class BudgetHardBlockError extends Error {
  /** Stabiler Maschinen-Code für typsichere Unterscheidung. */
  readonly code = "BUDGET_HARD_BLOCK" as const;
  /** Fehlbetrag in Cent, der nicht gedeckt werden konnte. */
  readonly shortfallCents: number;

  constructor(shortfallCents: number) {
    super(
      `Budget reicht nicht — es fehlen ${formatEuroDE(shortfallCents)}. Kunde akzeptiert keine Privatzahlung.`,
    );
    this.name = "BudgetHardBlockError";
    this.shortfallCents = shortfallCents;
  }
}

/**
 * Task #875 (Budget GF Phase 5) — Typisierte Über-Budget-Ablehnung beim
 * ABSCHLUSS (Reconciliation case c, R4/N7/I16/I20).
 *
 * Wird geworfen, wenn die dokumentierten Ist-Kosten eines bereits geplanten
 * Termins den Hold UND die verbleibende Kapazität der gleichen Töpfe
 * übersteigen (cross-pot overflow) UND der Kunde NICHT privatzahlungsfähig ist.
 * Im Gegensatz zu `BudgetHardBlockError` (Hard-Block beim Planen/Buchen)
 * beschreibt dieser Fehler bereits GELEISTETE Arbeit, die nicht still
 * verschwinden darf (I20 „kein Limbo"): Der Operator muss explizit auflösen —
 * eine `manual_adjustment`-Allocation anlegen, die Leistung herabstufen oder
 * einen dokumentierten Write-off buchen.
 * Bis dahin bleibt der offene Hold vom Orphan-Sweep (R6) sichtbar.
 */
export class OverBudgetCompletionError extends Error {
  readonly code = "OVER_BUDGET_COMPLETION" as const;
  /** Termin, dessen Abschluss über Budget liegt. */
  readonly appointmentId: number;
  /** Nicht durch Töpfe gedeckter Restbetrag in Cent. */
  readonly overflowCents: number;
  /** Topf, in dem der Überlauf entstand (letzter statutarischer Topf). */
  readonly budgetType: string;

  constructor(appointmentId: number, overflowCents: number, budgetType: string) {
    super(
      `Ist-Kosten liegen ${formatEuroDE(overflowCents)} über dem reservierten Budget für Termin #${appointmentId}. ` +
        `Kunde akzeptiert keine Privatzahlung — bitte manuell auflösen ` +
        `(Aufstockung, Leistung herabstufen oder dokumentierten Write-off buchen).`,
    );
    this.name = "OverBudgetCompletionError";
    this.appointmentId = appointmentId;
    this.overflowCents = overflowCents;
    this.budgetType = budgetType;
  }
}
