// ---------------------------------------------------------------------------
// Dev-DB Backup/Reseed CLI-Guard-Tests (Task #1435)
//
// Task #1433 hat die Prod-Schutz-Guards des Sweep-Wrappers
// (`server/scripts/sweep-dev-test-data.ts`) automatisiert getestet. Die ZEICHEN-
// GLEICHE Schutz-Logik (NODE_ENV=production, Prod-Host-Pattern, fail-closed bei
// nicht ermittelbarem Host, DATABASE_URL-Host == PROD_DATABASE_URL-Host) lebt
// auch in den beiden Shell-Skripten `scripts/backup-dev-db.sh` und
// `scripts/reseed-dev-db.sh` — dort bisher NUR manuell ausgeübt. Eine Divergenz
// oder Regression könnte ein Backup/Reseed auf eine Nicht-Dev-DB richten.
//
// Dieser Test ruft beide Skripte als Black-Box mit gefälschten Env-Variablen auf
// und prüft:
//  1. Abbruch bei NODE_ENV=production.
//  2. Abbruch bei Prod-aussehendem DB-Host.
//  3. Abbruch (fail-closed) bei nicht ermittelbarem Host.
//  4. Abbruch bei DATABASE_URL-Host == PROD_DATABASE_URL-Host.
//  5. Ein normaler Dev-Host PASSIERT die vier Guards — OHNE dass tatsächlich ein
//     Backup/Reseed gegen eine echte DB läuft (Fake-Host löst nicht auf, und der
//     Reseed läuft als Trockenlauf; das Backup bricht erst NACH den Guards am
//     pg_dump-Connect ab, nicht an einem Guard).
//
// Die Tests berühren KEINE DB: der Fake-Host `db.dev.example` (reservierte
// `.example`-TLD, RFC 6761) löst per DNS sofort als NXDOMAIN auf, sodass weder
// psql noch pg_dump eine echte Verbindung aufbauen. `PGCONNECT_TIMEOUT` ist
// zusätzlich klein gepinnt.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const BACKUP_SCRIPT = path.resolve(process.cwd(), "scripts/backup-dev-db.sh");
const RESEED_SCRIPT = path.resolve(process.cwd(), "scripts/reseed-dev-db.sh");

// Connection-Strings mit Fake-Hosts (lösen alle als NXDOMAIN auf → kein echter
// DB-Zugriff). `.example` ist eine reservierte TLD.
const DEV_OK = "postgresql://user:pass@db.dev.example:5432/app";
const PROD_LOOKING = "postgresql://user:pass@db.prod.example:5432/app";
const UNEXTRACTABLE = "garbage-without-host"; // kein `://` → leerer Host
const SHARED_DEV = "postgresql://user:pass@shared-host.example:5432/dev";
const SHARED_PROD = "postgresql://other:secret@shared-host.example:5432/prod";

type RunResult = { status: number | null; stdout: string; stderr: string };

/**
 * Ruft ein Shell-Skript mit einem kontrollierten Env auf. `envOverrides` mit
 * `undefined` löscht die Variable im Kind-Env (geerbtes process.env wird sonst
 * durchgereicht, damit PATH/psql/pg_dump verfügbar bleiben).
 */
function runScript(
  script: string,
  envOverrides: Record<string, string | undefined>,
  args: string[] = [],
): RunResult {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PGCONNECT_TIMEOUT: "2" };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const res = spawnSync("bash", [script, ...args], {
    env: childEnv,
    encoding: "utf8",
    timeout: 60000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// Beide Skripte teilen exakt dieselbe Guard-Schicht — wir prüfen sie tabellarisch.
const SCRIPTS = [
  { name: "backup-dev-db.sh", path: BACKUP_SCRIPT },
  { name: "reseed-dev-db.sh", path: RESEED_SCRIPT },
] as const;

describe.each(SCRIPTS)("Task #1435: $name Prod-Schutz-Guards", ({ path: script }) => {
  it("bricht bei NODE_ENV=production ab", () => {
    const r = runScript(script, {
      NODE_ENV: "production",
      DATABASE_URL: DEV_OK,
      PROD_DATABASE_URL: undefined,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/NODE_ENV=production/);
  });

  it("bricht bei einem Prod-aussehenden DB-Host ab", () => {
    const r = runScript(script, {
      NODE_ENV: "development",
      DATABASE_URL: PROD_LOOKING,
      PROD_DATABASE_URL: undefined,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sieht nach Produktion aus/);
  });

  it("fail-closed: bricht ab, wenn der Host nicht extrahierbar ist", () => {
    const r = runScript(script, {
      NODE_ENV: "development",
      DATABASE_URL: UNEXTRACTABLE,
      PROD_DATABASE_URL: undefined,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/fail-closed/);
  });

  it("bricht bei DATABASE_URL-Host == PROD_DATABASE_URL-Host ab", () => {
    const r = runScript(script, {
      NODE_ENV: "development",
      DATABASE_URL: SHARED_DEV,
      PROD_DATABASE_URL: SHARED_PROD,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/DATABASE_URL-Host == PROD_DATABASE_URL-Host/);
  });
});

describe("Task #1435: normaler Dev-Host passiert die Guards (ohne echten DB-Lauf)", () => {
  let backupDir: string;

  beforeAll(() => {
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-db-guard-test-"));
  });

  afterAll(() => {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("reseed-dev-db.sh erreicht den Trockenlauf (kein --apply → keine Mutation)", () => {
    const r = runScript(RESEED_SCRIPT, {
      NODE_ENV: "development",
      DATABASE_URL: DEV_OK,
      PROD_DATABASE_URL: undefined,
      // Preflight-Check fordert Login-Credentials, sonst bräche das Skript NACH
      // den Guards an einer anderen Stelle ab. Fake-Werte genügen (kein DB-Lauf).
      TEST_USER_EMAIL: "test@test.local",
      TEST_USER_PASSWORD: "x".repeat(12),
      TEST_USER_PASSWORD_INTERNAL: undefined,
    });
    // Trockenlauf endet sauber mit Code 0 und meldet, dass nichts verändert wurde.
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/TROCKENLAUF/);
    // Es darf KEIN Guard gegriffen haben.
    expect(r.stderr).not.toMatch(/ABBRUCH/);
  });

  it("backup-dev-db.sh passiert die Guards und scheitert erst am pg_dump-Connect", () => {
    const r = runScript(BACKUP_SCRIPT, {
      NODE_ENV: "development",
      DATABASE_URL: DEV_OK,
      PROD_DATABASE_URL: undefined,
      BACKUP_DIR: backupDir,
    });
    // backup-dev-db.sh hat keinen Trockenlauf — nach bestandenen Guards läuft es
    // bis zum pg_dump-Aufruf, der gegen den nicht auflösbaren Fake-Host scheitert.
    // Entscheidend: KEIN Guard hat gegriffen (sonst stünde "ABBRUCH" in stderr),
    // und das Skript hat die Guard-Zone bis zur Backup-Ausgabe verlassen.
    expect(r.stderr).not.toMatch(/ABBRUCH/);
    expect(r.stdout).toMatch(/Schreibe Custom-Format-Dump/);
  });
});
