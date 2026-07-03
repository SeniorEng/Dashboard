/**
 * Task #1587 — SSoT für "welche Qonto-Konten synchronisieren wir?".
 *
 * Pflegekassen haben Zahlungen versehentlich auf ein zweites Qonto-Konto
 * (andere IBAN, aber gleicher Qonto-Login) überwiesen. Der Zahlungsabgleich
 * muss daher Transaktionen ALLER hinterlegten Konten desselben Logins
 * einsammeln. `qontoIban` bleibt das primäre Geschäftskonto,
 * `qontoAdditionalIbans` sind weitere überwachte Konten.
 *
 * Diese Funktion ist die EINZIGE Stelle, die die Liste der überwachten
 * IBANs zusammensetzt. Sync, testConnection und Status lesen ausschließlich
 * darüber, statt verstreut `settings.qontoIban` zu lesen.
 */

/** Normalisiert eine IBAN für Vergleich/Dedup: Whitespace weg, Großschreibung. */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

export interface MonitoredIbanSettings {
  qontoIban?: string | null;
  qontoAdditionalIbans?: string[] | null;
}

/**
 * Liefert die deduplizierte, in Eingabe-Reihenfolge stabile Liste aller
 * überwachten IBANs (primäres Geschäftskonto zuerst). Leerwerte werden
 * ignoriert, Duplikate (auch mit abweichender Formatierung) entfernt.
 */
export function resolveMonitoredIbans(settings: MonitoredIbanSettings): string[] {
  const candidates = [
    settings.qontoIban ?? "",
    ...(settings.qontoAdditionalIbans ?? []),
  ];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of candidates) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) continue;
    const key = normalizeIban(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}
