// ---------------------------------------------------------------------------
// Dev-DB Prod-Schutz: Cross-Language-Paritäts-Test (Task #1438)
//
// Die Prod-Schutz-Guards der zerstörerischen Dev-DB-Werkzeuge leben in ZWEI
// Sprachen parallel:
//   - TypeScript: `server/lib/dev-db-guard.ts` (`dbHostOf`, `PROD_HOST_PATTERN`,
//     `assertDevDatabase`), re-exportiert vom Sweep-Skript
//     `server/scripts/sweep-dev-test-data.ts` (npm `db:sweep-dev`).
//   - Bash:      `scripts/lib/assert-dev-db.sh` (`db_host_of`, `assert_dev_db`),
//     gesourcet von `scripts/backup-dev-db.sh` und `scripts/reseed-dev-db.sh`.
//
// Ein TS-Modul kann eine Shell-Funktion nicht sourcen (und umgekehrt), daher
// lässt sich die Logik nicht physisch teilen. Dieser Test ist die geteilte,
// SPRACHÜBERGREIFEND PRÜFBARE Quelle: er definiert die Regeln EINMAL als
// Fixtures-Tabelle und reicht JEDE Fixture durch BEIDE Implementierungen. Ein
// Auseinanderdriften (z.B. ein angepasstes Prod-Pattern nur in einer Welt) wird
// dadurch sofort sichtbar — die Paritäts-Assertion bricht.
//
// Abgedeckt:
//   1. Host-Extraktion (`dbHostOf` ⇔ `db_host_of`) — gleicher Host aus gleicher
//      Connection-URL (mit/ohne Credentials, lowercasing, leerer Host).
//   2. Voller Guard-Verdikt (`assertDevDatabase` ⇔ `assert_dev_db`) — Abbruch
//      vs. Pass für alle vier Schutz-Bedingungen.
//
// DB-frei und damit IMMER laufendes Gate (unit-Project): der TS-Import berührt
// `../lib/db` nicht, der Shell-Aufruf parst nur Strings (Fake-Hosts, kein
// echter DB-Connect).
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  dbHostOf,
  assertDevDatabase,
  DEV_WRITE_CONFIRM_ENV,
} from "../../server/lib/dev-db-guard";

const SHELL_LIB = path.resolve(process.cwd(), "scripts/lib/assert-dev-db.sh");

// --- Shell-Brücken: rufen die gesourcete Guard-Lib als Black-Box auf ---------

/** Ruft `db_host_of "$url"` aus der Shell-Lib auf und liefert den Host (trimmed). */
function shellDbHostOf(url: string): string {
  const res = spawnSync(
    "bash",
    ["-c", `source "$0"; db_host_of "$1"`, SHELL_LIB, url],
    { encoding: "utf8" },
  );
  return (res.stdout ?? "").trim();
}

/**
 * Ruft `assert_dev_db` aus der Shell-Lib mit einem KONTROLLIERTEN Env auf.
 * Liefert `true`, wenn ein Guard abgebrochen hat (Exit-Code != 0). `undefined`
 * in den Overrides löscht die Variable im Kind-Env (das geerbte process.env
 * würde sonst durchgereicht — inkl. einer evtl. echten DATABASE_URL).
 */
function shellAssertAborts(env: {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  PROD_DATABASE_URL?: string;
}): boolean {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["NODE_ENV", "DATABASE_URL", "PROD_DATABASE_URL"] as const) {
    const value = env[key];
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const res = spawnSync(
    "bash",
    ["-c", `source "$0"; assert_dev_db "parity-test"`, SHELL_LIB],
    { env: childEnv, encoding: "utf8" },
  );
  return res.status !== 0;
}

/** Ruft den TS-Guard mit gesetztem process.env auf und liefert, ob er wirft. */
function tsAssertAborts(env: {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  PROD_DATABASE_URL?: string;
}): boolean {
  for (const key of ["NODE_ENV", "DATABASE_URL", "PROD_DATABASE_URL"] as const) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    assertDevDatabase();
    return false;
  } catch {
    return true;
  }
}

// --- Geteilte Fixtures (die EINE sprachübergreifende Quelle) -----------------

// Connection-URLs für die Host-Extraktions-Parität. `.example` ist reserviert
// (RFC 6761) → kein echter DB-Zugriff möglich.
const HOST_URLS = [
  "postgresql://user:pass@db.dev.example:5432/app", // mit Credentials
  "postgresql://db.dev.example:5432/app", // OHNE Credentials
  "postgresql://user:pass@DB.PROD.Example:5432/app", // lowercasing
  "postgresql://user:pass@shared-host.example:5432/dev",
  "garbage-without-host", // kein extrahierbarer Host → ""
  "", // leer → ""
  "postgres ://user@db.dev.example:5432/app", // malformtes Schema (Leerzeichen) → "" (fail-closed)
  "user@db.dev.example:5432/app", // kein Schema, nur @host → "" (fail-closed)
] as const;

interface GuardFixture {
  name: string;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  PROD_DATABASE_URL?: string;
  expectAbort: boolean;
}

const DEV_OK = "postgresql://user:pass@db.dev.example:5432/app";

// Die vier Schutz-Bedingungen + Pass-Fälle. Erwartetes Verdikt ist hier nur die
// dritte Wächter-Instanz — entscheidend ist, dass TS UND Shell IDENTISCH urteilen.
const GUARD_FIXTURES: GuardFixture[] = [
  {
    name: "NODE_ENV=production bricht ab",
    NODE_ENV: "production",
    DATABASE_URL: DEV_OK,
    expectAbort: true,
  },
  {
    name: "Prod-aussehender Host (.prod.) bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@db.prod.example:5432/app",
    expectAbort: true,
  },
  {
    name: "'production'-Host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@careconnect-production.example:5432/app",
    expectAbort: true,
  },
  {
    name: "prod-Präfix-Host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@prod-db.example:5432/app",
    expectAbort: true,
  },
  {
    name: "fail-closed: nicht extrahierbarer Host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "garbage-without-host",
    expectAbort: true,
  },
  {
    name: "fail-closed: leere DATABASE_URL bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "",
    expectAbort: true,
  },
  {
    name: "fail-closed: malformtes Schema (Leerzeichen) bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgres ://user@db.dev.example:5432/app",
    expectAbort: true,
  },
  {
    name: "fail-closed: kein Schema, nur @host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "user@db.dev.example:5432/app",
    expectAbort: true,
  },
  {
    name: "DATABASE_URL-Host == PROD_DATABASE_URL-Host bricht ab",
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@shared-host.example:5432/dev",
    PROD_DATABASE_URL: "postgresql://other:secret@shared-host.example:5432/prod",
    expectAbort: true,
  },
  {
    name: "normaler Dev-Host passiert (PROD_DATABASE_URL auf anderem Host)",
    NODE_ENV: "development",
    DATABASE_URL: DEV_OK,
    PROD_DATABASE_URL: "postgresql://other:secret@db.prod.example:5432/app",
    expectAbort: false,
  },
  {
    name: "normaler Dev-Host passiert (ohne PROD_DATABASE_URL)",
    NODE_ENV: "development",
    DATABASE_URL: DEV_OK,
    expectAbort: false,
  },
  {
    name: "Staging-Host passiert (kein Prod-Pattern)",
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@staging-db.example:5432/app",
    expectAbort: false,
  },
];

// --- Tests -------------------------------------------------------------------

describe("Task #1438: Host-Extraktion TS ⇔ Shell (Parität)", () => {
  it.each(HOST_URLS)("liefert denselben Host für %j", (url) => {
    expect(shellDbHostOf(url)).toBe(dbHostOf(url));
  });
});

describe("Task #1438: Guard-Verdikt TS ⇔ Shell (Parität)", () => {
  // assertDevDatabase() liest process.env zur Aufrufzeit → pro Test setzen und
  // danach den Originalzustand wiederherstellen (der Shell-Aufruf bekommt sein
  // Env separat über childEnv und beeinflusst process.env nicht).
  let savedEnv: {
    NODE_ENV?: string;
    DATABASE_URL?: string;
    PROD_DATABASE_URL?: string;
  };

  beforeEach(() => {
    savedEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      PROD_DATABASE_URL: process.env.PROD_DATABASE_URL,
    };
  });

  afterEach(() => {
    for (const key of ["NODE_ENV", "DATABASE_URL", "PROD_DATABASE_URL"] as const) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(GUARD_FIXTURES)("$name", (fx) => {
    const env = {
      NODE_ENV: fx.NODE_ENV,
      DATABASE_URL: fx.DATABASE_URL,
      PROD_DATABASE_URL: fx.PROD_DATABASE_URL,
    };
    const tsAborts = tsAssertAborts(env);
    const shellAborts = shellAssertAborts(env);
    // 1. Beide Welten urteilen IDENTISCH (Drift-Schutz).
    expect(tsAborts).toBe(shellAborts);
    // 2. ...und das gemeinsame Verdikt entspricht der Erwartung.
    expect(tsAborts).toBe(fx.expectAbort);
  });
});

/**
 * Paritaet der POSITIVEN Ziel-Pruefung (PR #117).
 *
 * `assert_dev_db` / `assertDevDatabase` sind negative Praedikate — im Gate-2
 * gemessen bestehen `helium` (der echte Prod-Host), die Neon-Prod-Form und
 * `localhost` sie glatt. Deshalb erteilen sie kein Schreibrecht mehr; das tut
 * die positive Pruefung, und die muss es auf BEIDEN Seiten geben — an der
 * Bash-Seite haengen die vier `psql`-Skripte (`reseed-dev-db.sh`,
 * `post-merge.sh`, die zwei Backup-Skripte), die den TS-Chokepoint nie sehen.
 */
describe("positive Dev-Ziel-Pruefung — TS ⇔ Bash", () => {
  const shell = readFileSync(SHELL_LIB, "utf8");

  it("beide Seiten kennen die Funktion und dieselbe Env", () => {
    expect(shell).toMatch(/assert_dev_write_target\(\)/);
    expect(shell).toContain("DEV_WRITE_CONFIRM_TARGET");
    expect(DEV_WRITE_CONFIRM_ENV).toBe("DEV_WRITE_CONFIRM_TARGET");
  });

  it("beide holen den DB-Namen aus der OFFENEN Verbindung, nicht aus der URL", () => {
    // Der Kern des 18.08.-Vorfalls: `helium` stimmte, `heliumdb` statt
    // `neondb` nicht. Wer den Namen aus der URL liest, sieht das nicht.
    expect(shell).toMatch(/current_database\(\)/);
    const ts = readFileSync(
      path.resolve(process.cwd(), "server/lib/dev-db-guard.ts"),
      "utf8",
    );
    expect(ts).toContain("currentDatabaseName()");
  });

  it("Bash bricht ohne benanntes Ziel ab", () => {
    const res = spawnSync(
      "bash",
      ["-c", `source "$0"; assert_dev_write_target "parity-test"`, SHELL_LIB],
      {
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_URL: "postgres://u:p@dev-host/careconnect_dev",
          DEV_WRITE_CONFIRM_TARGET: "",
        },
        encoding: "utf8",
      },
    );
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/DEV_WRITE_CONFIRM_TARGET/);
  });

  it("Bash bricht auch bei helium ohne Ziel ab — der negative Screen laesst es durch", () => {
    const res = spawnSync(
      "bash",
      ["-c", `source "$0"; assert_dev_write_target "parity-test"`, SHELL_LIB],
      {
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_URL: "postgres://u:p@helium/neondb",
          DEV_WRITE_CONFIRM_TARGET: "",
        },
        encoding: "utf8",
      },
    );
    expect(res.status).not.toBe(0);
  });
});
