/**
 * SSoT für die Frage: **Lässt sich für diesen Kunden-Monat jetzt ein
 * Sammel-Leistungsnachweis erstellen?**
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Drei wörtliche Kopien derselben Formel, die sich alle drei gleich geirrt
 * haben:
 *  1. `GET /api/service-records/overview` — das Flag der Übersichts-Kachel
 *  2. `GET /api/service-records/check-period` — das Flag der Detailseite
 *  3. `POST /api/service-records` — der tatsächlich durchgesetzte Riegel
 *
 * Alle drei lauteten
 *     undocumentedCount === 0 && documentedCount > 0 && uncovered > 0
 * bzw. serverseitig „wirf 400, wenn irgendein Termin noch offen ist".
 *
 * ── Die Regel, die dabei falsch war ─────────────────────────────────────
 * Der Term `undocumentedCount === 0` machte das Bündeln ALL-OR-NOTHING: ein
 * einziger noch offener Termin sperrte auch die bereits dokumentierten des
 * Monats. Wer am 3. dokumentiert hatte und am 17. noch einen offenen Termin
 * hatte, konnte die Arbeit vom 3. nicht abrechnen — bis der ganze Monat fertig
 * war.
 *
 * Zusammen mit der Bucket-Priorität der Übersicht (dort brach die Einordnung
 * beim ersten Treffer ab) hatte das eine härtere Folge als „unbequem": der
 * dokumentierte, noch nicht gebündelte Termin fiel in KEINE sichtbare
 * Kategorie. Er war weder als „zu dokumentieren" noch als „bereit" zu sehen —
 * unsichtbar und unabrechenbar zugleich.
 *
 * ── Warum das Lockern klein ist ─────────────────────────────────────────
 * Teilweises Bündeln ist bereits gebaut: `POST /api/service-records` nimmt
 * seit Task #1542 eine `appointmentIds`-Auswahl entgegen und prüft sie gegen
 * die noch nicht abgedeckten, dokumentierten Termine. Es fehlte nur die
 * Erlaubnis, diesen Weg zu gehen, solange der Monat noch läuft.
 *
 * ── Was ausdrücklich NICHT gelockert wird ───────────────────────────────
 * Ein Nachweis darf weiterhin nur DOKUMENTIERTE und noch nicht abgedeckte
 * Termine enthalten. Offene Termine bleiben offen; sie wandern nicht
 * stillschweigend in den Nachweis und verschwinden auch nicht aus der
 * „noch zu dokumentieren"-Liste. Wer den Monat fertig macht, erstellt einen
 * zweiten Sammel-LN — mehrere pro Monat sind seit #1542 gewollt möglich.
 */

export interface BundlingCounts {
  /** Dokumentierte Termine des Mitarbeiters im Kunden-Monat. */
  documentedCount: number;
  /** Davon noch durch KEINEN Nachweis abgedeckt. */
  uncoveredDocumentedCount: number;
}

/**
 * Gibt es etwas zu bündeln?
 *
 * Bewusst OHNE Blick auf offene Termine: die sind eine Aussage über den Rest
 * des Monats, nicht über die bereits geleistete Arbeit.
 */
export function canBundleDocumentedAppointments(counts: BundlingCounts): boolean {
  return counts.documentedCount > 0 && counts.uncoveredDocumentedCount > 0;
}
