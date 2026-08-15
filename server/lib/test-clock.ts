import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";
import { setClockProvider, resetClockProvider } from "@shared/utils/datetime";

/**
 * §45b-Präventions-Cluster Welle 1 — Mechanik der injizierbaren Uhr (Testwerkzeug, Serverseite).
 *
 * Die NAHT liegt in `shared/utils/datetime.ts` (Provider mit Echt-Uhr als
 * Default). Hier liegt die Mechanik, die sie füttert — getrennt, weil
 * `shared/` auch in den Browser gebündelt wird und keinen `node:`-Import
 * verträgt.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Die drei §45b-Fristen-Anker aus `tests/helpers/billing-month.ts`
 * (`carryoverAnchor`, `expirySubjectAnchor`, `expiredCarryoverAnchor`). Sie
 * existierten ausschließlich, weil die Uhr des App-Servers nicht bewegt werden
 * konnte, und rechneten das Kalenderjahr deshalb relativ zu „heute" aus. Ihr
 * eigener Docstring benennt den Grund: „einen Clock-Override kennt der Server
 * nicht." Ab hier kennt er ihn, und ein Test setzt schlicht das Datum.
 *
 * NICHT ersetzt: `freezeTime`/`thawTime` (`tests/helpers/frozen-clock.ts`) für
 * reine In-Process-Unit-Tests ohne HTTP, sowie `billingReferenceDate` /
 * `pastWeekdayInBillingMonth` — die lösen Fixture-Arithmetik im Testprozess,
 * nicht die Server-Uhr.
 *
 * ── Zwei Eingänge, EINE Quelle ──────────────────────────────────────────
 *  1. `testClockMiddleware` — liest `X-Test-Clock` pro Request und fährt den
 *     gesamten Request-Baum im ALS-Store. Per-Request statt prozessglobal, weil
 *     der Orchestrator jedem Vitest-Fork EINEN Server gibt und Dateien auf
 *     demselben Worker sequenziell dagegen laufen: ein globaler Wert würde bei
 *     vergessenem Reset in die nächste Datei lecken. Per-Request kann das nicht
 *     und erlaubt 30.06. und 01.07. im selben Test.
 *  2. `runWithClock(iso, fn)` — dasselbe für In-Process-Aufrufe (Tests, die
 *     Storage-Funktionen direkt importieren, ohne HTTP).
 *
 * Dazu `setProcessTestClock` als unskalierter Rückfall für Setup auf
 * `describe`-Ebene. Auflösungsreihenfolge im Provider:
 *
 *     ALS-Store  →  Prozess-Override  →  Echt-Uhr
 *
 * ── Fail-closed ─────────────────────────────────────────────────────────
 * Jeder Einstieg installiert den Provider über `setClockProvider`, das
 * außerhalb `NODE_ENV === "test"` wirft. Die Middleware wird in
 * `server/index.ts` außerhalb `NODE_ENV === "test"` gar nicht registriert — ein
 * `X-Test-Clock`-Header gegen Produktion trifft auf keinen Leser. Bewacht von
 * `tests/architecture/injectable-clock.test.ts`.
 */

/** Header, über den ein Test dem Server-Prozess sein „heute" mitgibt. */
export const TEST_CLOCK_HEADER = "x-test-clock";

const clockStore = new AsyncLocalStorage<Date>();

/** Unskalierter Rückfall für `describe`-weites Setup (siehe `setProcessTestClock`). */
let processOverride: Date | null = null;

/** Wurde der Provider schon in die Naht gehängt? Installation ist idempotent. */
let installed = false;

/**
 * Hängt den Provider in die Naht. Lazy und idempotent — bewusst NICHT beim
 * Modul-Import: `NODE_ENV=test` wird teils erst in `tests/setup.ts#beforeAll`
 * gesetzt, ein Import-Zeit-Aufruf liefe in den Fail-closed-Guard.
 */
function install(): void {
  if (installed) return;
  setClockProvider(() => clockStore.getStore() ?? processOverride ?? new Date());
  installed = true;
}

/**
 * Parst den Testuhr-Wert.
 *
 *  - `YYYY-MM-DD`      → lokale MITTAGSZEIT dieses Tages. Bewusst nicht
 *    Mitternacht: an der Tagesgrenze würde jede Zeitzonen-/DST-Verschiebung den
 *    Tag kippen, und `currentTimeHHMMSS()` läse „00:00:00", was Fixtures mit
 *    Uhrzeit-Arithmetik in den Vortag drückt.
 *  - Voller ISO-Zeitstempel → exakt so übernommen (für Tests, die die Uhrzeit
 *    selbst prüfen, z.B. den Verfall um 00:01 des 01.07.).
 */
export function parseTestClock(value: string): Date {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Ungültiger Testuhr-Wert: "${value}". Erwartet "YYYY-MM-DD" oder einen vollständigen ISO-Zeitstempel.`,
    );
  }
  return parsed;
}

/**
 * Führt `fn` mit fest gesetzter Uhr aus (In-Process-Eingang). Der Wert gilt für
 * den gesamten asynchronen Baum unterhalb von `fn` und endet mit ihm — kein
 * Aufräumen nötig, kein Leck in den nächsten Test.
 */
export function runWithClock<T>(iso: string, fn: () => T): T {
  install();
  return clockStore.run(parseTestClock(iso), fn);
}

/**
 * Setzt die Uhr unskaliert für den laufenden Prozess — für Setup auf
 * `describe`-Ebene, wo sich der Testkörper nicht in einen Callback einwickeln
 * lässt. MUSS mit `clearProcessTestClock` zurückgenommen werden; das
 * Sicherheitsnetz in `tests/setup.ts#afterEach` tut das ohnehin.
 */
export function setProcessTestClock(iso: string): void {
  install();
  processOverride = parseTestClock(iso);
}

/** Nimmt `setProcessTestClock` zurück. Idempotent. */
export function clearProcessTestClock(): void {
  processOverride = null;
}

/**
 * Stellt den Auslieferungszustand her: Echt-Uhr, kein Override, Provider aus
 * der Naht ausgehängt. Sicherheitsnetz für `afterEach`.
 */
export function resetTestClock(): void {
  processOverride = null;
  installed = false;
  resetClockProvider();
}

/**
 * Express-Middleware: liest `X-Test-Clock` und fährt den Request im Store.
 *
 * Wird in `server/index.ts` NUR unter `NODE_ENV === "test"` registriert. Ein
 * unlesbarer Wert scheitert mit 400 statt still auf die Echt-Uhr zurückzufallen
 * — eine Testuhr, die klammheimlich nicht wirkt, wäre schlimmer als keine.
 */
export function testClockMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = req.header(TEST_CLOCK_HEADER);
  if (!raw) {
    next();
    return;
  }
  let when: Date;
  try {
    install();
    when = parseTestClock(raw);
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : String(err) });
    return;
  }
  clockStore.run(when, next);
}
