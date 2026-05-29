/**
 * Task #722 — Pure Validator: §45a Umwandlungsanspruch ist erst ab
 * Pflegegrad 2 verfügbar (SGB XI §45a setzt eine vorhandene
 * Pflegesachleistung gem. §36 SGB XI voraus; Pflegegrad 1 hat keinen
 * Anspruch auf Pflegesachleistungen).
 *
 * Analog zu `validateSelbstzahler45b` (#705/#716): zentral, pure,
 * Wire-stabiler Error-Code, deutscher Fehlertext — damit Backend-Routen
 * (Activate, Startwert, Carryover, manuelle Korrektur, direkte
 * Allocation) und ggf. das Frontend dieselbe Quelle nutzen.
 *
 * Out of scope (eigene Anspruchsregeln, ggf. Folge-Task):
 *   - §39/§42a Verhinderungspflege/Kurzzeitpflege.
 *
 * GoBD-Anmerkung: Wird der Pflegegrad eines Kunden nachträglich auf < 2
 * abgesenkt, bleiben historisch angelegte Allokationen erhalten — neue
 * Buchungen/Settings werden hier hart geblockt. Korrektur ausschließlich
 * über Storno + Neuanlage.
 */
// @ts-nocheck


export type PflegegradValidationOk = { ok: true };

export type PflegegradValidationError = {
  ok: false;
  /** Wire-stabiler Fehlercode für Frontend-Mapping. */
  code: "BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD";
  /** HTTP-Status für Express-Antworten — 409 analog zum Selbstzahler-Pattern. */
  httpStatus: 409;
  /** Primärer (deutscher) Fehlertext für Toast/Banner. */
  message: string;
  /** Detail-Liste deutscher Begründungs-Texte für mehrzeilige UI-Anzeige. */
  reasons: string[];
};

export type PflegegradValidationResult =
  | PflegegradValidationOk
  | PflegegradValidationError;

export interface PflegegradValidationInput {
  /** `customers.pflegegrad` (1–5 oder null/undefined bei fehlendem Bescheid). */
  pflegegrad: number | null | undefined;
  intent: {
    /** Topf, der angefasst werden soll. */
    budgetType: string;
  };
}

const MESSAGE_45A = "§45a Umwandlungsanspruch ist erst ab Pflegegrad 2 verfügbar";
const REASONS_45A = [
  "§45a setzt eine vorhandene Pflegesachleistung gem. §36 SGB XI voraus.",
  "Pflegegrad 1 hat keinen Anspruch auf Pflegesachleistungen.",
];

export function validatePflegegrad45a(
  input: PflegegradValidationInput,
): PflegegradValidationResult {
  if (input.intent.budgetType !== "umwandlung_45a") return { ok: true };
  const pg = input.pflegegrad ?? 0;
  if (pg >= 2) return { ok: true };
  return {
    ok: false,
    code: "BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD",
    httpStatus: 409,
    message: MESSAGE_45A,
    reasons: REASONS_45A,
  };
}
