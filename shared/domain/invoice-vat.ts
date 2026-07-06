/**
 * Task #997 — Single Source of Truth für die USt-Behandlung einer Rechnung /
 * eines Leistungsnachweises auf der ANZEIGE-Seite (PDF/HTML-Renderer).
 *
 * Die USt-Behandlung ist an den BUDGET-TOPF gebunden, nicht an einen einzelnen
 * `billingType`-String:
 *   - Ein Kassen-/Budget-Topf-Anteil (`budgetType` ∈ BUDGET_TYPES) ist
 *     umsatzsteuerbefreit gem. § 4 Nr. 16 UStG → `netto === brutto`, keine USt.
 *   - Der privat gezahlte Anteil (Selbstzahler-Topf `"private"`, gerendert als
 *     `billingType === "selbstzahler"`) trägt 19 % USt.
 *
 * Der Renderer DARF die Beträge NICHT mehr unabhängig mit ×1,19 hochrechnen
 * (alter `vatMultiplier`-Bug RE-2026-0023). Stattdessen liefert dieses Modul
 * EINEN Ort, der entscheidet, ob eine Zeile/Rechnung steuerfrei oder mit 19 %
 * ausgewiesen wird, und wie eine USt-Summe drift-frei (Largest-Remainder) auf
 * die Einzelzeilen verteilt wird, sodass Σ(Zeilen) === Gesamtbetrag gilt.
 */
import { BUDGET_TYPES } from "./budgets";

/** Anzeige-USt-Behandlung einer Rechnung/eines Leistungsnachweises. */
export type VatTreatment = "exempt" | "standard";

/** Gesetzlicher Regelsteuersatz in Basispunkten (19,00 %). */
export const STANDARD_VAT_RATE_BP = 1900;

const BUDGET_TYPE_SET: ReadonlySet<string> = new Set(BUDGET_TYPES as readonly string[]);

/**
 * Task #1659 — EINZIGE Roh-Zugriffsstelle auf das Service-Feld `vatRate`.
 *
 * `services.vatRate` ist als PROZENT-Wert gespeichert (Schema
 * `integer NOT NULL DEFAULT 19`, Zod `.max(100)`), NICHT als Basispunkte.
 * Der Rechnungs-Erzeugungspfad rechnet die USt aber in Basispunkten
 * (`round(netto × rateBP / 10000)`, identisch zu {@link STANDARD_VAT_RATE_BP}).
 * Wer die Rohrate ohne Umrechnung durch 10000 teilt, erhält 0,19 % statt 19 %
 * — genau die Regression aus Commit `9d6f9d4` (RE-2026-0250 & Co.).
 *
 * Deshalb übersetzt DIESER Helper die Prozent-Rate in Basispunkte und ist die
 * einzige Stelle, an der `vatRate` roh gelesen/gerechnet werden darf. Ein
 * fehlender (`null`) Satz ist ein Konfigurationsfehler (analog „Kein Preis
 * hinterlegt") und wird geworfen — NIE still als steuerfrei (`|| 0`)
 * geschluckt. Der Architektur-Guard
 * `tests/architecture/no-raw-service-vat-rate.test.ts` verhindert, dass
 * `services.vatRate` je wieder außerhalb dieser Datei roh mit `*`/`/`
 * verrechnet wird.
 *
 * Lessons Learned (SHOULD, Step 8): Bei „thin handler"-Extraktionen (wie
 * `9d6f9d4`) müssen implizite Einheiten-Konversionen (Prozent → Basispunkte)
 * explizit gemacht werden; Grep-/AST-Architektur-Tests sind der zuverlässige
 * Guard gegen diesen Regressionstyp.
 */
export function serviceVatRateBP(svc: {
  vatRate: number | null | undefined;
  name?: string | null;
  code?: string | null;
  serviceName?: string | null;
  serviceCode?: string | null;
}): number {
  const percent = svc.vatRate;
  if (percent == null) {
    const label = svc.name ?? svc.serviceName ?? svc.code ?? svc.serviceCode ?? "Dienstleistung";
    throw new Error(
      `Kein MwSt-Satz hinterlegt für Dienstleistung "${label}". Bitte prüfen Sie den Dienstleistungskatalog.`,
    );
  }
  // Prozent → Basispunkte: 19 % → 1900 (== STANDARD_VAT_RATE_BP).
  return percent * 100;
}

/**
 * Entscheidet die USt-Behandlung anhand des Budget-Topfs (Primärsignal) mit
 * Fallback auf den `billingType` für Alt-/Einzeltopf-Rechnungen ohne
 * `budgetType`-Marker.
 */
export function resolveVatTreatment(input: {
  billingType: string;
  budgetType?: string | null;
}): VatTreatment {
  const { billingType, budgetType } = input;
  // Pot-gebunden: ein echter Budget-/Kassen-Topf ist steuerbefreit. Der
  // Selbstzahler-Topf wird mit `budgetType === null`/"private" geführt und
  // fällt unten auf die billingType-Prüfung.
  if (budgetType != null && budgetType !== "private") {
    return BUDGET_TYPE_SET.has(budgetType) ? "exempt" : "standard";
  }
  // Kein Topf-Marker (Einzeltopf-/Alt-Rechnung oder Privat-Topf):
  // Selbstzahler = 19 %, jede Pflegekassen-Abrechnungsart = steuerbefreit.
  return billingType === "selbstzahler" ? "standard" : "exempt";
}

/**
 * Verteilt eine USt-Gesamtsumme nach dem Largest-Remainder-Verfahren auf die
 * Einzelzeilen-Nettobeträge, sodass Σ(Ergebnis) === `totalVatCents` EXAKT gilt
 * (kein Σ-Drift durch Einzelzeilen-Rundung). Funktioniert für positive
 * (Rechnung) wie negative (Storno) Beträge.
 *
 * Tiebreak: größerer Nachkomma-Betrag zuerst, dann Index — deterministisch.
 */
export function distributeVatAcrossLines(lineNetCents: number[], totalVatCents: number): number[] {
  const n = lineNetCents.length;
  if (n === 0) return [];
  if (totalVatCents === 0) return lineNetCents.map(() => 0);

  const netSum = lineNetCents.reduce((sum, v) => sum + v, 0);
  if (netSum === 0) {
    // Keine Netto-Basis für die Verteilung — gesamte USt auf die erste Zeile.
    const out = lineNetCents.map(() => 0);
    out[0] = totalVatCents;
    return out;
  }

  const exact = lineNetCents.map((net) => (net * totalVatCents) / netSum);
  const base = exact.map((v) => Math.trunc(v));
  const remainder = totalVatCents - base.reduce((sum, v) => sum + v, 0);
  const step = remainder >= 0 ? 1 : -1;

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.trunc(v) }))
    .sort((a, b) =>
      step > 0 ? b.frac - a.frac || a.i - b.i : a.frac - b.frac || a.i - b.i,
    );

  const out = [...base];
  let left = Math.abs(remainder);
  for (let k = 0; k < order.length && left > 0; k++) {
    out[order[k].i] += step;
    left--;
  }
  return out;
}

/**
 * Rundet einen Netto-(Einzel-)Preis für die ANZEIGE auf brutto hoch. Nur für
 * die informative „Satz/Einzelpreis (brutto)"-Spalte — die summierte
 * „Betrag"-Spalte wird IMMER über {@link distributeVatAcrossLines} gebildet,
 * damit Σ(Zeilen) === Gesamtbetrag exakt bleibt.
 */
export function grossUpUnitPriceCents(netCents: number, treatment: VatTreatment): number {
  if (treatment !== "standard") return netCents;
  return Math.round((netCents * (10000 + STANDARD_VAT_RATE_BP)) / 10000);
}
