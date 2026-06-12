/**
 * SSoT: "Ist diese Import-Zeile reine Dokumentation (ohne Budgetverbrauch)?"
 *
 * Hintergrund: Die §45b-Onboarding-Baseline bodet den abgeleiteten Budget-Anker
 * auf den 1. Januar des laufenden Jahres (`floorAutoAnchor45bToCurrentYear`).
 * Für jedes Datum aus einem VORJAHR ist das gesetzliche §45b-Budget damit = 0 —
 * eine echte Consumption-Buchung würde immer hart blocken
 * ("Budget reicht nicht — … Kunde akzeptiert keine Privatzahlung.").
 *
 * Vorjahres-Termine von Pflegekassen-Kunden OHNE Privatzahlungs-Option werden
 * deshalb nur als Dokumentation angelegt (Termin-Datensatz ja, Budget-Buchung
 * nein). Selbstzahler / privat-zahlende Kunden behalten ihren regulären,
 * abrechenbaren Import-Pfad — bei ihnen routet die Kaskade in den ungedeckelten
 * Privat-Topf, es gibt also keine Blockade.
 *
 * Diese Funktionen sind die EINZIGE Quelle dieser Entscheidung; Vorschau
 * (`enrichWithBudgetInfo`) und Ausführung (`executeImport`) MÜSSEN beide hier
 * durch, damit Anzeige und Buchung nie auseinanderlaufen.
 */

/**
 * `true`, wenn das ISO-Datum (`YYYY-MM-DD`) in einem Kalenderjahr VOR dem
 * laufenden Jahr liegt. Spiegelt exakt die `year < currentYear`-Grenze, die die
 * §45b-Anker-Bodung verwendet.
 */
export function isPriorYearImportDate(date: string, now: Date = new Date()): boolean {
  const year = Number.parseInt(date.slice(0, 4), 10);
  if (!Number.isFinite(year)) return false;
  return year < now.getFullYear();
}

/**
 * `true`, wenn die Zeile als reine Dokumentation (kein Budgetverbrauch)
 * importiert werden muss: Vorjahres-Datum UND der Kunde akzeptiert keine
 * Privatzahlung (echte Pflegekasse ohne Selbstzahler-Routing).
 */
export function isDocumentationOnlyImport(params: {
  date: string;
  isPrivatePaymentAllowed: boolean;
  now?: Date;
}): boolean {
  return (
    isPriorYearImportDate(params.date, params.now ?? new Date()) &&
    !params.isPrivatePaymentAllowed
  );
}
