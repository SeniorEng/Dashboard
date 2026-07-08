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

/**
 * Liefert die überwachten Konten OHNE das primäre Geschäftskonto — also nur die
 * nachträglich hinzugekommenen Zusatzkonten. Wird für den einmaligen Voll-Sync
 * (Backfill) genutzt: das primäre Konto hat historisch bereits einen laufenden
 * inkrementellen Sync, nur die später ergänzten Konten haben Transaktionen
 * außerhalb des `updated_at_from`-Fensters.
 */
export function resolveAdditionalMonitoredIbans(
  settings: MonitoredIbanSettings,
): string[] {
  const all = resolveMonitoredIbans(settings);
  const primary = (settings.qontoIban ?? "").trim();
  if (!primary) return all;
  const primaryKey = normalizeIban(primary);
  return all.filter((iban) => normalizeIban(iban) !== primaryKey);
}

/**
 * Task #1717 — Liefert die überwachten IBANs, die in `after` NEU hinzugekommen
 * sind (in `after`, aber nicht in `before`). Vergleich erfolgt normalisiert
 * (Whitespace/Groß-Klein egal), damit reine Formatierungsänderungen NICHT als
 * „neu" gelten. Ergebnis behält die Formatierung aus `after`.
 *
 * SSoT für „welches Konto wurde gerade ergänzt?" — genutzt vom Schreibpfad der
 * Firmen-Einstellungen (Server: automatischer Backfill anstoßen) UND von der
 * Einstellungen-UI (Client: „Voll-Sync gestartet"-Rückmeldung), damit beide
 * Seiten dieselbe Diff-Logik verwenden.
 */
export function resolveNewlyAddedMonitoredIbans(
  before: MonitoredIbanSettings,
  after: MonitoredIbanSettings,
): string[] {
  const beforeKeys = new Set(resolveMonitoredIbans(before).map(normalizeIban));
  return resolveMonitoredIbans(after).filter(
    (iban) => !beforeKeys.has(normalizeIban(iban)),
  );
}
