/**
 * Phase-1.2-Drift-Folge — Kostenschätzung-Klassifikation als pure Funktion.
 *
 * Vor dieser Extraktion lebten die vier Branches (Selbstzahler / OK /
 * Soft-Private / Hard-Block) inkl. Warnungs-Strings und VAT-Mathematik direkt
 * inline in `server/routes/budget.ts` (Route `/cost-estimate`). Damit war die
 * Klassifikation weder unit-testbar noch von Equality-Tests aufrufbar, und
 * eine zweite Berechnungsstelle (z.B. clientseitige Live-Preview) hätte die
 * Wording-Strings dupliziert.
 *
 * Diese Funktion enthält KEINE I/O — alle Inputs (Verfügbarkeit, MwSt-Satz,
 * Selbstzahler-Flag) werden explizit übergeben. Der Server-Wrapper bleibt der
 * einzige Ort, der Preis- und Budget-Inputs aus DB/Storage materialisiert.
 * Querschnitts-Auflage A (pure / no state) ist damit erfüllt.
 */
import { formatEuroDE } from "../../utils/money";

export type CostEstimateKind = "selbstzahler" | "ok" | "soft_private" | "hard_block";

export interface CostEstimateInput {
  totalCostCents: number;
  /** Budget-Verfügbarkeit zum Termin-Datum (nur für non-Selbstzahler relevant). */
  availableCents: number;
  /**
   * MwSt-Satz in Prozent (z.B. 19 für 19 %). Gewichtet über die einzelnen
   * Leistungs-Positionen aufsummiert. Wird für `bruttoCents`/`vatCents` benutzt.
   */
  weightedVatRate: number;
  /**
   * Kunde akzeptiert Privatabrechnung (kovariate Branch-Entscheidung im
   * Budget-Engpass: Soft-Warning statt Hard-Block).
   */
  acceptsPrivatePayment: boolean;
  /** Kunde ist `billingType=selbstzahler` (Privatabrechnung — kein Budget-Pfad). */
  isSelbstzahler: boolean;
}

export interface CostEstimateOutcome {
  kind: CostEstimateKind;
  /**
   * UI-Warnungs-String (deutsch, mit `formatEuroDE`-formatierten Beträgen).
   * `null` = OK-Pfad oder Selbstzahler (Letzterer wird über `kind` erkannt).
   */
  warning: string | null;
  /** Termin darf NICHT angelegt werden — UI muss den Submit-Button blocken. */
  isHardBlock: boolean;
  /** Anteil in Cent, der dem Kunden direkt privat in Rechnung gestellt wird. */
  privateCents: number;
  /** MwSt-Anteil in Cent (auf `privateCents` oder `totalCostCents`, kontextabhängig). */
  vatCents: number;
  /**
   * Brutto-Betrag (Cent) für Selbstzahler-Anzeige. Für non-Selbstzahler-Pfade
   * standardmäßig 0 — der Route-Wrapper entscheidet, ob er diesen Wert ans
   * Wire weiterreicht (Bestands-Wire-Shape: nur Selbstzahler liefert
   * `bruttoCents`).
   */
  bruttoCents: number;
}

export function classifyCostEstimate(input: CostEstimateInput): CostEstimateOutcome {
  const { totalCostCents, availableCents, weightedVatRate, acceptsPrivatePayment, isSelbstzahler } = input;

  if (isSelbstzahler) {
    const vatCents = Math.round(totalCostCents * (weightedVatRate / 100));
    return {
      kind: "selbstzahler",
      warning: null,
      isHardBlock: false,
      privateCents: 0,
      vatCents,
      bruttoCents: totalCostCents + vatCents,
    };
  }

  if (totalCostCents > availableCents) {
    const shortfall = totalCostCents - availableCents;
    const shortfallEuro = formatEuroDE(shortfall);
    if (acceptsPrivatePayment) {
      const vatCents = Math.round(shortfall * (weightedVatRate / 100));
      return {
        kind: "soft_private",
        warning: `Budget reicht nicht — ${shortfallEuro} werden privat berechnet.`,
        isHardBlock: false,
        privateCents: shortfall,
        vatCents,
        bruttoCents: 0,
      };
    }
    return {
      kind: "hard_block",
      warning: `Budget reicht nicht — es fehlen ${shortfallEuro}.`,
      isHardBlock: true,
      privateCents: 0,
      vatCents: 0,
      bruttoCents: 0,
    };
  }

  return {
    kind: "ok",
    warning: null,
    isHardBlock: false,
    privateCents: 0,
    vatCents: 0,
    bruttoCents: 0,
  };
}
