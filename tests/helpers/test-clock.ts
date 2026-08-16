import {
  TEST_CLOCK_HEADER,
  clearProcessTestClock,
  resetTestClock,
  setProcessTestClock,
} from "../../server/lib/test-clock";

/**
 * §45b-Präventions-Cluster Welle 1 — Testseitige Fassade der injizierbaren Uhr.
 *
 * Ein Test hat ZWEI Uhren zu bewegen, und das ist der ganze Grund, warum es
 * diese Datei gibt:
 *
 *  1. den eigenen Prozess (direkte Storage-/Domain-Aufrufe), und
 *  2. den App-Server, der ein EIGENER Prozess mit eigener Systemzeit ist.
 *
 * `useTestClock` bewegt beide: den eigenen über den Provider in
 * `shared/utils/datetime.ts`, den Server über den `X-Test-Clock`-Header, den
 * `tests/test-utils.ts#fetchWithRetry` an jeden Request hängt. Wer nur eine von
 * beiden setzt, bekommt genau die Divergenz zurück, gegen die die Anker-Familie
 * in `billing-month.ts` gebaut war.
 *
 * ── Abgrenzung ──────────────────────────────────────────────────────────
 * `freezeTime`/`thawTime` (`frozen-clock.ts`) bleibt für reine In-Process-Tests
 * ohne HTTP das richtige Werkzeug — es faked den globalen `Date`-Konstruktor
 * und wirkt damit auch auf Code, der `new Date()` direkt aufruft statt über
 * `shared/utils/datetime.ts` zu gehen. Diese Uhr hier wirkt NUR auf die
 * Now-Leser der Datetime-SSoT, reicht dafür aber über die Prozessgrenze.
 *
 * ── VORRANG, wenn beide laufen ──────────────────────────────────────────
 * Für alles, was über `shared/utils/datetime.ts` geht, GEWINNT diese Uhr gegen
 * `freezeTime`: der Provider liefert den gesetzten Wert, bevor er je auf
 * `new Date()` (und damit auf den gefakten Konstruktor) zurückfällt.
 *
 * Wer beide braucht — typisch, wenn derselbe Pfad `todayISO()` UND rohes
 * `new Date()` für Zeitstempel benutzt — muss sie deshalb auf DENSELBEN
 * Zeitpunkt setzen. Ein stehengebliebenes `useTestClock` vom Seed macht ein
 * späteres `freezeTime` sonst wirkungslos, ohne dass irgendetwas warnt
 * (Repro: `tests/budget/race-writeoff.test.ts`, wo genau das null statt einen
 * write_off ergab).
 */

/** Aktuell gesetztes Testdatum, oder `null` für Echt-Uhr. */
let activeISO: string | null = null;

/**
 * Gate-2-Fund S1 — Wächter gegen die stille `beforeAll`-Falle.
 *
 * `tests/setup.ts#afterEach` räumt nach JEDEM Test ab. Eine in `beforeAll`
 * gesetzte Uhr wirkt deshalb nur für den ERSTEN Test der Datei; ab dem zweiten
 * misst sie gegen die Echt-Uhr — ohne Warnung, ohne Rot. Genau der stille
 * Fehlschlag, gegen den diese Naht gebaut ist.
 *
 * Ein Test, der eine Uhr BRAUCHT, ruft das hier und macht daraus einen lauten.
 * Bewusst eine positive Zusicherung („jetzt muss eine gesetzt sein") und kein
 * Verlaufs-Merker: Dateien dürfen geclockte und ungeclockte Tests mischen
 * (`tests/equality/45b-fifo-breakdown-consistency.test.ts` tut das bewusst),
 * ein Merker gäbe dort Fehlalarm.
 *
 * Bewusst auch KEIN automatischer `beforeEach` in `useTestClock`: Hooks lassen
 * sich in Vitest nur während der Collection-Phase registrieren, aus einem
 * Testkörper heraus schlüge das fehl. Ein expliziter Wächter ist ehrlicher als
 * ein Hook, der je nach Aufrufort wirkt oder nicht.
 */
export function assertTestClockActive(): void {
  if (activeISO !== null) return;
  throw new Error(
    "Testuhr ist nicht gesetzt, dieser Test braucht aber eine. Ursache ist fast " +
      "immer `useTestClock` in `beforeAll` statt `beforeEach`: " +
      "`tests/setup.ts#afterEach` stellt nach JEDEM Test die Echt-Uhr her, die " +
      "Uhr wirkt dann nur für den ersten Test der Datei. Ohne diesen Wächter " +
      "würde der Test still gegen den Lauftag messen.",
  );
}

/** Liest `tests/test-utils.ts`, um den Header an jeden Request zu hängen. */
export function activeTestClockISO(): string | null {
  return activeISO;
}

export { TEST_CLOCK_HEADER };

/**
 * Setzt Testprozess UND App-Server auf `iso` — für `beforeAll`/`beforeEach`.
 * Muss über `clearTestClock()` zurückgenommen werden; das Sicherheitsnetz in
 * `tests/setup.ts#afterEach` tut das ohnehin.
 *
 * `iso` ist "YYYY-MM-DD" (lokale Mittagszeit dieses Tages) oder ein
 * vollständiger ISO-Zeitstempel, wenn die Uhrzeit selbst zählt.
 */
export function useTestClock(iso: string): void {
  setProcessTestClock(iso);
  activeISO = iso;
}

/** Stellt die Echt-Uhr auf beiden Seiten wieder her. Idempotent. */
export function clearTestClock(): void {
  clearProcessTestClock();
  resetTestClock();
  activeISO = null;
}

/**
 * Scoped-Variante: führt `fn` unter `iso` aus und stellt danach den vorherigen
 * Zustand wieder her — auch bei Fehlern. Für Tests, die MEHRERE Stichtage im
 * selben Testkörper brauchen (z.B. die 30.06.-Kante: einmal am 30.06., einmal
 * am 01.07., ohne den Test zu teilen).
 */
export async function withTestClock<T>(iso: string, fn: () => Promise<T> | T): Promise<T> {
  const vorher = activeISO;
  useTestClock(iso);
  try {
    return await fn();
  } finally {
    if (vorher === null) clearTestClock();
    else useTestClock(vorher);
  }
}
