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
 * produktiven Leistungen + eine Kilometer-Zeile + eine Gemeinkosten-Restzeile,
 * sodass Σ(Zeilen) === Headline-KPI gilt.
 */

/** Einheit der Mengen-Spalte einer Economics-Zeile. */
export type BillingEconomicsUnit = "hours" | "km" | "none";

/** Eine Zeile der „Nach Leistung"-Tabelle bzw. des Mitarbeiter-Drilldowns. */
export interface BillingEconomicsRow {
  /** Stabiler Schlüssel: "hauswirtschaft" | "alltagsbegleitung" | "kilometer" | "gemeinkosten". */
  key: string;
  label: string;
  unit: BillingEconomicsUnit;
  /** Menge in der Einheit: Minuten (unit=hours), km (unit=km), 0 (unit=none/Gemeinkosten). */
  quantity: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number;
  /** Anzeige-Satz pro Einheit (Katalog-Standard): Erlös-Satz; 0 für Gemeinkosten. */
  revenueRateCents: number;
  /** Anzeige-Satz pro Einheit: an Mitarbeiter:innen ausgezahlter Kostensatz. */
  costRateCents: number;
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
  /** Per-Leistungs-Drilldown (hauswirtschaft/alltagsbegleitung/kilometer/gemeinkosten). */
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
  /** „Nach Leistung": Hauswirtschaft, Alltagsbegleitung, Kilometer, Gemeinkosten. */
  byService: BillingEconomicsRow[];
  /** „Nach Mitarbeiter": pro zugerechnetem Mitarbeiter, absteigend nach Umsatz. */
  byEmployee: BillingEconomicsEmployeeRow[];
}
