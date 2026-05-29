/**
 * Task #705 / #716 — Pure Validator: Selbstzahler dürfen §45b
 * (Entlastungsbetrag) nicht aktivieren, keinen Startwert/Carryover anlegen,
 * keine manuelle Korrektur fahren und keine direkte Allocation schreiben.
 *
 * §45b ist eine Pflegekassenleistung (SGB XI). Wer privat zahlt
 * (`billingType === "selbstzahler"`), hat keinen Anspruch — die Regel lebt
 * deshalb zentral hier, damit Backend-Routen UND Frontend-Formular denselben
 * Code (und denselben deutschen Fehlertext) aufrufen.
 *
 * Pure: kein DB-Zugriff, kein Cache. Eingabe ist die `billingType`-Spalte des
 * Kunden plus die Buchungs-/Edit-Intent-Beschreibung.
 */
// @ts-nocheck


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

const MESSAGE = "§45b Entlastungsbetrag ist für Selbstzahler nicht verfügbar.";
const REASONS = [
  "§45b ist eine gesetzliche Pflegekassenleistung (SGB XI).",
  "Selbstzahler haben keinen Anspruch auf den Entlastungsbetrag.",
];

export function validateSelbstzahler45b(
  input: SelbstzahlerValidationInput,
): SelbstzahlerValidationResult {
  if (input.intent.budgetType !== "entlastungsbetrag_45b") return { ok: true };
  if (input.billingType !== "selbstzahler") return { ok: true };
  return {
    ok: false,
    code: "BUDGET_NOT_AVAILABLE_FOR_SELBSTZAHLER",
    httpStatus: 409,
    message: MESSAGE,
    reasons: REASONS,
  };
}
