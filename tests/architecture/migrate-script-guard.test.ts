// ---------------------------------------------------------------------------
// Prod-Migrationspfad als Black-Box (Follow-up zum Gate-2-Review von PR #21)
//
// `scripts/migrate.sh` ist der Coolify-Pre-Deploy-Command. Er hatte bis hierhin
// NULL automatisierte Abdeckung: `tsc` schliesst `drizzle.config.ts` und
// `scripts/` aus (`tsconfig.json` include), `npm run lint` ebenfalls (Scope
// `client/src server shared tests`), und der `docker-build`-Job pusht das Schema
// auf dem RUNNER statt im Image. Ein Review fand dadurch einen Blocker, den kein
// Gate gesehen hätte: `drizzle.config.ts` importiert seit dem Wegwerf-DB-Guard
// aus `scripts/lib/`, das Image kopierte den Ordner aber nicht → der Config-Load
// wäre im Pre-Deploy mit „Cannot find module" gescheitert.
//
// Dieser Test fängt genau diese Klasse: er ruft `migrate.sh` als Black-Box auf
// und unterscheidet, WORAN es scheitert.
//  1. Der nackte `drizzle-kit push` auf dieselbe DB bricht am Guard ab.
//  2. `migrate.sh` (der echte Pre-Deploy, setzt den Marker selbst) lädt die
//     Config, startet drizzle-kit und kommt bis zum Verbindungsversuch — KEIN
//     Modul-/Guard-/Syntaxfehler.
//  3. Das Image trägt alles, was der Config-Load braucht (Dockerfile-COPY).
//
// Keine DB wird berührt: der Fake-Host nutzt die reservierte `.example`-TLD
// (RFC 6761) und löst als NXDOMAIN auf.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIGRATE = path.resolve(process.cwd(), "scripts/migrate.sh");
const FAKE_DB = "postgresql://user:pass@db.dev.example:5432/careconnect";

function runMigrate(env: Record<string, string>) {
  return spawnSync("bash", [MIGRATE, "--force"], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      CI: "",
      TEST_DATABASE_URLS: "",
      ALLOW_NON_EPHEMERAL_DB_WRITE: "",
      PGCONNECT_TIMEOUT: "3",
      DATABASE_URL: FAKE_DB,
      ...env,
    },
  });
}

describe("scripts/migrate.sh — Prod-Migrationspfad", () => {
  // Gegenstück: OHNE `migrate.sh` (also der nackte Aufruf in einer Shell mit
  // geerbter DATABASE_URL) muss derselbe Config-Load am Guard scheitern. Das ist
  // der Fall, den `migrate.sh` per Marker bewusst ausnimmt.
  it("nackter `drizzle-kit push` auf dieselbe DB bricht am Guard ab", () => {
    const res = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        CI: "",
        TEST_DATABASE_URLS: "",
        ALLOW_NON_EPHEMERAL_DB_WRITE: "",
        DATABASE_URL: FAKE_DB,
      },
    });
    expect(`${res.stdout}${res.stderr}`).toMatch(/NICHT-Wegwerf-Datenbank/);
    expect(res.status).not.toBe(0);
  });

  it("lädt die Config und kommt bis zum Verbindungsversuch", () => {
    const res = runMigrate({});
    const out = `${res.stdout}${res.stderr}`;

    // Der Guard darf hier NICHT greifen …
    expect(out).not.toMatch(/NICHT-Wegwerf-Datenbank/);
    // … und der Config-Load muss durchlaufen. Genau hier wäre der fehlende
    // `scripts/lib`-COPY im Image sichtbar geworden.
    expect(out).not.toMatch(/Cannot find module/);
    expect(out).not.toMatch(/SyntaxError/);
    // Beleg, dass drizzle-kit die Config wirklich gelesen hat und erst danach
    // an der (nicht auflösbaren) DB scheitert.
    expect(out).toMatch(/drizzle-kit@\d+\.\d+\.\d+ push/);
    expect(out).toMatch(/driver for database querying|Pulling schema|ENOTFOUND|EAI_AGAIN|getaddrinfo/);
  });
});

describe("Dockerfile — Runner-Stage trägt den Pre-Deploy-Pfad", () => {
  const dockerfile = readFileSync(
    path.resolve(process.cwd(), "Dockerfile"),
    "utf8",
  );

  // `drizzle.config.ts` wird von drizzle-kit zur LAUFZEIT gelesen, nicht
  // gebündelt. Jeder Import daraus muss deshalb im Image liegen.
  it("kopiert alles, was drizzle.config.ts zur Laufzeit importiert", () => {
    const config = readFileSync(
      path.resolve(process.cwd(), "drizzle.config.ts"),
      "utf8",
    );
    const localImports = [...config.matchAll(/from\s+"\.\/([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(localImports.length).toBeGreaterThan(0);

    for (const imported of localImports) {
      // z.B. "scripts/lib/ephemeral-db-guard.ts" → Verzeichnis "scripts/lib"
      const dir = path.dirname(imported);
      expect(
        dockerfile.includes(`COPY ${dir} ./${dir}`),
        `Dockerfile kopiert '${dir}' nicht — drizzle.config.ts importiert daraus, ` +
          `und der Coolify-Pre-Deploy (bash scripts/migrate.sh) bricht im Image ` +
          `sonst mit "Cannot find module" ab.`,
      ).toBe(true);
    }
  });

  it("kopiert migrate.sh selbst", () => {
    expect(dockerfile).toMatch(/COPY scripts\/migrate\.sh/);
  });
});
