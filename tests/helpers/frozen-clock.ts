import { vi } from "vitest";

/**
 * Friert die System-Zeit auf den angegebenen ISO-Zeitstempel ein.
 * Es werden ausschließlich `Date` und `Date.now` gefaked – `setTimeout`,
 * `setInterval` und `Promise`-Microtasks bleiben aktiv, damit reale I/O
 * (z.B. Postgres-Treiber, fetch) während des Freeze weiterlaufen kann.
 *
 * Wichtig: Jeder Test, der `freezeTime` aufruft, sollte sicherstellen, dass
 * `thawTime` wieder ausgeführt wird. Der globale `afterEach`-Hook in
 * `tests/setup.ts` übernimmt das automatisch, falls Tests es vergessen.
 */
export function freezeTime(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: false });
  vi.setSystemTime(new Date(iso));
}

/**
 * Hebt einen vorherigen `freezeTime`-Aufruf auf und schaltet alle Timer
 * wieder auf reale Implementierungen zurück. Mehrfaches Aufrufen ist
 * ein No-Op und kann gefahrlos in `afterEach` verwendet werden.
 */
export function thawTime(): void {
  vi.useRealTimers();
}

/**
 * Gibt das aktuelle Datum als `Date`-Objekt zurück. Ist `freezeTime` aktiv,
 * liefert dieser Aufruf automatisch die gefrorene Zeit (vi.setSystemTime
 * patcht den globalen `Date`-Konstruktor).
 */
export function currentDate(): Date {
  return new Date();
}
