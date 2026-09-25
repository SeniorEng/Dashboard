import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { formatEuroDE } from "@shared/utils/money";

export type CostEstimate = {
  totalCents: number;
  warning: string | null;
  noPricing?: boolean;
  availableCents?: number;
  isHardBlock?: boolean;
  /** Verfügbar mit Projektion bis Monatsende (Replit #1916). */
  projectedAvailableCents?: number;
  isSelbstzahler?: boolean;
  bruttoCents?: number;
  vatCents?: number;
  /** Einheitlicher Satz in Prozent; `null` = gemischte Sätze. */
  vatRate?: number | null;
  /**
   * Task #875 — bereits durch andere geplante Termine reservierter Betrag
   * (Holds). > 0 nur wenn das Hard-Hold-Feature aktiv ist; sonst 0 ⇒ kein
   * Reservierungs-Hinweis.
   */
  holdsActiveCents?: number;
};

interface CostEstimatePreviewProps {
  costEstimate: CostEstimate | null | undefined;
  billingType: string | null | undefined;
}

export function CostEstimatePreview({ costEstimate, billingType }: CostEstimatePreviewProps) {
  if (costEstimate?.noPricing) {
    return (
      <div className="rounded-lg border bg-amber-50 border-amber-200 p-4 text-sm flex items-start gap-3" data-testid="budget-no-pricing">
        <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-amber-800 font-semibold">Keine Preisvereinbarung</p>
          <p className="text-amber-700 text-xs mt-1">Bitte hinterlegen Sie eine Preisvereinbarung für diesen Kunden.</p>
        </div>
      </div>
    );
  }

  if (!costEstimate || costEstimate.noPricing || costEstimate.totalCents <= 0) {
    return null;
  }

  const cost = costEstimate;
  const isSelbstzahler = cost.isSelbstzahler || billingType === "selbstzahler";

  if (isSelbstzahler) {
    // Brutto und Satz kommen vom Server — aus derselben USt-Regel wie die
    // Rechnung (§ 4 Nr. 16 g UStG, mit Pflegegrad am Termindatum). Kein
    // eigener 19-%-Fallback mehr: fehlt der Wert, wird netto gezeigt.
    const bruttoEuro = formatEuroDE(cost.bruttoCents ?? cost.totalCents);
    // `vatRate: null` = gemischte Sätze → nur „inkl. MwSt." (kein Mischsatz).
    const vatPct = cost.vatRate;
    const ustText = vatPct == null
      ? "inkl. MwSt."
      : vatPct > 0 ? `inkl. ${vatPct} % MwSt.` : "umsatzsteuerfrei nach § 4 Nr. 16 UStG";
    return (
      <div className="rounded-lg border bg-blue-50 border-blue-200 p-3 text-sm flex items-start gap-3" data-testid="selbstzahler-cost-estimate">
        <CheckCircle2 className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-blue-800 font-medium">
            Kosten: {bruttoEuro} ({ustText})
          </p>
          <p className="text-blue-600 text-xs mt-1">Privatabrechnung — wird dem Kunden direkt in Rechnung gestellt</p>
        </div>
      </div>
    );
  }

  // Kein Selbstzahler (der Zweig oben): Anzeige netto — Kassen-Anteile sind steuerfrei.
  const displayCents = cost.totalCents;
  const costEuro = formatEuroDE(displayCents, { withCurrency: false });
  const availEuro = cost.availableCents !== undefined ? formatEuroDE(cost.availableCents, { withCurrency: false }) : null;
  const holdsCents = cost.holdsActiveCents ?? 0;
  const holdsNote = holdsCents > 0
    ? (
      <p className="text-xs mt-1 opacity-80" data-testid="text-budget-holds-reserved">
        davon {formatEuroDE(holdsCents, { withCurrency: false })} € durch geplante Termine reserviert
      </p>
    )
    : null;

  /**
   * Kopf und Warntext MÜSSEN aus derselben Zahl kommen — in JEDEM Zweig.
   *
   * ── Was hier schiefging (Gate 2 zu #167, B1) ────────────────────────
   * Der Warntext rechnet seit der S1-Korrektur gegen die projizierte Zahl
   * (`massgeblich` in `classifyCostEstimate`), der Kopf nahm weiter
   * `availableCents`. Ausgeführt ergab das:
   *
   *   „Kosten: 1.500,00 € — verfügbar: 2.358,00 €"   +  „es fehlen 583,00 €"
   *   „Kosten:   300,00 € — verfügbar:    47,00 €"   +  „es fehlen 122,00 €"
   *
   * Die erste Zeile ist offen unsinnig, die zweite ist der häufige Fall.
   * **Das ist genau die Klasse, für die dieser PR den Midlayer geändert hat**
   * — geschlossen war sie nur für den Mittelzweig, in den beiden
   * Engpass-Zweigen hat der PR sie NEU erzeugt.
   *
   * Deshalb hängt die Kopfzahl jetzt nicht mehr an `kind`, sondern daran, ob
   * die projizierte Zahl da ist: dann ist SIE die maßgebliche, und zwar
   * überall.
   */
  const zeigtMonatszahl = cost.projectedAvailableCents !== undefined;
  const massgeblichEuro = zeigtMonatszahl
    ? formatEuroDE(cost.projectedAvailableCents!, { withCurrency: false })
    : availEuro;
  const verfuegbarLabel = zeigtMonatszahl ? "im Termin-Monat verfügbar" : "verfügbar";

  if (cost.isHardBlock) {
    return (
      <div className="rounded-lg border bg-red-50 border-red-300 p-4 text-sm flex items-start gap-3" data-testid="budget-hard-block">
        <XCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-red-800 font-semibold">Budget reicht nicht</p>
          <p className="text-red-700 mt-1">Kosten: {costEuro} € — {massgeblichEuro !== null ? `${verfuegbarLabel}: ${massgeblichEuro} €` : "kein Budget"}</p>
          <p className="text-red-600 text-xs mt-1">{cost.warning}</p>
        </div>
      </div>
    );
  }

  /**
   * „Reicht erst im Monat" nennt die MONATS-Zahl im Kopf, nicht die heutige.
   *
   * Sonst stünde „verfügbar: 47,00 €" über einem Text, der 178,00 € nennt —
   * zwei verschiedene „verfügbar" in einem Kasten, und der Bediener müsste
   * raten, welche gilt (Replit #1916).
   */
  if (cost.warning) {
    return (
      <div className="rounded-lg border bg-amber-50 border-amber-200 p-4 text-sm flex items-start gap-3" data-testid="budget-warning">
        <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-amber-800 font-semibold">
            Kosten: {costEuro} €{" "}
            {massgeblichEuro !== null && (
              <span className="font-normal">— {verfuegbarLabel}: {massgeblichEuro} €</span>
            )}
          </p>
          <p className="text-amber-700 text-xs mt-1">{cost.warning}</p>
          {holdsNote}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-green-50 border-green-200 p-3 text-sm flex items-start gap-3" data-testid="budget-cost-estimate">
      <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
      <div>
        <p className="text-green-800 font-medium">Kosten: {costEuro} € {massgeblichEuro !== null && <span className="font-normal text-green-600">— {verfuegbarLabel}: {massgeblichEuro} €</span>}</p>
        {holdsNote}
      </div>
    </div>
  );
}
