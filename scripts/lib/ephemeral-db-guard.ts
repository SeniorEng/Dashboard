// ---------------------------------------------------------------------------
// Fail-fast-Guard gegen Test-Läufe auf einer NICHT-Wegwerf-Datenbank (Task #1427)
//
// Integrationstests dürfen AUSSCHLIESSLICH gegen wegwerfbare DBs laufen, die der
// Orchestrator `scripts/with-ephemeral-db.ts` pro Lauf/Worker bereitstellt
// (Präfix `cc_test_`). Wird `vitest run` direkt (ohne Orchestrator) gestartet,
// erbt der Prozess die Dev-`DATABASE_URL` — das DB-Umrouting in `tests/setup.ts`
// greift dann NICHT (es hängt an `TEST_DATABASE_URLS`) und ALLE Tests würden
// still in die Dev-DB schreiben und sie mit Test-Daten fluten.
//
// Diese Datei enthält die reine, testbare Entscheidungslogik (kein DB-Zugriff).
// Sie ist die EINE Quelle der Allow-List ("ist das eine erlaubte Wegwerf-DB?")
// und wird an vier Stellen wiederverwendet:
//   - `tests/globalSetup.ts` (`assertEphemeralTestDb`) bricht den Vitest-Lauf VOR
//     den Integrationstests ab.
//   - der App-Server-Boot (Task #1429, `server/startup/assert-ephemeral-test-db.ts`)
//     verweigert den Start, wenn er in `NODE_ENV=test` gegen eine Nicht-Wegwerf-DB
//     hochfahren würde (z.B. die Dev-`Start application`-Konfiguration).
//   - die schreibenden Entrypoints (`assertEphemeralDbForWrite`): `drizzle.config.ts`
//     sowie die beiden Test-Seeds. Sie lasen `DATABASE_URL` vorher ungeprüft.
// Sie liegt daher hier in `scripts/lib/` (neben dem Prefix-SSoT
// `ephemeral-db-sweep.ts`) — neutral importierbar von Tests UND vom Server.
//
// ERSETZT den `guard()`-Shell-Zaun, den CLAUDE.md für den lokalen Test-Ablauf
// vorgab: der hing daran, dass ihn jemand vor jeden schreibenden Schritt tippt.
// Die Prüfung sitzt jetzt in den Entrypoints selbst.
// ---------------------------------------------------------------------------
import { DB_PREFIX } from "./ephemeral-db-sweep.ts";
import {
  evaluateTestDbTarget,
  type WegwerfZiel,
} from "../../shared/ephemeral-db-target.ts";

function dbNameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const name = u.pathname.replace(/^\//, "").trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

// Die Auswertung selbst liegt jetzt in `shared/ephemeral-db-target.ts` — die
// Laufzeit-Schreibsperre (`server/lib/prod-write-lock.ts`) braucht dieselbe
// Antwort, und `server/**` darf nicht aus `scripts/**` importieren. Hier bleibt
// nur die Re-Export-Schicht, damit alle bisherigen Importeure unveraendert
// weiterlaufen.
//
// RELATIVER Import, kein `@shared/*`-Alias: diese Datei wird von
// `drizzle.config.ts` geladen, und das laedt drizzle-kit ohne tsconfig-Pfade.
// Mit dem Alias scheiterte der Config-Load mit "Cannot find module" — also
// genau der Prod-Migrationspfad. Derselbe Grund, aus dem die Config
// `import type` statt eines Laufzeit-Imports benutzt.
export type TestDbTarget = WegwerfZiel;
export { evaluateTestDbTarget };

/**
 * Wie `assertEphemeralTestDb`, aber ohne DB-Pflicht.
 *
 * Für das `unit`-Projekt: die meisten Unit-Tests brauchen gar keine Datenbank,
 * und `assertEphemeralTestDb` wirft bei NICHT gesetzter `DATABASE_URL`
 * (Pfad 3, `dbName === null`) — ein blosses `vitest run --project unit` wäre
 * damit neu rot geworden.
 *
 * Die gefährliche Richtung bleibt fail-closed: ist eine `DATABASE_URL`
 * gesetzt, MUSS sie auf eine Wegwerf-DB zeigen. Nur „gar keine DB" ist
 * erlaubt — daran kann per Konstruktion nichts kaputtgehen.
 */
export function assertEphemeralTestDbIfConfigured(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const hatUrl = (env.DATABASE_URL || "").trim().length > 0;
  const hatOrchestrator = (env.TEST_DATABASE_URLS || "").trim().length > 0;
  if (!hatUrl && !hatOrchestrator) return;
  assertEphemeralTestDb(env);
}

// Bricht den Testlauf hart ab, wenn die Ziel-DB keine Wegwerf-DB ist.
export function assertEphemeralTestDb(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = evaluateTestDbTarget(env);
  if (result.ok) return;

  const target = result.dbName ? `„${result.dbName}"` : "(DATABASE_URL nicht gesetzt)";
  throw new Error(
    [
      "",
      "==============================================================================",
      "  ABBRUCH: Tests laufen gegen eine NICHT-Wegwerf-Datenbank (Task #1427).",
      "==============================================================================",
      `  Ziel-DB ${target} ist keine Ephemeral-/Wegwerf-DB (Präfix '${DB_PREFIX}').`,
      "",
      "  Integrationstests DÜRFEN NUR gegen wegwerfbare DBs laufen, die der",
      "  Orchestrator scripts/with-ephemeral-db.ts bereitstellt — sonst wird die",
      "  Dev-Datenbank mit Test-Daten geflutet.",
      "",
      "  Richtig starten:  über den Workflow »test« (npx tsx",
      "                    scripts/with-ephemeral-db.ts 5050 npx vitest run).",
      "  Ein direktes »vitest run« gegen die geerbte DATABASE_URL ist blockiert.",
      "==============================================================================",
      "",
    ].join("\n"),
  );
}

// Rahmen für die Abbruch-Meldungen der schreibenden Entrypoints.
function blockMessage(headline: string, lines: string[]): string {
  return [
    "",
    "==============================================================================",
    `  ABBRUCH: ${headline}`,
    "==============================================================================",
    ...lines.map((l) => (l.length > 0 ? `  ${l}` : "")),
    "==============================================================================",
    "",
  ].join("\n");
}

// Absichtserklärung für die schreibenden Entrypoints. EIN Marker für alle drei
// (Schema-Push + beide Seeds), weil es dieselbe fachliche Frage ist: „darf dieser
// schreibende Aufruf auf eine Nicht-Wegwerf-DB?". Er wird ausschliesslich von den
// Skripten gesetzt, die genau das beabsichtigen — nie global in einer Shell:
//   - `scripts/migrate.sh`      Prod-Migration (Coolify-Pre-Deploy)
//   - `npm run db:push`         ausdrücklicher Dev-Schema-Push
//   - `scripts/reseed-dev-db.sh` Dev-Reseed (Push + beide Seeds); hat zusätzlich
//                                seinen eigenen `--apply`- + Hostname-Guard
export const NON_EPHEMERAL_WRITE_ENV = "ALLOW_NON_EPHEMERAL_DB_WRITE";

// Bricht ab, wenn ein SCHREIBENDER Entrypoint auf einer Nicht-Wegwerf-DB landen
// würde, ohne dass der Aufrufer das erklärt hat.
//
// Fail-closed bleibt damit der nackte Aufruf in einer Shell, die eine fremde
// `DATABASE_URL` geerbt hat — bei `drizzle-kit push --force` ist das
// nicht-interaktives DDL inkl. Spalten-Drops, bei den Seeds ein Superadmin mit
// dokumentiertem Passwort plus überschriebene `company_settings`-Identität.
//
// BEWUSST ENGER als `evaluateTestDbTarget`: Pfad 2 (`TEST_DATABASE_URLS`)
// beantwortet „läuft dieser TESTLAUF gegen Wegwerf-DBs?" — hier zählt aber, wo
// DIESER Schreibvorgang landet, und der geht nach `DATABASE_URL`. Ein Rest
// `TEST_DATABASE_URLS` aus einem früheren Orchestrator-Lauf darf einen Push auf
// die Dev-Prod-Kopie nicht freischalten. Der Orchestrator selbst ist davon nicht
// betroffen: er setzt für Push und Seeds `DATABASE_URL` auf die `cc_test_*`-URL
// (`scripts/with-ephemeral-db.ts`).
export function assertEphemeralDbForWrite(
  entrypoint: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.CI === "true") return;
  const dbName = dbNameOf(env.DATABASE_URL);
  if (dbName && dbName.startsWith(DB_PREFIX)) return;
  if ((env[NON_EPHEMERAL_WRITE_ENV] || "").trim() === "1") return;

  const target = dbName ? `„${dbName}"` : "(DATABASE_URL nicht gesetzt)";
  throw new Error(
    blockMessage(`${entrypoint} zielt auf eine NICHT-Wegwerf-Datenbank.`, [
      `Ziel-DB ${target} hat nicht den Präfix '${DB_PREFIX}'.`,
      "",
      "In den allermeisten Fällen ist das ein Versehen: die Env-Datei wurde nicht",
      "gesourct und der Prozess hat die DATABASE_URL der Shell geerbt.",
      "",
      "  → RICHTIG:  die passende DATABASE_URL setzen und den Aufruf wiederholen.",
      "",
      "Nur wenn eine echte DB WIRKLICH das Ziel ist, gibt es drei Wege, die ihre",
      `Absicht selbst erklären (${NON_EPHEMERAL_WRITE_ENV}=1) — den Marker`,
      "NIEMALS von Hand in einer Shell setzen:",
      "  Prod-Migration :  bash scripts/migrate.sh [--force]",
      "  Dev-Schema     :  npm run db:push",
      "  Dev-Reseed     :  npm run db:reseed-dev  (mit --apply + Hostname-Guard)",
    ]),
  );
}
