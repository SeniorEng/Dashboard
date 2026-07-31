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

export type TestDbTarget =
  | { ok: true; reason: string }
  | { ok: false; dbName: string | null };

// Entscheidet, ob die effektive Test-Ziel-DB eine erlaubte Wegwerf-/Ephemeral-DB
// ist. Reine Funktion (env wird übergeben), damit sie unit-getestet werden kann.
export function evaluateTestDbTarget(
  env: NodeJS.ProcessEnv = process.env,
): TestDbTarget {
  // 1) CI (GitHub Actions): Der gesamte Postgres-Container ist wegwerfbar und
  //    sitzt hinter dem fix verdrahteten Neon-WS-Proxy. Die DB heißt dort
  //    statisch `careconnect` (NICHT `cc_test_*`) — der Proxy ignoriert den
  //    DB-Namen ohnehin. CI daher NIE blockieren.
  if (env.CI === "true") {
    return { ok: true, reason: "CI (wegwerfbarer Container-DB-Container)" };
  }

  // 2) Lokaler Orchestrator (`scripts/with-ephemeral-db.ts`): provisioniert pro
  //    Worker eine eigene `cc_test_*`-Wegwerf-DB und exportiert deren URLs in
  //    `TEST_DATABASE_URLS`. Ist diese Variable gesetzt, laufen wir garantiert
  //    über den Orchestrator gegen Ephemeral-DBs.
  if ((env.TEST_DATABASE_URLS || "").trim().length > 0) {
    return { ok: true, reason: "Orchestrator-Ephemeral-Worker-DBs" };
  }

  // 3) Andernfalls MUSS die effektive `DATABASE_URL` direkt auf eine
  //    `cc_test_*`-Wegwerf-DB zeigen.
  const dbName = dbNameOf(env.DATABASE_URL);
  if (dbName && dbName.startsWith(DB_PREFIX)) {
    return { ok: true, reason: `Wegwerf-DB ${dbName}` };
  }

  return { ok: false, dbName };
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
export function assertEphemeralDbForWrite(
  entrypoint: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (evaluateTestDbTarget(env).ok) return;
  if ((env[NON_EPHEMERAL_WRITE_ENV] || "").trim() === "1") return;

  const dbName = dbNameOf(env.DATABASE_URL);
  const target = dbName ? `„${dbName}"` : "(DATABASE_URL nicht gesetzt)";
  throw new Error(
    blockMessage(`${entrypoint} zielt auf eine NICHT-Wegwerf-Datenbank.`, [
      `Ziel-DB ${target} hat nicht den Präfix '${DB_PREFIX}'.`,
      "",
      "Häufigste Ursache: die Env-Datei wurde nicht gesourct und der Prozess hat",
      "die DATABASE_URL der Shell geerbt.",
      "",
      "Absicht ist erklärbar, aber nur ausdrücklich — diese Wege setzen den",
      `Marker ${NON_EPHEMERAL_WRITE_ENV}=1 selbst:`,
      "  Prod-Migration :  bash scripts/migrate.sh [--force]",
      "  Dev-Schema     :  npm run db:push",
      "  Dev-Reseed     :  npm run db:reseed-dev",
    ]),
  );
}
