/**
 * Task #1348 — §45b-Verfügbarkeit auf EINE Funktion konsolidieren.
 *
 * Die symmetrische §45b-Verfügbarkeit ("wieviel Entlastungsbetrag ist zum Datum
 * D noch frei") wird heute an DREI Stellen mit jeweils eigener
 * "allocated − consumed"-Mathematik gerechnet:
 *
 *   - `unified-reader.ts`     (Reader: `manual_adjustment` ist ein negativer
 *                              Allocation-Posten in `calculateAllocatedCents`,
 *                              Holds sind aktiv abgezogen),
 *   - `summary-queries.ts`    (BEIDE Forecasts: `manual_adjustment` steckt im
 *                              Verbrauch `netUsedCents`, Holds werden NICHT
 *                              gezählt).
 *
 * Diese Funktion ist die alleinige §45b-Verfügbarkeits-SSoT. Sie bildet GENAU
 * die Erhaltungs-Identität des `unified-reader` ab (vor dem optionalen Fenster-
 * Cap, der bei §45b nur bei gesetztem `monthlyLimitCents` greift und
 * NICHT Teil dieser Aufgabe ist):
 *
 *     netAvailable45bAt(D) =
 *         max(0, allocated(D) − holds(D) − max(0, rohVerbrauch(D) − excluded(D)))
 *
 * mit
 *   - allocated(D)     = `calculateAllocatedCents(…45b, { asOfDate, projectFuture })`
 *                        (enthält `manual_adjustment` als Allocation-Posten),
 *   - holds(D)         = aktive Hard-Holds des Jahresfensters (`activeHoldsCents`),
 *   - rohVerbrauch(D)  = `netConsumedUpToDate` = Σ|consumption|+Σ|write_off|−Σ|reversal|
 *                        (KEIN `manual_adjustment` — der liegt in `allocated`),
 *   - excluded(D)      = Verbrauch gegen einen aus `allocated` herausgefallenen
 *                        Übertrag / verdrängte `initial_balance`
 *                        (`getExcluded45bConsumption`, Task #1306/#1340).
 *
 * `projectFuture` MUSS an `calculateAllocatedCents` UND `getExcluded45bConsumption`
 * identisch durchgereicht werden, damit Allocation- und Exklusions-Fenster
 * deckungsgleich bleiben (Forecast-Projektion rechnet mit `projectFuture: true`).
 *
 * READER-TORE (Task #1348, Schritt 3 abgenommen): Wie der `unified-reader` liefert
 * die Funktion 0 €, wenn §45b für den Kunden NICHT aktiv ist — entweder per
 * Type-Settings/Selbstzahler-Default deaktiviert (`enabled`, SSoT
 * `effectiveDefaultPots`) oder der Stichtag außerhalb `validFrom..validTo` liegt
 * (`inRange`). Außerdem werden die `preferences` — wie im Reader — an
 * `calculateAllocatedCents` durchgereicht. Ohne diese Tore würde die §45b-
 * Verfügbarkeit für gesperrte Kunden überschätzt (Prod-Diff #41/#164).
 *
 * REINE ARITHMETIK ausgelagert: die Schluss-Mathe (`max(0, …)` + Holds-Kontext +
 * Floor) lebt als pure `computeNetAvailable45b` in
 * `shared/domain/budget/net-available-45b.ts`. Diese Funktion lädt NUR die
 * DB-Eingangsgrößen und ruft sie auf — die §45b-Verfügbarkeits-Mathe existiert damit
 * nur EINMAL (Architektur-Test `budget-single-reader.test.ts`).
 *
 * VERDRAHTUNGSSTAND (Task #1348):
 *   - WIRED — `unified-reader`: READER-/BUCHUNGS-Kontext (`holds: "subtract"`, UNTER
 *     dem Fenster-Cap des Readers, der per `Math.min` dort bleibt). Der Re-Diff hat
 *     für diesen Pfad Δreader = 0 abgenommen.
 *   - BEWUSST (NOCH) NICHT WIRED — der FORECAST-Aufrufer
 *     (`summary-queries.getBudgetSummary`): sein roher, vorzeichenbehafteter
 *     `availableCents` (= allocated − netUsed) ist die Basis der zeitlichen „nach
 *     Planung"-Projektion UND der `mergeServed45b`-Delta-Verschiebung. Würde man ihn
 *     auf den hier gefloorten Wert setzen, flösse der gefloorte Wert über das Delta in
 *     `availableAfterPlannedCents` ein — genau das verbietet das Alrik-Gate (ein
 *     Fehlbetrag MUSS als negativer Wert sichtbar bleiben, NICHT aus dem gefloorten
 *     Wert abgeleitet werden). Die forecast-INTERNE §45b-Mathe in
 *     `summary-queries.ts` bleibt deshalb vorerst eigenständig; ihre Umstellung
 *     braucht erst Alriks fallweise Abnahme der im Forecast-Re-Diff verbliebenen
 *     excluded(#1340)/Floor-Divergenzen (separater Folge-Task). Die NUTZER-Anzeige der
 *     §45b-Verfügbarkeit läuft ohnehin über den bedienten Pfad
 *     (`getBudgetSummaryServed` → `mergeServed45b`), der `availableCents` bereits aus
 *     diesem Reader bezieht. Der `holds: "ignore"`-Modus bleibt für die Diff-Reports
 *     erhalten.
 *
 * REIN LESEND: nur `db.select` über bestehende Helfer, keine Schreibpfade.
 */
import { eq } from "drizzle-orm";
import { customers, type CustomerBudgetTypeSetting } from "@shared/schema";
import { db } from "../../lib/db";
import { customersRepo } from "../../repos";
import type { DbClient } from "./types";
import { readBudgetTypeSettings, getBudgetPreferences } from "./preferences-storage";
import { calculateAllocatedCents, getExcluded45bConsumption } from "./allocation-storage";
import { activeHoldsCents, netConsumedUpToDate, isInRange } from "./unified-reader";
import { effectiveDefaultPots } from "@shared/domain/budgets";
import {
  computeNetAvailable45b,
  type NetAvailable45bComposition,
} from "@shared/domain/budget/net-available-45b";

const BUDGET_TYPE_45B = "entlastungsbetrag_45b" as const;

/**
 * Ergebnis der §45b-Verfügbarkeits-SSoT. Identisch zum pure-Math-Ergebnis
 * `NetAvailable45bComposition` (die Schluss-Arithmetik lebt in
 * `shared/domain/budget/net-available-45b.ts`).
 */
export type NetAvailable45bResult = NetAvailable45bComposition;

export interface NetAvailable45bOptions {
  /**
   * Zukünftige Monatsaufstockungen bis zum projizierten Monatsende einrechnen
   * (Forecast-Pfad). Default `false` (Lese-/Buchungspfad: nur bis "heute").
   */
  readonly projectFuture?: boolean;
  /** Optional vorab geladene §45b-Type-Settings (spart einen DB-Roundtrip). */
  readonly typeSettings?: CustomerBudgetTypeSetting[];
  /**
   * Holds-Kontext (Task #1348, Schritt 4):
   *  - `"subtract"` (Default): aktive Hard-Holds werden abgezogen — das ist die
   *    READER-/BUCHUNGS-Sicht (`unified-reader`). Bewahrt den abgenommenen
   *    Schattenmodus-Befund Δreader = 0.
   *  - `"ignore"`: Holds werden NICHT abgezogen — die FORECAST-Sicht. Der Forecast
   *    (`getBudgetSummary`) zählt die geplanten Termin-Kosten bereits selbst; ein
   *    zusätzlicher Hold-Abzug würde Holds UND geplante Kosten doppelt zählen und
   *    so eine künstliche Unterschätzung → falsche Über-Budget-Warnungen erzeugen
   *    (genau der #1340-Fehlerklasse). `holdsCents` bleibt im Ergebnis sichtbar
   *    (Diff-/Erklärbarkeit), wirkt aber nicht auf `availableCents`.
   */
  readonly holds?: "subtract" | "ignore";
}

/**
 * Die EINE §45b-Verfügbarkeits-Funktion. Liefert die Cent-Verfügbarkeit zum
 * Stichtag `asOfDate` sowie alle Eingangsgrößen der Erhaltungs-Identität (für
 * Diff-Reports / Erklärbarkeit). Reine Lese-Funktion.
 */
export async function netAvailable45bAt(
  customerId: number,
  asOfDate: string,
  options: NetAvailable45bOptions = {},
  tx?: DbClient,
): Promise<NetAvailable45bResult> {
  const d = tx ?? db;
  const projectFuture = options.projectFuture ?? false;

  const [typeSettings, preferences, customerRows] = await Promise.all([
    options.typeSettings
      ? Promise.resolve(options.typeSettings)
      : readBudgetTypeSettings(customerId, { kind: "forDate", asOfDate }, tx),
    getBudgetPreferences(customerId, tx),
    customersRepo
      .selectColumnsFrom({ billingType: customers.billingType }, d)
      .where(eq(customers.id, customerId)),
  ]);
  const billingType = customerRows[0]?.billingType;

  // Reader-Tore (deckungsgleich zu `unified-reader`): Default-Aktivierung kommt
  // aus der SSoT `effectiveDefaultPots`, persistierte Zeilen behalten ihren
  // `enabled`-Wert; ein Stichtag außerhalb `validFrom..validTo` sperrt den Topf.
  const s45b = typeSettings.find((s) => s.budgetType === BUDGET_TYPE_45B);
  const defaultEnabled45b =
    effectiveDefaultPots({ billingType, pflegegrad: null }).find(
      (p) => p.budgetType === BUDGET_TYPE_45B,
    )?.enabled ?? false;
  const enabled45b = s45b ? s45b.enabled : defaultEnabled45b;
  const inRange45b = !s45b ? true : isInRange(asOfDate, s45b.validFrom, s45b.validTo);

  if (!enabled45b || !inRange45b) {
    // Gesperrter Topf → keine §45b-Verfügbarkeit (entspricht `emptyPot` im Reader).
    return computeNetAvailable45b({
      allocatedCents: 0,
      holdsCents: 0,
      rawConsumedNetCents: 0,
      excludedConsumedNetCents: 0,
    });
  }

  const [allocatedCents, holdsCents, rawConsumedNetCents, excluded] = await Promise.all([
    calculateAllocatedCents(
      customerId,
      BUDGET_TYPE_45B,
      { asOfDate, projectFuture },
      tx,
      preferences,
      typeSettings,
    ),
    activeHoldsCents(customerId, BUDGET_TYPE_45B, asOfDate, "year", d),
    netConsumedUpToDate(customerId, BUDGET_TYPE_45B, asOfDate, d),
    getExcluded45bConsumption(customerId, asOfDate, d, typeSettings, { projectFuture }),
  ]);

  // Schluss-Arithmetik (Floor + Holds-Kontext) läuft über die EINE pure SSoT-Mathe.
  // Der Reader zieht Holds ab (`subtract`), der Forecast NICHT (`ignore`, er zählt die
  // geplanten Kosten ohnehin selbst — sonst Doppelzählung, #1340). `holdsCents` bleibt
  // im Ergebnis transparent, wirkt aber nur im "subtract"-Modus auf `availableCents`.
  return computeNetAvailable45b({
    allocatedCents,
    holdsCents,
    rawConsumedNetCents,
    excludedConsumedNetCents: excluded.excludedConsumedNetCents,
    holds: options.holds,
  });
}
