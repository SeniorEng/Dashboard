/**
 * Task #1211 — Guard-Test für die Sicherheits-Gates des Production-Rollout-
 * Wrappers `scripts/prod-budget-anchor-rollout.sh`.
 *
 * Hintergrund: Dieser Wrapper ist die einzige Schutzschicht zwischen einer
 * unvorsichtigen Invokation und einem ungeguardeten Write gegen die LIVE-
 * Production-DB. Seine Sicherheits-Eigenschaften wurden bisher nur von Hand
 * Smoke-getestet. Eine spätere Änderung könnte still ein Gate aufweichen. Dieser
 * Test friert die kritischen Garantien ein:
 *
 *   1. `review` ohne `--i-reviewed-164` / `CONFIRM_WINDOW_SHIFTS=1` bricht
 *      NICHT-NULL ab, BEVOR irgendein Backup läuft.
 *   2. Ein unbekanntes Subcommand bricht (nicht-null) ab.
 *   3. Der SAFE/REVIEW-Summenzeilen-Parser liefert die NACHGESTELLTE Zahl, auch
 *      wenn das SAFE-Label "§45a/§39" (= Ziffern) enthält.
 *
 * Der Test berührt KEINE echte DB: `pg_dump` (vom Backup-Skript aufgerufen) und
 * `npx tsx <backfill>` werden über einen PATH-Shim durch Stubs ersetzt. Das
 * Backup-Skript selbst läuft real (gzip/du/sha256sum), schreibt aber nur einen
 * Stub-Dump und meldet das über eine Marker-Datei.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT_DIR, "scripts", "prod-budget-anchor-rollout.sh");
// Der Wrapper grept den Backup-Output hartcodiert nach `tmp/db-backups/prod-*.dump`,
// also MUSS der (gestubbte) Dump dort landen.
const BACKUP_DIR = path.join(ROOT_DIR, "tmp", "db-backups");
const BACKUP_LABEL = "-pre-budget-anchor-rollout";

let stubDir: string;
let pgdumpMarker: string;

/** Legt einen ausführbaren Stub mit dem gegebenen Inhalt in stubDir an. */
function writeStub(name: string, body: string): void {
  const p = path.join(stubDir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
}

interface RunOpts {
  safeCount?: number;
  reviewCount?: number;
  extraEnv?: Record<string, string>;
}

function runRollout(args: string[], opts: RunOpts = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
    // db_host()/run_backup() brauchen eine URL; fake, wird nie kontaktiert.
    DATABASE_URL: "postgres://u:p@stub-host.example/db",
    PROD_DATABASE_URL: "postgres://u:p@stub-host.example/db",
    PGDUMP_MARKER: pgdumpMarker,
    STUB_SAFE_COUNT: String(opts.safeCount ?? 0),
    STUB_REVIEW_COUNT: String(opts.reviewCount ?? 1),
    ...(opts.extraEnv ?? {}),
  };
  // Opt-in-Env-Schalter dürfen nicht aus dem Host-Env durchsickern.
  if (!(opts.extraEnv && "CONFIRM_WINDOW_SHIFTS" in opts.extraEnv)) {
    delete env.CONFIRM_WINDOW_SHIFTS;
  }
  delete env.NODE_ENV;
  const res = spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT_DIR,
    env,
    encoding: "utf8",
    timeout: 20000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    backupRan: fs.existsSync(pgdumpMarker),
  };
}

beforeEach(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-gate-"));
  pgdumpMarker = path.join(stubDir, "pgdump-was-called");

  // Stub pg_dump: schreibt bei --file= einen nicht-leeren Stub-Dump (Custom-
  // Format) bzw. nach stdout (Plain-Format, wird vom Backup-Skript gegzippt) und
  // hinterlässt eine Marker-Datei, damit der Test "Backup lief" erkennen kann.
  writeStub(
    "pg_dump",
    `#!/usr/bin/env bash
set -e
: > "$PGDUMP_MARKER"
file=""
for a in "$@"; do
  case "$a" in
    --file=*) file="\${a#--file=}" ;;
  esac
done
if [ -n "$file" ]; then
  printf 'STUB CUSTOM DUMP\\n' > "$file"
else
  printf 'STUB PLAIN DUMP\\n'
fi
`,
  );

  // Stub npx: ersetzt `npx tsx <backfill> [...]`. Gibt eine Klassifikations-
  // Zusammenfassung aus, deren SAFE-Zeile ABSICHTLICH "§45a/§39" (Ziffern)
  // enthält — der echte Parser muss die NACHGESTELLTE Zahl nehmen.
  writeStub(
    "npx",
    `#!/usr/bin/env bash
set -e
safe="\${STUB_SAFE_COUNT:-0}"
review="\${STUB_REVIEW_COUNT:-1}"
echo "Budget-Anker-Backfill (STUB) — Klassifikation:"
echo "SAFE-Tier (Origin-Stempel + §45b, §45a/§39 unverändert): \${safe} Kunde(n) betroffen"
echo "REVIEW-Tier (§45a/§39-Fenster-Shift, Kunde #164): \${review} Kunde(n) betroffen"
`,
  );
});

afterEach(() => {
  // Stub-Dir + die real erzeugten (gestubbten) Backup-Artefakte aufräumen.
  try {
    fs.rmSync(stubDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (f.startsWith("prod-") && f.includes(BACKUP_LABEL)) {
        fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
      }
    }
  } catch {
    /* Verzeichnis existiert evtl. nicht — ok. */
  }
});

describe("prod-budget-anchor-rollout.sh — Sicherheits-Gates", () => {
  it("review ohne Opt-in bricht nicht-null ab, BEVOR ein Backup läuft", () => {
    const r = runRollout(["review"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Opt-in/i);
    expect(r.stderr).toMatch(/--i-reviewed-164/);
    // Entscheidend: kein Backup darf vor dem Abbruch gelaufen sein.
    expect(r.backupRan).toBe(false);
  });

  it("review läuft mit --i-reviewed-164 (Backup läuft, beide Stufen idempotent)", () => {
    const r = runRollout(["review", "--i-reviewed-164"], { reviewCount: 0 });
    expect(r.status).toBe(0);
    expect(r.backupRan).toBe(true);
    expect(r.stderr).toMatch(/Opt-in best/i);
    expect(r.stderr).toMatch(/SAFE=0 · REVIEW=0/);
  });

  it("review läuft mit CONFIRM_WINDOW_SHIFTS=1 (Env-Opt-in)", () => {
    const r = runRollout(["review"], {
      reviewCount: 0,
      extraEnv: { CONFIRM_WINDOW_SHIFTS: "1" },
    });
    expect(r.status).toBe(0);
    expect(r.backupRan).toBe(true);
  });

  it("review mit gesetztem aber falschem REVIEW-Rest schlägt die Idempotenz-Prüfung fehl", () => {
    const r = runRollout(["review", "--i-reviewed-164"], { reviewCount: 3 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Idempotenz verletzt/);
    expect(r.stderr).toMatch(/3 REVIEW-Kunde/);
  });

  it("unbekanntes Subcommand bricht nicht-null ab", () => {
    const r = runRollout(["frobnicate"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Unbekanntes Subcommand/);
    expect(r.backupRan).toBe(false);
  });

  it("SAFE/REVIEW-Parser nimmt die nachgestellte Zahl trotz §45a/§39-Ziffern", () => {
    // safe path: SAFE=0 → idempotent → Exit 0. Nähme der Parser die ERSTE Zahl,
    // würde er "45" aus "§45a" lesen → Abbruch "noch 45 SAFE-Kunde(n)".
    const r = runRollout(["safe"], { safeCount: 0, reviewCount: 1 });
    expect(r.status).toBe(0);
    expect(r.backupRan).toBe(true);
    expect(r.stderr).toMatch(/SAFE=0 · REVIEW=1/);
  });

  it("safe bricht ab, wenn nach dem Apply noch SAFE-Kunden offen sind", () => {
    // Re-Check meldet SAFE=2 → Idempotenz verletzt → harter Abbruch. Beweist,
    // dass der Parser die echte (nachgestellte) Zahl auswertet, nicht "45".
    const r = runRollout(["safe"], { safeCount: 2 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Idempotenz verletzt/);
    expect(r.stderr).toMatch(/2 SAFE-Kunde/);
  });
});
