/**
 * Task #1571 — SSoT für die Anzeige des „Partei-Namens" eines Termins.
 *
 * Termine ohne Kundenzuordnung sind fast immer Interessenten-/Erstberatungs-
 * termine (`customer_id` NULL, `prospect_id` gesetzt). Statt eines leeren
 * Namens oder eines nichtssagenden Platzhalters soll dann überall (Mitarbeiter-
 * abrechnung, Dashboard-/Kalender-Listen, Lexware-/Payroll-Export …) einheitlich
 * der Interessenten-Name im Format „Interessent: <Name>" erscheinen.
 *
 * Diese Funktion ist die EINE geteilte Auflöse-Logik (SSoT); jede Ansicht, die
 * kundenlose Termine listet, MUSS sie verwenden statt die Reihenfolge neu zu
 * implementieren.
 */

/** Platzhalter, wenn weder Kunde noch Interessent auflösbar ist. */
export const UNRESOLVED_CUSTOMER_LABEL = "Kein Kunde zugeordnet";

/** Präfix für aufgelöste Interessenten-Namen. */
export const PROSPECT_NAME_PREFIX = "Interessent: ";

/**
 * Löst den anzuzeigenden Namen eines Termins auf:
 * 1. Kundenname, falls vorhanden
 * 2. sonst „Interessent: <Name>", falls ein Interessent auflösbar ist
 * 3. sonst der Platzhalter
 */
export function resolveAppointmentPartyName(
  customerName: string | null | undefined,
  prospectName: string | null | undefined,
): string {
  if (customerName) return customerName;
  if (prospectName) return `${PROSPECT_NAME_PREFIX}${prospectName}`;
  return UNRESOLVED_CUSTOMER_LABEL;
}
