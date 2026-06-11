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
