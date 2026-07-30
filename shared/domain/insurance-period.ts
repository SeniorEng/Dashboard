/**
 * Task #1893 — Zeitraum-Semantik der Kostenträger-Zuordnung
 * (`customer_insurance_history`).
 *
 * DIE eine Quelle für zwei fachliche Fragen:
 *
 *   1. „Welcher Stichtag gilt für einen Abrechnungszeitraum?"
 *      → {@link billingPeriodAsOfISO}. Ende des Abrechnungszeitraums, NICHT
 *        `todayISO()`. Eine im Juli erstellte Juni-Rechnung muss den im Juni
 *        gültigen Kostenträger adressieren.
 *
 *   2. „Ist eine Menge von Gültigkeitsfenstern zulässig?"
 *      → {@link validateInsuranceWindows}.
 *
 * Fachliche Festlegung (Alrik, 30.07.2026): Ein Kassenwechsel ist
 * AUSSCHLIESSLICH zum 1. eines Monats zulässig — hart erzwungen, nicht nur
 * empfohlen. Damit fällt ein Abrechnungsmonat immer eindeutig unter GENAU EINE
 * Kasse; der Mitten-im-Monat-Fall (zwei Kostenträger in einem Monat, Split,
 * Ambiguität) entfällt konstruktiv.
 *
 * Fenster-Konvention: `validFrom` und `validTo` sind BEIDE inklusiv.
 * `validTo = null` heißt „offenes Ende" (aktuell gültig). Das Vorgänger-Fenster
 * endet am Tag VOR dem neuen `validFrom`, also am letzten Tag des Vormonats —
 * lückenlos und überlappungsfrei.
 *
 * Reines Domain-Modul: keine DB, keine I/O. Der DB-seitige Leser ist
 * `resolveCustomerInsuranceAt` (`server/storage/customer-mgmt/insurance.ts`).
 */

import { addDays, lastDayOfMonth } from "../utils/datetime";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Benutzer-sichtbare Meldung, wenn `validFrom` kein Monatserster ist. */
export const INSURANCE_WINDOW_MUST_START_ON_FIRST =
  "Ein Kassenwechsel ist nur zum Monatsersten möglich. Bitte den 1. eines Monats als „Gültig ab“ wählen.";

export interface InsuranceWindow {
  /** DB-Id, falls die Zeile bereits existiert (nur für Meldungen). */
  id?: number;
  /** Inklusiver Beginn (YYYY-MM-DD), MUSS ein Monatserster sein. */
  validFrom: string;
  /** Inklusives Ende (YYYY-MM-DD) oder `null` für „offenes Ende". */
  validTo: string | null;
}

/** True, wenn `iso` ein wohlgeformtes ISO-Datum ist. */
export function isIsoDate(iso: string | null | undefined): iso is string {
  return typeof iso === "string" && ISO_DATE_RE.test(iso);
}

/** True, wenn `iso` auf den 1. eines Monats fällt. */
export function isMonthStartISO(iso: string): boolean {
  const m = ISO_DATE_RE.exec(iso);
  return m !== null && m[3] === "01";
}

/**
 * Der Tag VOR `iso` — so schließt ein Vorgänger-Fenster lückenlos an ein neues
 * `validFrom` an. Für einen Monatsersten ist das exakt der letzte Tag des
 * Vormonats.
 */
export function dayBeforeISO(iso: string): string {
  return addDays(iso, -1);
}

/**
 * Stichtag eines Abrechnungszeitraums = dessen ENDE.
 *
 * `dateTo` (expliziter Zeitraum-Filter, z. B. Teilmonats-Abrechnung) hat
 * Vorrang; sonst der letzte Tag des Abrechnungsmonats. Da Kassenwechsel nur zum
 * Monatsersten zulässig sind, liefert jeder Tag des Monats dieselbe Kasse — das
 * Monatsende ist die kanonische Wahl.
 */
export function billingPeriodAsOfISO(
  billingYear: number,
  billingMonth: number,
  dateTo?: string | null,
): string {
  if (isIsoDate(dateTo)) return dateTo;
  return lastDayOfMonth(billingYear, billingMonth);
}

/**
 * Prüft eine EINZELNE Fenster-Kante: `validFrom` muss ein Monatserster sein und
 * `validTo` (falls gesetzt) darf nicht vor `validFrom` liegen.
 *
 * @returns Deutsche Fehlermeldung oder `null`, wenn zulässig.
 */
export function validateInsuranceWindow(window: InsuranceWindow): string | null {
  if (!isIsoDate(window.validFrom)) {
    return "„Gültig ab“ ist kein gültiges Datum (erwartet JJJJ-MM-TT).";
  }
  if (!isMonthStartISO(window.validFrom)) {
    return INSURANCE_WINDOW_MUST_START_ON_FIRST;
  }
  if (window.validTo !== null && window.validTo !== undefined) {
    if (!isIsoDate(window.validTo)) {
      return "„Gültig bis“ ist kein gültiges Datum (erwartet JJJJ-MM-TT).";
    }
    if (window.validTo < window.validFrom) {
      return `„Gültig bis“ (${window.validTo}) liegt vor „Gültig ab“ (${window.validFrom}).`;
    }
  }
  return null;
}

/**
 * Prüft die GESAMTE Fenster-Menge eines Kunden: jede Kante einzeln, dann
 * Überlappungs- und Lückenfreiheit über die nach `validFrom` sortierte Kette.
 *
 * Ein offenes Ende (`validTo = null`) darf nur das JÜNGSTE Fenster haben —
 * sonst überlappt es alles Nachfolgende.
 *
 * @returns Deutsche Fehlermeldung oder `null`, wenn die Menge zulässig ist.
 */
export function validateInsuranceWindows(windows: readonly InsuranceWindow[]): string | null {
  for (const w of windows) {
    const single = validateInsuranceWindow(w);
    if (single) return single;
  }

  const sorted = [...windows].sort((a, b) => a.validFrom.localeCompare(b.validFrom));

  for (let i = 0; i < sorted.length - 1; i++) {
    const prev = sorted[i];
    const next = sorted[i + 1];

    if (prev.validFrom === next.validFrom) {
      return `Zwei Zuordnungen beginnen am selben Tag (${prev.validFrom}). Zeiträume müssen sich abwechseln.`;
    }
    if (prev.validTo === null || prev.validTo === undefined) {
      return `Die Zuordnung ab ${prev.validFrom} hat kein „Gültig bis“, obwohl ab ${next.validFrom} eine weitere folgt. Nur die jüngste Zuordnung darf offen bleiben.`;
    }
    if (prev.validTo >= next.validFrom) {
      return `Die Zeiträume ab ${prev.validFrom} und ab ${next.validFrom} überschneiden sich (${prev.validFrom}–${prev.validTo} vs. ab ${next.validFrom}).`;
    }
    const expectedEnd = dayBeforeISO(next.validFrom);
    if (prev.validTo !== expectedEnd) {
      return `Zwischen ${prev.validTo} und ${next.validFrom} klafft eine Lücke ohne Kostenträger. Die vorherige Zuordnung muss am ${expectedEnd} enden.`;
    }
  }

  return null;
}

/**
 * Wählt aus einer Fenster-Menge das am `asOfISO` gültige Fenster.
 *
 * Pure Spiegelung des SQL-Prädikats in `resolveCustomerInsuranceAt`
 * (`validFrom <= asOf AND (validTo IS NULL OR validTo >= asOf)`, jüngstes
 * `validFrom` gewinnt) — damit Tests die Auswahl ohne DB prüfen können.
 */
export function pickInsuranceWindowAt<T extends InsuranceWindow>(
  windows: readonly T[],
  asOfISO: string,
): T | undefined {
  let best: T | undefined;
  for (const w of windows) {
    if (w.validFrom > asOfISO) continue;
    if (w.validTo !== null && w.validTo !== undefined && w.validTo < asOfISO) continue;
    if (!best || w.validFrom > best.validFrom) best = w;
  }
  return best;
}
