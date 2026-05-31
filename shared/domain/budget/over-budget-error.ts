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
