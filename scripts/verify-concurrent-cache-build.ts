// ---------------------------------------------------------------------------
// End-to-End-Regression: Zwei GLEICHZEITIGE kalte Cache-Aufbauten dürfen sich
// nicht gegenseitig zerschießen (Task #917)
//
// Task #913 hat einen Postgres-Advisory-Lock eingeführt, damit zwei Testläufe,
// die ZEITGLEICH gegen eine FEHLENDE Cache-Template-DB (`cc_test_tmpl_cache`)
// starten, ihren kalten Aufbau serialisieren statt beide gleichzeitig dieselbe
// Cache-DB zu droppen/erzeugen und parallel `drizzle-kit push --force` dagegen
// zu feuern (einer scheiterte sonst mit exit 1). Der Lock-Schlüssel selbst ist
// unit-gepinnt (`tests/unit/template-cache.test.ts`: `advisoryLockKey`), und die
// Serialisierungs-Semantik wurde manuell verifiziert — aber es gab bisher KEINE
// automatisierte Regression für das echte Nebenläufigkeits-Szenario. Ein
// künftiger Refactor von `scripts/with-ephemeral-db.ts` könnte die Race still
// wieder einführen.
//
// Dieses Skript droppt die Cache-DB und startet dann ZWEI echte Orchestrator-
// Läufe GLEICHZEITIG im `EPHEMERAL_PROVISION_ONLY=1`-Modus (provisioniert nur die
// Template-DB und bricht VOR Server-Boot/Testlauf ab). Garantie:
//
//   1. BEIDE Läufe beenden mit exit 0 (kein `drizzle-kit push`-Crash durch die
//      Race).
//   2. GENAU EINER meldet `CACHE_RESULT=cold` (baut den Cache kalt), der ANDERE
//      `CACHE_RESULT=warm` (wartete am Lock und nutzte den frisch gebauten Cache
//      wieder, statt ihn erneut zu bauen).
//
// Exit 0 = Garantien erfüllt, sonst Exit 1 mit Begründung. Fehlt DATABASE_URL,
// wird sauber übersprungen (wie die übrigen DB-gegateten Schritte).
//
// Aufruf:  npx tsx scripts/verify-concurrent-cache-build.ts
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from "node:child_process";
import { CACHE_DB_NAME } from "./lib/template-cache.ts";

function fail(msg: string): never {
  console.error(`\n[verify-concurrent] ❌ ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`[verify-concurrent] ✅ ${msg}`);
}

if (process.env.NODE_ENV === "production") {
  fail("Verweigert: läuft niemals in Production.");
}

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  // Sauberes Skip wie die übrigen DB-gegateten Schritte (z.B. Forks ohne DB).
  console.log("[verify-concurrent] DATABASE_URL nicht gesetzt — Schritt übersprungen.");
  process.exit(0);
}

function psql(sql: string): { ok: boolean; out: string } {
  const res = spawnSync("psql", [adminUrl!, "-v", "ON_ERROR_STOP=1", "-tAc", sql], {
    encoding: "utf8",
  });
  if (res.status !== 0) return { ok: false, out: (res.stderr || "").trim() };
  return { ok: true, out: (res.stdout || "").trim() };
}

function dropCache(): void {
  const res = psql(`DROP DATABASE IF EXISTS "${CACHE_DB_NAME}" WITH (FORCE)`);
  if (!res.ok) fail(`Konnte Cache-DB ${CACHE_DB_NAME} nicht droppen: ${res.out}`);
}

interface RunResult {
  label: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  cacheResult: string | null;
  ms: number;
}

// Startet den echten Orchestrator im Provision-Only-Modus als eigenständigen
// Prozess und resolved erst, wenn er beendet ist. Da wir ZWEI dieser Promises
// OHNE await nebeneinander erzeugen und gemeinsam awaiten, laufen sie wirklich
// gleichzeitig — genau das Szenario aus Task #913.
function startOrchestrator(label: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    console.log(`[verify-concurrent] ── ${label}: starte Orchestrator (provision-only) ...`);
    const t0 = Date.now();
    const child = spawn(
      "npx",
      ["tsx", "scripts/with-ephemeral-db.ts", "5099", "node", "-e", ""],
      {
        env: { ...process.env, EPHEMERAL_PROVISION_ONLY: "1" },
      },
    );
    let stdout = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const ms = Date.now() - t0;
      const match = stdout.match(/CACHE_RESULT=(\w+)/);
      console.log(
        `[verify-concurrent] ── ${label}: beendet (code ${code}, signal ${signal}) in ${ms}ms ` +
          `(CACHE_RESULT=${match ? match[1] : "?"}).`,
      );
      resolve({
        label,
        code,
        signal,
        stdout,
        cacheResult: match ? match[1] : null,
        ms,
      });
    });
  });
}

async function main(): Promise<void> {
  console.log(
    `[verify-concurrent] Cache-DB: ${CACHE_DB_NAME}. Beweise: zwei zeitgleiche KALTE ` +
      `Aufbauten serialisieren sauber (genau einer kalt, einer warm, beide exit 0).`,
  );

  // Cache vorab droppen, damit BEIDE Läufe gegen eine FEHLENDE Cache-DB starten —
  // das ist exakt der Race-Auslöser aus Task #913.
  dropCache();
  console.log(`[verify-concurrent] Cache-DB ${CACHE_DB_NAME} gedroppt — beide Läufe starten KALT.`);

  // BEIDE Promises OHNE await erzeugen, dann gemeinsam awaiten → echte Nebenläufigkeit.
  const p1 = startOrchestrator("Lauf A");
  const p2 = startOrchestrator("Lauf B");
  const results = await Promise.all([p1, p2]);

  // Vollen Output beider Läufe durchreichen (CI-Diagnose).
  for (const r of results) {
    console.log(`\n[verify-concurrent] ── Output ${r.label} ──────────────────────`);
    process.stdout.write(r.stdout);
  }

  // --- Garantie 1: BEIDE Läufe exit 0 -------------------------------------
  const crashed = results.filter((r) => r.code !== 0);
  if (crashed.length > 0) {
    fail(
      `Nicht beide Läufe sauber beendet: ` +
        crashed
          .map((r) => `${r.label} exit ${r.code}${r.signal ? `/${r.signal}` : ""}`)
          .join(", ") +
        `. Die Race aus Task #913 ist vermutlich wieder offen (paralleler drizzle-kit push).`,
    );
  }
  ok("Beide Läufe exit 0 — kein Crash durch konkurrierenden Cache-Aufbau.");

  // --- Garantie 2: genau einer kalt, einer warm --------------------------
  const cold = results.filter((r) => r.cacheResult === "cold");
  const warm = results.filter((r) => r.cacheResult === "warm");
  if (cold.length !== 1 || warm.length !== 1) {
    fail(
      `Erwartet genau 1× cold + 1× warm, war: ` +
        results.map((r) => `${r.label}=${r.cacheResult}`).join(", ") +
        `. Bei sauberer Serialisierung baut genau EINER kalt und der ANDERE nutzt ` +
        `den frisch gebauten Cache warm wieder.`,
    );
  }
  ok(
    `Genau ein KALTER Aufbau (${cold[0].label}) + ein WARMER Reuse (${warm[0].label}) — ` +
      `der zweite Lauf wartete am Advisory-Lock und baute NICHT erneut.`,
  );

  console.log(
    `\n[verify-concurrent] ✅ Garantien erfüllt: zwei zeitgleiche kalte Starts ` +
      `crashen sich nicht — sie serialisieren (1× cold, 1× warm, beide exit 0).`,
  );
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
