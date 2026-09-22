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

export type CostEstimateKind =
  | "selbstzahler"
  | "ok"
  /** Budget reicht erst durch die Aufstockung des Termin-Monats. Anlegbar, mit Warnung. */
  | "erst_im_monat_gedeckt"
  | "soft_private"
  | "hard_block";

export interface CostEstimateInput {
  totalCostCents: number;
  /**
   * Budget-Verfügbarkeit zum Termin-Datum, Horizont auf HEUTE gedeckelt.
   * Das ist die Zahl, gegen die `createConsumptionTransaction` beim
   * Dokumentieren entscheidet.
   */
  availableCents: number;
  /**
   * Verfügbarkeit mit Projektion bis zum MONATSENDE des Termins — die Zahl,
   * gegen die `planHold` beim ANLEGEN entscheidet.
   *
   * ── Warum es zwei Zahlen braucht (Replit #1916) ──────────────────────
   * Es gibt zwei Tore mit verschiedenen Stichtagen: `planHold` beim Anlegen
   * (projiziert bis Monatsende) und `createConsumptionTransaction` beim
   * Dokumentieren (auf heute gedeckelt). Die Vorschau kannte nur die zweite
   * Zahl und war damit **strenger als der Server** — sie sperrte Termine, die
   * `planHold` angenommen hätte. Eine Mitarbeiterin konnte für Oktober nichts
   * anlegen.
   *
   * Beide Tore sind für sich richtig: wer im Oktober dokumentiert, hat den
   * Oktober-Anspruch real. Falsch war nur, die Anlage gegen den
   * Dokumentations-Stichtag zu prüfen.
   *
   * Fehlt der Wert (`undefined`), gilt das alte Verhalten — Aufrufer, die
   * nicht projizieren können, bleiben unverändert.
   */
  projectedAvailableCents?: number;
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
  /**
   * Kunde hat KEINEN Ausweichtopf: Pflegegrad 1 und keine Privatzahlung.
   *
   * Der Zusatzsatz stammt von Alrik und ist **keine Fehlermeldung, sondern
   * eine Aussage ueber Leistungsansprueche**, die eine Mitarbeiterin
   * gegenueber dem Kunden vertritt. Deshalb steht er woertlich so, wie er
   * freigegeben wurde — nicht in einer selbst formulierten Fassung.
   *
   * Das Kriterium ist ebenfalls Alriks: Pflegegrad 1, keine Privatzahlung.
   * Eine breitere Fassung („kein anderer Topf mit Kapazitaet") traefe mehr
   * Faelle — das waere aber eine Ausweitung der Zusage und gehoert gefragt,
   * nicht gebaut (FINDING im PR).
   */
  hasNoFallbackBudget?: boolean;
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

  /**
   * Die Weiche (Alrik, 22.09.2026): **projizieren, aber warnen statt sperren.**
   *
   *   projiziert reicht nicht          → harter Stopp, wie bisher
   *   projiziert reicht, heute nicht   → anlegbar, MIT Warnung
   *   beides reicht                    → unverändert
   *
   * Der mittlere Fall ist neu. Er trägt `isHardBlock: false` — der Client
   * sperrt den Knopf über genau dieses Feld, und er soll ihn hier nicht mehr
   * sperren.
   */
  const projiziert = input.projectedAvailableCents ?? availableCents;
  const massgeblich = Math.max(availableCents, projiziert);

  if (totalCostCents <= massgeblich && totalCostCents > availableCents) {
    const fehltHeute = formatEuroDE(totalCostCents - availableCents);
    return {
      kind: "erst_im_monat_gedeckt",
      warning:
        `Im Termin-Monat reicht das Budget (${formatEuroDE(projiziert)} verfügbar, `
        + `Termin kostet ${formatEuroDE(totalCostCents)}). `
        + `Heute fehlen davon noch ${fehltHeute} — sie kommen mit der `
        + `Monatsaufstockung. Der Termin kann angelegt werden; die Beträge `
        + `beziehen sich auf den Monat des Termins.`
        + (input.hasNoFallbackBudget ? " Kein Ausweichbudget verfügbar." : ""),
      isHardBlock: false,
      privateCents: 0,
      vatCents: 0,
      bruttoCents: 0,
    };
  }

  if (totalCostCents > massgeblich) {
    const shortfall = totalCostCents - massgeblich;
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
