/**
 * Task #603 — Migration deaktiviert.
 *
 * Ursprünglich (Task #425) sollte diese einmalige Migration den veralteten
 * `monthly_limit_cents`-Wert für §45b-Topfkonfigurationen auf NULL setzen,
 * weil §45b auf das Jahrestopf-Modell ohne Monats-Cap umgestellt wurde.
 *
 * Mit Task #603 wird der Wert wieder als per-Kunde konfigurierbarer
 * "Unser Anteil"-Betrag (€/Monat) verwendet — er reduziert die monatliche
 * Aufstockung des Jahrestopfs (KEIN harter Cap). Die Migration darf daher
 * konfigurierte Werte beim Re-Deploy NICHT mehr wegwerfen.
 *
 * Die Funktion bleibt als No-Op bestehen, damit der Startup-Aufruf in
 * `server/index.ts` keine Signatur-Anpassung benötigt.
 */
export async function clear45bMonthlyLimits(): Promise<void> {
  return;
}
