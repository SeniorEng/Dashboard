import { vi } from "vitest";
import { parseTestClock } from "../../server/lib/test-clock";
import { activeTestClockISO } from "./test-clock";

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
  assertKeinUhrKonflikt(iso);
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: false });
  vi.setSystemTime(new Date(iso));
}

/**
 * Gate-2-Fund S3 — der stille Vorrang gegenüber der injizierbaren Uhr.
 *
 * Für alles, was über `shared/utils/datetime.ts` geht (`todayISO`,
 * `currentYearAndMonth`, …), GEWINNT eine gesetzte Testuhr gegen diesen Freeze:
 * der Provider liefert ihren Wert, bevor er je auf `new Date()` — und damit auf
 * den hier gefakten Konstruktor — zurückfällt.
 *
 * Ein stehengebliebenes `useTestClock` vom Seed macht ein späteres `freezeTime`
 * also wirkungslos, ohne dass irgendetwas warnt. Genau das ist beim Bau dieser
 * Naht passiert (`tests/budget/race-writeoff.test.ts`: null statt einem
 * `write_off`, weil die Uhr noch auf dem Seed-Tag stand).
 *
 * Deshalb: beide auf denselben Zeitpunkt zu setzen ist erlaubt und der übliche
 * Fall (ein Pfad liest `todayISO()`, ein anderer rohes `new Date()`). Auf
 * VERSCHIEDENE Zeitpunkte zu setzen ist fast immer der Fehler oben — und
 * scheitert ab hier laut statt still.
 */
function assertKeinUhrKonflikt(iso: string): void {
  const uhr = activeTestClockISO();
  if (uhr === null) return;
  const freeze = new Date(iso).getTime();
  const gesetzt = parseTestClock(uhr).getTime();
  if (freeze === gesetzt) return;
  throw new Error(
    `freezeTime("${iso}") widerspricht der gesetzten Testuhr ("${uhr}"). ` +
      "Für alles über shared/utils/datetime.ts gewinnt die Testuhr — der Freeze " +
      "bliebe wirkungslos und der Test würde still gegen den falschen Tag messen. " +
      "Entweder beide auf denselben Zeitpunkt setzen (useTestClock + freezeTime), " +
      "oder vorher clearTestClock() rufen.",
  );
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
