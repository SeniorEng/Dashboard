/**
 * SSoT für die Frage: **Lässt sich für diesen Kunden-Monat jetzt ein
 * Sammel-Leistungsnachweis erstellen?**
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Die zwei ANZEIGE-Flags, die dieselbe Formel wörtlich doppelt führten:
 *  1. `GET /api/service-records/overview` — das Flag der Übersichts-Kachel
 *  2. `GET /api/service-records/check-period` — das Flag der Detailseite
 *
 * Beide lauteten
 *     undocumentedCount === 0 && documentedCount > 0 && uncovered > 0
 *
 * ── Was es NICHT ersetzt (und warum nicht) ──────────────────────────────
 * Der dritte Ort, `POST /api/service-records`, hatte denselben Irrtum als
 * 400-Riegel. Der ist ERSATZLOS entfallen, nicht hierher gezogen: was dort
 * bleibt, sind zwei Längen-Checks mit je EIGENER Fehlermeldung („keine
 * dokumentierten Termine" / „alle bereits abgedeckt"). Ein Boolean könnte die
 * nicht unterscheiden, und die Meldung ist für den Aufrufer die eigentliche
 * Auskunft.
 *
 * Sie sind mit dieser Funktion inhaltlich deckungsgleich — nachgerechnet:
 * `uncovered = documented − covered`, und die Coverage-Bedingung trifft auf
 * derselben Menge exakt die von `getAppointmentIdsInServiceRecords`, also gilt
 * `uncovered > 0 ⟺ remainingAppointments.length > 0`. Deckungsgleich ist aber
 * nicht dasselbe wie geteilt: driftet eine der beiden Seiten, zeigt die
 * Oberfläche einen Knopf, den der Schreibpfad ablehnt. Der Registry-Wächter
 * unten hält deshalb wenigstens die FORMEL fest.
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
  // `documentedCount > 0` ist streng genommen redundant — `uncovered` ist als
  // `max(0, documented − covered)` definiert, kann also ohne dokumentierte
  // Termine nicht positiv werden. Es steht bewusst da: die Frage lautet „gibt
  // es dokumentierte Arbeit, und ist davon etwas offen?", und beide Hälften
  // sichtbar zu lassen macht die Regel lesbar statt nur kurz.
  return counts.documentedCount > 0 && counts.uncoveredDocumentedCount > 0;
}
