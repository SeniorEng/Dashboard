/**
 * Team-Auslastung — EINE SSoT für die Kapazitäts-/Auslastungsrechnung.
 *
 * Ersetzt die drei zuvor parallel gepflegten (und bereits gegeneinander
 * abgedrifteten) Rechner: server `computeSollIst` (nur Tests), client
 * `deriveSollIst` (Team-Auslastung-Seite) und client `computeWorkloadMetrics`
 * (Benutzerverwaltung). Beide Anzeige-Consumer UND die Tests importieren
 * ausschließlich diese Funktion — "Eine SSoT pro fachlicher Frage".
 *
 * Fachfrage: "Wer ist überlastet, wer kann noch Kunden übernehmen?"
 *
 * Zwei getrennte Produktiv-Größen (Fachentscheidung Alrik):
 *  - prodPerformed = ALLE selbst geleisteten produktiven Minuten (HW + Alltags-
 *    begleitung), egal in welcher Rolle — HV-Termine UND V1/V2-Vertretungen.
 *    Treibt die LAST-Seite: committed, pct, over, Balken-Segment "Produktiv".
 *  - prodHV = produktive Minuten der EIGENEN HV-Kunden. Treibt die KAPAZITÄTS-
 *    Seite: perClientOwn = prodHV / hv (ein neuer Kunde macht die Person zu
 *    dessen HV, deshalb bleibt Kapazität HV-basiert).
 *
 * Alle Minuten-Eingaben sind bereits Monats-Durchschnitte über dieselbe
 * Zeitbasis (Beschäftigungsmonate, NICHT abwesenheits-geschrumpft), damit
 * Abwesenheit nur EINMAL zählt (über den expliziten sickVac-Abzug).
 */

/** Fahrt-/Rüst-Puffer je zusätzlichem Kunden. Benannte, dokumentierte Konstante
 * (kein Inline-Wert). Hook für spätere Herleitung aus realem Overhead-Anteil. */
export const REISEPUFFER_HOURS = 1.0;

/** Fallback-Ø je Kunde, wenn keine belastbare Basis vorliegt (kein HV-Kunde und
 * keine rollen-auflösbare Vertretungsleistung). Ersetzt den früheren globalen
 * 3,85-h-Wert. */
export const DEFAULT_PER_CLIENT_HOURS = 3.85;

export type TeamWorkloadStatus = "over" | "limit" | "free" | "no-soll" | "no-basis";

export interface TeamWorkloadInputs {
  /** Vertragsstunden pro Monat (Soll). null = nicht hinterlegt. */
  monthlyWorkHours: number | null;
  /** Ø selbst geleistete produktive Minuten pro Monat, HW-Anteil (alle Rollen). */
  avgProdPerformedHwMinutes: number;
  /** Ø selbst geleistete produktive Minuten pro Monat, Alltagsbegleitungs-Anteil (alle Rollen). */
  avgProdPerformedAllMinutes: number;
  /** Ø produktive Minuten pro Monat der EIGENEN HV-Kunden (HW + AB). */
  avgProdHvMinutes: number;
  /** Ø Overhead-Minuten pro Monat (Büroarbeit/Vertrieb/Sonstiges). */
  avgOverheadMinutes: number;
  /** Ø Krank-/Urlaubs-Minuten pro Monat. */
  avgSickVacMinutes: number;
  hvCount: number;
  v1Count: number;
  v2Count: number;
  /** Beschäftigungsmonate im Fenster (0..3, fraktional). Divisor-Basis. */
  monthsConsidered: number;
}

export interface TeamWorkloadMetrics {
  sollHours: number | null;
  prodPerformedHours: number;
  prodPerformedHwHours: number;
  prodPerformedAllHours: number;
  prodHvHours: number;
  overheadHours: number;
  sickVacHours: number;
  /** = prodPerformed + overhead (reale geleistete Arbeitszeit inkl. Vertretung). */
  committedHours: number;
  /** = committed + sickVac. */
  usedAllHours: number;
  /** = max(0, soll − usedAll). null wenn kein Soll/Basis. */
  freeHours: number | null;
  /** = max(0, committed − soll). null wenn kein Soll/Basis. Behebt "+0 h über". */
  overHours: number | null;
  /** = committed / soll * 100. null wenn kein Soll/Basis. */
  pct: number | null;
  perClientOwnHours: number;
  /** true wenn perClientOwn über die Näherung prodPerformed/(hv+v1+v2) kam. */
  perClientOwnIsApprox: boolean;
  /** = perClientOwn + REISEPUFFER. */
  perClientHours: number;
  /** = floor(freeH / perClient). null wenn keine Basis. */
  addClients: number | null;
  status: TeamWorkloadStatus;
  hvCount: number;
  v1Count: number;
  v2Count: number;
  totalCustomers: number;
  hasSoll: boolean;
  hasIstBasis: boolean;
  isOverloaded: boolean;
  hasFreeCapacity: boolean;
}

export function computeTeamWorkload(input: TeamWorkloadInputs): TeamWorkloadMetrics {
  const prodPerformedHwHours = input.avgProdPerformedHwMinutes / 60;
  const prodPerformedAllHours = input.avgProdPerformedAllMinutes / 60;
  const prodPerformedHours = prodPerformedHwHours + prodPerformedAllHours;
  const prodHvHours = input.avgProdHvMinutes / 60;
  const overheadHours = input.avgOverheadMinutes / 60;
  const sickVacHours = input.avgSickVacMinutes / 60;

  const hvCount = input.hvCount;
  const totalCustomers = hvCount + input.v1Count + input.v2Count;

  const committedHours = prodPerformedHours + overheadHours;
  const usedAllHours = committedHours + sickVacHours;

  // Kapazitäts-Seite: HV-basiert. Näherung nur wenn HV-Zeit nicht auflösbar.
  let perClientOwnHours: number;
  let perClientOwnIsApprox = false;
  if (hvCount > 0) {
    perClientOwnHours = prodHvHours / hvCount;
  } else if (totalCustomers > 0 && prodPerformedHours > 0) {
    perClientOwnHours = prodPerformedHours / totalCustomers;
    perClientOwnIsApprox = true;
  } else {
    perClientOwnHours = DEFAULT_PER_CLIENT_HOURS;
  }
  const perClientHours = perClientOwnHours + REISEPUFFER_HOURS;

  const sollHours = input.monthlyWorkHours;
  const hasSoll = sollHours !== null && sollHours > 0;
  const hasIstBasis = hasSoll && input.monthsConsidered > 0;

  const base = {
    prodPerformedHours,
    prodPerformedHwHours,
    prodPerformedAllHours,
    prodHvHours,
    overheadHours,
    sickVacHours,
    committedHours,
    usedAllHours,
    perClientOwnHours,
    perClientOwnIsApprox,
    perClientHours,
    hvCount,
    v1Count: input.v1Count,
    v2Count: input.v2Count,
    totalCustomers,
  };

  if (!hasSoll) {
    return {
      ...base,
      sollHours: null,
      freeHours: null,
      overHours: null,
      pct: null,
      addClients: null,
      status: "no-soll",
      hasSoll: false,
      hasIstBasis: false,
      isOverloaded: false,
      hasFreeCapacity: false,
    };
  }

  if (!hasIstBasis) {
    // z. B. komplett im Fenster nicht beschäftigt/abwesend → keine Ist-Basis.
    return {
      ...base,
      sollHours,
      freeHours: sollHours,
      overHours: 0,
      pct: null,
      addClients: null,
      status: "no-basis",
      hasSoll: true,
      hasIstBasis: false,
      isOverloaded: false,
      hasFreeCapacity: false,
    };
  }

  const freeHours = Math.max(0, sollHours - usedAllHours);
  const overHours = Math.max(0, committedHours - sollHours);
  const pct = (committedHours / sollHours) * 100;
  const addClients = Math.floor(freeHours / perClientHours);

  const status: TeamWorkloadStatus =
    overHours > 0.05 ? "over" : freeHours >= perClientHours ? "free" : "limit";

  return {
    ...base,
    sollHours,
    freeHours,
    overHours,
    pct,
    addClients,
    status,
    hasSoll: true,
    hasIstBasis: true,
    isOverloaded: status === "over",
    hasFreeCapacity: status === "free",
  };
}
