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

// `migrate.sh` ruft `npx --yes drizzle-kit@<Version aus package-lock.json>`.
// Liegt genau diese Version lokal, nimmt npx sie; sonst LÄDT es aus dem Netz —
// im Unit-Project, das offline laufen können muss. Wir überspringen den
// Black-Box-Lauf in dem Fall (frisch nach einem Renovate-Bump vor `npm ci`,
// teilinstallierter Baum) statt ihn netzabhängig rot werden zu lassen.
const pinnedDrizzleKit = (() => {
  try {
    const lock = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package-lock.json"), "utf8"),
    );
    const want = lock.packages?.["node_modules/drizzle-kit"]?.version;
    const have = JSON.parse(
      readFileSync(
        path.resolve(process.cwd(), "node_modules/drizzle-kit/package.json"),
        "utf8",
      ),
    ).version;
    return want && want === have;
  } catch {
    return false;
  }
})();

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
  it.skipIf(!pinnedDrizzleKit)(
    "nackter `drizzle-kit push` auf dieselbe DB bricht am Guard ab",
    () => {
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
    },
  );

  it.skipIf(!pinnedDrizzleKit)(
    "lädt die Config und kommt bis zum Verbindungsversuch",
    () => {
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
      expect(out).toMatch(
        /driver for database querying|Pulling schema|ENOTFOUND|EAI_AGAIN|getaddrinfo/,
      );
    },
  );
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

    // Muss BEIDE Formen fangen: `from "./x"` UND den bindungslosen
    // Side-Effect-Import `import "./x"` (den dieser Commit selbst in die Seeds
    // eingeführt hat), dazu `require("./x")` und beide Anführungszeichen-Stile.
    // `import type` zählt nicht — das wird zur Laufzeit gelöscht.
    const localImports = [
      ...config
        .replace(/^\s*import\s+type\s[^\n]*$/gm, "")
        .matchAll(/(?:from|import|require)\s*\(?\s*["']\.\/([^"']+)["']/g),
    ].map((m) => m[1]);
    expect(localImports.length).toBeGreaterThan(0);

    // Eine COPY-Zeile deckt ein Verzeichnis ab, wenn sie es selbst ODER einen
    // seiner Vorfahren kopiert (`COPY scripts ./scripts` deckt `scripts/lib`).
    const coversDir = (dir: string): boolean => {
      const parts = dir.split("/");
      for (let i = parts.length; i > 0; i--) {
        const candidate = parts.slice(0, i).join("/");
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`^COPY\\s+${escaped}\\s`, "m").test(dockerfile)) {
          return true;
        }
      }
      return false;
    };

    for (const imported of localImports) {
      // z.B. "scripts/lib/ephemeral-db-guard.ts" → Verzeichnis "scripts/lib"
      const dir = path.dirname(imported);
      expect(
        coversDir(dir),
        `Dockerfile kopiert '${dir}' nicht — drizzle.config.ts importiert daraus, ` +
          `und der Coolify-Pre-Deploy (bash scripts/migrate.sh) bricht im Image ` +
          `sonst mit "Cannot find module" ab.`,
      ).toBe(true);
    }
  });

  // Der Texttest oben sieht nur EINE Ebene. `ephemeral-db-guard` importiert
  // seinerseits `ephemeral-db-sweep` — das liegt zufällig im selben Ordner.
  // Dieser Test pinnt genau diese Annahme fest, damit ein künftiger Import aus
  // einem anderen Verzeichnis nicht still durchrutscht.
  it("die Guard-Kette bleibt innerhalb der kopierten Verzeichnisse", () => {
    const guard = readFileSync(
      path.resolve(process.cwd(), "scripts/lib/ephemeral-db-guard.ts"),
      "utf8",
    );
    const relatives = [
      ...guard.matchAll(/(?:from|import|require)\s*\(?\s*["'](\.[^"']+)["']/g),
    ].map((m) => m[1]);
    for (const rel of relatives) {
      expect(
        rel.startsWith("./"),
        `ephemeral-db-guard.ts importiert '${rel}' ausserhalb von scripts/lib — ` +
          `dieses Verzeichnis muss dann ebenfalls ins Image kopiert werden.`,
      ).toBe(true);
    }
  });

  it("kopiert migrate.sh selbst", () => {
    expect(dockerfile).toMatch(/COPY scripts\/migrate\.sh/);
  });
});
