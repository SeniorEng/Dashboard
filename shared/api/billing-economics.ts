/**
 * Task #1473 — API-Vertrag des billing-scoped „Wirtschaftlicher Überblick".
 *
 * Diese Typen beschreiben die Antwort von `GET /api/billing/economics`. Die
 * fachliche Kosten-/Margen-Berechnung lebt ausschließlich in der bestehenden
 * Economics-SSoT (`shared/domain/statistics/economics.ts`, `buildEconomics`);
 * hier wird sie nur billing-scoped (Monat/Jahr + Mitarbeiter:in + Kasse)
 * aggregiert und für den Transport in eine Tabellen-Sicht überführt.
 *
 * Geldbeträge sind ausnahmslos Integer-Cents. Die Headline-KPIs schließen den
 * Gemeinkosten-Overhead (nicht-abrechenbare Zeit zum HW-Satz bewertet) und die
 * bezahlten km mit ein, damit die Marge die Gesamtwirtschaftlichkeit abbildet.
 * Die Zeilen-Sicht (Nach Leistung / Nach Mitarbeiter) itemisiert die
 * produktiven Leistungen, die berechenbaren km und — je Kategorie einzeln —
 * die Kosten ohne Umsatz, sodass Σ(Zeilen) === Headline-KPI gilt.
 *
 * Die Auffächerung ERSETZT zwei Sammelzeilen (Ticket 6hWgVqw2C8442hcG):
 *  - EINE `kilometer`-Zeile, die alle drei km-Arten mischte, obwohl die
 *    Zeiterfassungs-km dem Kunden nie berechnet werden — die ausgewiesene
 *    Marge dieser Zeile war dadurch verdünnt.
 *  - EINE `gemeinkosten`-Restzeile über sechs Kategorien, die die Frage
 *    „wofür zahle ich, ohne dafür Geld zu bekommen?" unbeantwortet ließ.
 *
 * Es ist eine Änderung der SICHT, nicht des Rechenwegs: die Economics-SSoT
 * (`shared/domain/statistics/economics.ts`) hält beides längst getrennt vor
 * (`km.travel`/`km.customer`/`km.timeEntry`, `nonBillable.byCategory`); erst
 * diese Schicht hatte es zusammengefasst. Kein Betrag wird neu berechnet.
 */

/** Einheit der Mengen-Spalte einer Economics-Zeile. */
export type BillingEconomicsUnit = "hours" | "km" | "none";

/**
 * Zu welchem Block der Tabelle eine Zeile gehört.
 *
 * ERSETZT die stillschweigende Übereinkunft „die letzte Zeile ist die
 * Gemeinkosten-Restzeile". Die trug, solange es GENAU eine solche Zeile gab;
 * seit die Gemeinkosten pro Kategorie aufgefächert sind und die km in einen
 * berechenbaren und einen nicht berechenbaren Teil zerfallen, wäre sie eine
 * Positionsannahme, die beim nächsten Einfügen still bricht.
 *
 * `kosten_ohne_umsatz` heißt: die Zeile trägt per Definition `revenueCents: 0`.
 * Das ist NICHT dasselbe wie „hat diesen Monat 0 € Umsatz" — eine
 * Leistungs-Zeile kann in einem leeren Monat ebenfalls 0 sein, gehört aber
 * weiterhin nach oben. Deshalb ein eigenes Feld statt einer Prüfung auf 0.
 */
export type BillingEconomicsRowGroup = "leistung" | "kosten_ohne_umsatz";

/** Eine Zeile der „Nach Leistung"-Tabelle bzw. des Mitarbeiter-Drilldowns. */
export interface BillingEconomicsRow {
  /**
   * Stabiler Schlüssel:
   * `hauswirtschaft` | `alltagsbegleitung` | `kilometer`
   * | `kilometer_zeiterfassung` | `overhead_<kategorie>`.
   *
   * `overhead_*` ERSETZT den früheren Sammel-Schlüssel `gemeinkosten`.
   */
  key: string;
  /** Block der Tabelle — siehe `BillingEconomicsRowGroup`. */
  group: BillingEconomicsRowGroup;
  label: string;
  unit: BillingEconomicsUnit;
  /** Menge in der Einheit: Minuten (unit=hours), km (unit=km), 0 (unit=none). */
  quantity: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number;
  /** Anzeige-Satz pro Einheit: Erlös-Satz; 0 bei Einheit `none` und ohne Menge. */
  revenueRateCents: number;
  /** Anzeige-Satz pro Einheit: an Mitarbeiter:innen ausgezahlter Kostensatz. */
  costRateCents: number;
  /**
   * POTENZIAL des ganzen Monats — Ticket 6hWgVqw2C8442hcG, Alriks erste
   * Zielfrage: „wie viel abrechenbaren Umsatz mache ich potentiell diesen
   * Monat (inkl. geplante Termine)?"
   *
   * Dieselbe Erlös-/Kostenformel wie die Ist-Spalten, nur ein anderer
   * Status-Filter (`POTENTIAL_APPOINTMENT_STATUSES` = geleistet ODER noch
   * offen). Eine zweite Formel wäre ein Zweitbegriff der Frage „was ist diese
   * Leistung wert?".
   *
   * `null` heißt „diese Frage ist für diese Zeile nicht gestellt", NICHT
   * „0 €":
   *  - **km**: geplante km kennt das System nicht. Anfahrt und Kunden-km
   *    entstehen erst bei der Dokumentation — eine Zahl dafür wäre geschätzt.
   *  - **Overhead**: Büro/Vertrieb/Urlaub werden nicht je Monat geplant.
   *
   * Das Ist ist im Potenzial ENTHALTEN (`completed` zählt mit), nicht daneben:
   * die Differenz ist das, was noch kommen kann.
   */
  potentialRevenueCents: number | null;
  potentialCostCents: number | null;
}

/** Eine Zeile der „Nach Mitarbeiter"-Tabelle inkl. aufklappbarem Leistungs-Drill. */
export interface BillingEconomicsEmployeeRow {
  employeeId: number;
  employeeName: string;
  /** Produktive Leistungsminuten (Hauswirtschaft + Alltagsbegleitung). */
  serviceMinutes: number;
  /** Gefahrene km (Anfahrt + Kunden-km + Zeiterfassungs-km). */
  km: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number;
  /** Per-Leistungs-Drilldown mit denselben Schlüsseln wie `byService`. */
  services: BillingEconomicsRow[];
}

export interface BillingEconomicsResponse {
  billingYear: number;
  billingMonth: number;
  totals: {
    /** Dokumentierter Service-Erlös + dem Kunden berechnete km. */
    revenueCents: number;
    /** Lohnkosten gesamt: produktiv + Gemeinkosten-Overhead + bezahlte km. */
    laborCostCents: number;
    /** Deckungsbeitrag = Umsatz − Lohnkosten. */
    marginCents: number;
    marginPercent: number;
  };
  /**
   * „Nach Leistung", zwei Blöcke (siehe `BillingEconomicsRowGroup`):
   * `leistung` = Hauswirtschaft, Alltagsbegleitung, Kilometer aus Terminen;
   * `kosten_ohne_umsatz` = Kilometer aus der Zeiterfassung + die sechs
   * Overhead-Kategorien einzeln.
   */
  byService: BillingEconomicsRow[];
  /** „Nach Mitarbeiter": pro zugerechnetem Mitarbeiter, absteigend nach Umsatz. */
  byEmployee: BillingEconomicsEmployeeRow[];
}
