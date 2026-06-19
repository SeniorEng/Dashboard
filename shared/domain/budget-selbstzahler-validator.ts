/**
 * Task #705 / #716 / #1168 — Pure Validator: Selbstzahler dürfen die
 * gesetzlichen Pflegekassen-Töpfe (§45b Entlastungsbetrag, §45a
 * Umwandlungsanspruch, §39/§42a Verhinderungs-/Kurzzeitpflege) nicht
 * aktivieren, keinen Startwert/Carryover anlegen, keine manuelle Korrektur
 * fahren und keine direkte Allocation schreiben.
 *
 * Diese Töpfe sind Pflegekassenleistungen (SGB XI). Wer privat zahlt
 * (`billingType === "selbstzahler"`), hat keinen Anspruch — die Regel lebt
 * deshalb zentral hier, damit Backend-Routen (PUT type-settings, Create-Pfad,
 * initial-budget) UND Frontend-Formular denselben Code (und denselben
 * deutschen Fehlertext) aufrufen.
 *
 * Pure: kein DB-Zugriff, kein Cache. Eingabe ist die `billingType`-Spalte des
 * Kunden plus die Buchungs-/Edit-Intent-Beschreibung.
 */

export type SelbstzahlerValidationOk = { ok: true };

export type SelbstzahlerValidationError = {
  ok: false;
  /** Wire-stabiler Fehlercode für Frontend-Mapping. */
  code: "BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER";
  /** HTTP-Status für Express-Antworten — Routen müssen diesen Wert verwenden, damit das Smoke-Test-Mapping (409) stabil bleibt. */
  httpStatus: 409;
  /** Primärer (deutscher) Fehlertext für Toast/Banner. */
  message: string;
  /** Detail-Liste deutscher Begründungs-Texte für mehrzeilige UI-Anzeige. */
  reasons: string[];
};

export type SelbstzahlerValidationResult =
  | SelbstzahlerValidationOk
  | SelbstzahlerValidationError;

export interface SelbstzahlerValidationInput {
  /** `customers.billingType` — `"selbstzahler"` triggert den Block, alles andere ist erlaubt. */
  billingType: string | null | undefined;
  intent: {
    /** Topf, der angefasst werden soll (Activate, Startwert, Carryover, Allocation, Korrektur). */
    budgetType: string;
  };
}

/**
 * Deutsche Bezeichnung pro gesetzlichem Topf. Nur diese Töpfe sind für
 * Selbstzahler gesperrt — Schlüssel dient gleichzeitig als „ist gesetzlicher
 * Topf?"-Whitelist.
 */
const STATUTORY_POT_LABELS: Record<string, string> = {
  entlastungsbetrag_45b: "§45b Entlastungsbetrag",
  umwandlung_45a: "§45a Umwandlungsanspruch",
  ersatzpflege_39_42a: "§39/§42a Gemeinsamer Jahresbetrag",
};

export function validateSelbstzahlerBudget(
  input: SelbstzahlerValidationInput,
): SelbstzahlerValidationResult {
  const label = STATUTORY_POT_LABELS[input.intent.budgetType];
  if (!label) return { ok: true };
  if (input.billingType !== "selbstzahler") return { ok: true };
  return {
    ok: false,
    code: "BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER",
    httpStatus: 409,
    message: `${label} ist für Selbstzahler nicht verfügbar.`,
    reasons: [
      `${label} ist eine gesetzliche Pflegekassenleistung (SGB XI).`,
      "Selbstzahler haben darauf keinen Anspruch.",
    ],
  };
}

/**
 * BUG-19-Rest — Default-Aktivierungszustand eines Topfes, wenn KEINE
 * persistierte `customer_budget_type_settings`-Zeile existiert. SSoT für alle
 * Lese-Defaults (GET type-settings, unified-reader, getBudgetSummary).
 *
 * §45b (Entlastungsbetrag) ist als einziger Topf grundsätzlich default-aktiv —
 * ABER nur für anspruchsberechtigte Kunden. Selbstzahler haben keinen Anspruch;
 * der Gate ist EXAKT derselbe wie auf allen Schreibpfaden
 * (`validateSelbstzahlerBudget`, keine Zweitprüfung). §45a/§39+§42a sind
 * grundsätzlich default-deaktiviert (Opt-in pro Kunde).
 *
 * Pure: kein DB-Zugriff. `billingType` = `customers.billingType`-Spalte.
 */
const STATUTORY_POT_DEFAULT_ENABLED: Record<string, boolean> = {
  entlastungsbetrag_45b: true,
  umwandlung_45a: false,
  ersatzpflege_39_42a: false,
};

export function defaultStatutoryPotEnabled(
  budgetType: string,
  billingType: string | null | undefined,
): boolean {
  const base = STATUTORY_POT_DEFAULT_ENABLED[budgetType] ?? false;
  if (!base) return false;
  return validateSelbstzahlerBudget({ billingType, intent: { budgetType } }).ok;
}

/**
 * Task #1353 — Pure SSoT für die Frage „Darf dieser Kunde einen privaten
 * (Selbstzahler-)Anteil bekommen?". Ein privater Anteil/Topf ist NUR erlaubt,
 * wenn der Kunde grundsätzlich privat zahlt:
 *   - `billingType === "selbstzahler"` (zahlt per Definition immer privat,
 *     unabhängig vom Flag `acceptsPrivatePayment`, das im UI für Selbstzahler
 *     gar nicht setzbar ist), ODER
 *   - `acceptsPrivatePayment === true` (Pflegekassen-Kunde, der Mehrkosten
 *     ausdrücklich privat tragen darf).
 *
 * Für reine Pflegekassen-Kunden ohne `acceptsPrivatePayment` ist ein privater
 * Anteil verboten — ein „Rest", der nicht in die gesetzlichen Töpfe passt,
 * MUSS blockieren (klare Sperre) statt still auf eine 19%-Privatrechnung zu
 * fallen (Jungnickel-/AOK-Fall).
 *
 * Diese Funktion ist die EINE Definition des Gates; alle Buchungs-/Rebook-/
 * Reservierungs-/Import-/Rechnungssplit-Pfade importieren sie, statt die
 * Formel (`acceptsPrivatePayment || selbstzahler`) parallel zu wiederholen.
 *
 * Pure: kein DB-Zugriff. Eingaben sind die `customers`-Spalten `billingType`
 * und `acceptsPrivatePayment`.
 */
export function isSelbstzahlerBillingType(
  billingType: string | null | undefined,
): boolean {
  return billingType === "selbstzahler";
}

export function isPrivatePaymentAllowed(input: {
  billingType: string | null | undefined;
  acceptsPrivatePayment: boolean | null | undefined;
}): boolean {
  return (
    (input.acceptsPrivatePayment ?? false) ||
    isSelbstzahlerBillingType(input.billingType)
  );
}
