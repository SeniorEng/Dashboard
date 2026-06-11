/**
 * Task #722 / #1168 — Pure Validator: §45a Umwandlungsanspruch UND §39/§42a
 * Verhinderungs-/Kurzzeitpflege sind erst ab Pflegegrad 2 verfügbar.
 *
 * - §45a setzt eine vorhandene Pflegesachleistung gem. §36 SGB XI voraus;
 *   Pflegegrad 1 hat darauf keinen Anspruch.
 * - §39/§42a (Verhinderungspflege/Kurzzeitpflege) setzt ebenfalls mindestens
 *   Pflegegrad 2 voraus; Pflegegrad 1 erhält nur den §45b-Entlastungsbetrag.
 *
 * Analog zu `validateSelbstzahlerBudget`: zentral, pure, Wire-stabiler
 * Error-Code, deutscher Fehlertext — damit Backend-Routen (Activate, Startwert,
 * Carryover, manuelle Korrektur, direkte Allocation, PUT type-settings,
 * Create-Pfad) und das Frontend dieselbe Quelle nutzen.
 *
 * GoBD-Anmerkung: Wird der Pflegegrad eines Kunden nachträglich auf < 2
 * abgesenkt, bleiben historisch angelegte Allokationen erhalten — neue
 * Buchungen/Settings werden hier hart geblockt. Korrektur ausschließlich
 * über Storno + Neuanlage.
 */

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

/**
 * Töpfe, die mindestens Pflegegrad 2 voraussetzen, mit pot-spezifischem
 * deutschem Fehlertext + Begründungen. §45b fehlt bewusst (ab PG1 verfügbar).
 */
const PG2_REQUIRED_POTS: Record<string, { message: string; reasons: string[] }> = {
  umwandlung_45a: {
    message: "§45a Umwandlungsanspruch ist erst ab Pflegegrad 2 verfügbar",
    reasons: [
      "§45a setzt eine vorhandene Pflegesachleistung gem. §36 SGB XI voraus.",
      "Pflegegrad 1 hat keinen Anspruch auf Pflegesachleistungen.",
    ],
  },
  ersatzpflege_39_42a: {
    message:
      "§39/§42a (Verhinderungspflege/Kurzzeitpflege) ist erst ab Pflegegrad 2 verfügbar",
    reasons: [
      "§39/§42a setzt mindestens Pflegegrad 2 voraus.",
      "Pflegegrad 1 hat keinen Anspruch auf Verhinderungs-/Kurzzeitpflege.",
    ],
  },
};

export function validatePflegegradBudget(
  input: PflegegradValidationInput,
): PflegegradValidationResult {
  const spec = PG2_REQUIRED_POTS[input.intent.budgetType];
  if (!spec) return { ok: true };
  const pg = input.pflegegrad ?? 0;
  if (pg >= 2) return { ok: true };
  return {
    ok: false,
    code: "BUDGET_NOT_AVAILABLE_FOR_PFLEGEGRAD",
    httpStatus: 409,
    message: spec.message,
    reasons: spec.reasons,
  };
}
