/**
 * Task #1376: SSoT für die erlaubten Rechnungs-Status-Übergänge.
 *
 * Diese Map ERSETZT die zuvor lokal im Handler `PATCH /billing/:id/status`
 * definierte `allowedTransitions`-Konstante. Sowohl der Einzel-Statuswechsel
 * als auch der neue Sammel-Statuswechsel (`POST /billing/bulk-status`) lesen
 * dieselbe Quelle, damit beide Pfade niemals auseinanderdriften.
 *
 * Lebenszyklus (Task #1284):
 *   Entwurf → Versendet → Avis erhalten → Bezahlt (+ Storniert).
 * "avis_erhalten" liegt zwischen Versendet und Bezahlt. Manuell darf von
 * versendet/avis_erhalten direkt auf bezahlt gesprungen werden;
 * bezahlt/storniert werden nie herabgestuft.
 *
 * Task #1434 / #66: "versendet" → "entwurf" ist ENTFERNT. Der Übergang war der
 * Einstieg in die Belegnummern-Wiedervergabe: zurücksetzen leerte `sentAt`,
 * danach griff der Entwurfs-Löschpfad, die Rechnung verschwand hart und ihre
 * Nummer wurde neu vergeben — dieselbe Belegnummer bezeichnete zwei Dokumente.
 *
 * ERSETZT durch zwei getrennte, jeweils ausdrückliche Wege:
 *  - Inhaltliche Änderung einer ausgegebenen Rechnung → **Storno +
 *    Neuausstellung** (bestehender Flow, neue Nummer, Original referenziert).
 *  - Versehentliche Markierung, nichts versandt → `POST /:id/revoke-sent-mark`,
 *    das die Ausgabe-Marke ausdrücklich und protokolliert zurücknimmt. Kein
 *    stiller Status-Flip über den generischen Status-Endpunkt.
 *
 * Task #1822: "teilweise_bezahlt" (Teilzahlung) ist ein ABGELEITETER Status —
 * er wird NUR durch den Zahlungsabgleich vergeben (versendet/avis_erhalten →
 * teilweise_bezahlt), niemals manuell über den Status-Endpoint. Diese Map steuert
 * ausschließlich den MANUELLEN Statuswechsel; die Zahlungs-Schreibpfade setzen
 * den Status über eigene geguardete Direkt-Updates (nicht über diese Map).
 * Deshalb ist "teilweise_bezahlt" hier NUR als Ausgangs-Status (`from`)
 * hinterlegt (manuell darf ein Sachbearbeiter eine teilbezahlte Rechnung noch
 * auf "bezahlt" akzeptieren oder stornieren), aber NICHT als manuelles Ziel.
 */
export const INVOICE_STATUS_TRANSITIONS: Record<string, string[]> = {
  entwurf: ["versendet", "storniert"],
  versendet: ["avis_erhalten", "bezahlt", "storniert"],
  avis_erhalten: ["bezahlt", "storniert"],
  teilweise_bezahlt: ["bezahlt", "storniert"],
  bezahlt: ["storniert"],
  storniert: [],
};

/** Ist der Übergang `from → to` laut SSoT erlaubt? */
export function isAllowedInvoiceStatusTransition(from: string, to: string): boolean {
  return INVOICE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
