// ---------------------------------------------------------------------------
// End-to-End-Beweis für den geseedeten Cache-Template-DB-Mechanismus (Task #910)
//
// Task #907 hat eine wiederverwendete, geseedete Cache-Template-DB
// (`cc_test_tmpl_cache`) eingeführt, damit wiederholte Testläufe den teuren
// `drizzle-kit push` + die Seed-Skripte überspringen und stattdessen aus dem
// Cache klonen. Die reine Entscheidungs-/Hash-Logik ist in
// `tests/unit/template-cache.test.ts` gepinnt — der KOMPLETTE Warm-/Kalt-Pfad
// durch den Orchestrator (`scripts/with-ephemeral-db.ts`) konnte im Dev-Container
// aber nie ausgeführt werden (der App-Server-Boot via `tsx`/Bundle hängt dort).
//
// Dieses Skript führt den ECHTEN Orchestrator zweimal hintereinander aus — im
// `EPHEMERAL_PROVISION_ONLY=1`-Modus, der NUR die (ggf. gecachte) Template-DB
// bereitstellt und VOR dem App-Server-Boot abbricht (genau der Teil, der im CI
// hinter dem fix verdrahteten Neon-Proxy ohnehin nicht pro DB routen würde) —
// und prüft die drei Garantien:
//
//   1. Lauf 1 (Cache vorher gedroppt) baut den Cache KALT: `drizzle-kit push` +
//      beide Seeds laufen, Marker `CACHE_RESULT=cold`.
//   2. Lauf 2 nutzt den Cache WARM: Push + Seeds werden ÜBERSPRUNGEN, Marker
//      `CACHE_RESULT=warm`, und der Lauf ist MESSBAR schneller als Lauf 1.
//   3. Eine Änderung an einer hash-relevanten Seed-Quelle invalidiert den Cache
//      (Hash-Mismatch -> erneut KALT, `CACHE_RESULT=cold`).
//
// Exit 0 = alle Garantien erfüllt, sonst Exit 1 mit Begründung.
//
// Aufruf:  npx tsx scripts/verify-template-cache.ts
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CACHE_DB_NAME } from "./lib/template-cache.ts";

function fail(msg: string): never {
  console.error(`\n[verify-cache] ❌ ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`[verify-cache] ✅ ${msg}`);
}

if (process.env.NODE_ENV === "production") {
  fail("Verweigert: läuft niemals in Production.");
}

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) fail("DATABASE_URL ist nicht gesetzt.");

// Hash-relevante Seed-Quelle, die wir für den Invalidierungs-Test kurzzeitig
// verändern (und danach byte-genau wiederherstellen). Ein angehängter Kommentar
// ändert das Verhalten des Seeds NICHT, kippt aber den Template-Hash.
const PROBE_FILE = resolvePath("scripts/seed-test-reference-data.ts");
const PROBE_MARKER = "\n// [verify-template-cache] temporäre Cache-Invalidierungs-Probe\n";

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
  ms: number;
  stdout: string;
  cacheResult: string;
}

// Führt den echten Orchestrator im Provision-Only-Modus aus und gibt Dauer +
// gesammelten Output + den geparsten CACHE_RESULT-Marker zurück.
function runOrchestrator(label: string): RunResult {
  console.log(`\n[verify-cache] ── ${label}: starte Orchestrator (provision-only) ...`);
  const t0 = Date.now();
  const res = spawnSync(
    "npx",
    ["tsx", "scripts/with-ephemeral-db.ts", "5099", "node", "-e", ""],
    {
      encoding: "utf8",
      env: { ...process.env, EPHEMERAL_PROVISION_ONLY: "1" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const ms = Date.now() - t0;
  const stdout = (res.stdout || "") + (res.stderr || "");
  // Den Output durchreichen, damit CI-Logs den vollen Hergang zeigen.
  process.stdout.write(stdout);
  if (res.status !== 0) {
    fail(`${label}: Orchestrator exit ${res.status} (Dauer ${ms}ms).`);
  }
  const match = stdout.match(/CACHE_RESULT=(\w+)/);
  if (!match) fail(`${label}: kein CACHE_RESULT-Marker im Output gefunden.`);
  console.log(`[verify-cache] ── ${label}: fertig in ${ms}ms (CACHE_RESULT=${match[1]}).`);
  return { ms, stdout, cacheResult: match[1] };
}

const PUSH_LINE = "Pushe Drizzle-Schema";
const SEED_ADMIN_LINE = "Seede Test-Superadmin";
const SEED_REF_LINE = "Seede Basis-Referenzdaten";
const SKIP_LINE = "Push + Seeds übersprungen";

function assertCold(label: string, r: RunResult): void {
  if (r.cacheResult !== "cold") fail(`${label}: erwartete CACHE_RESULT=cold, war ${r.cacheResult}.`);
  for (const line of [PUSH_LINE, SEED_ADMIN_LINE, SEED_REF_LINE]) {
    if (!r.stdout.includes(line)) fail(`${label}: erwartete Zeile fehlt im Output: "${line}".`);
  }
  ok(`${label}: Cache KALT gebaut — Push + beide Seeds liefen.`);
}

function assertWarm(label: string, r: RunResult): void {
  if (r.cacheResult !== "warm") fail(`${label}: erwartete CACHE_RESULT=warm, war ${r.cacheResult}.`);
  if (!r.stdout.includes(SKIP_LINE)) fail(`${label}: "${SKIP_LINE}" fehlt im Output.`);
  for (const line of [PUSH_LINE, SEED_ADMIN_LINE, SEED_REF_LINE]) {
    if (r.stdout.includes(line)) {
      fail(`${label}: Push/Seed-Zeile lief OBWOHL warm erwartet: "${line}".`);
    }
  }
  ok(`${label}: Cache WARM wiederverwendet — Push + Seeds übersprungen.`);
}

function main(): void {
  console.log(
    `[verify-cache] Cache-DB: ${CACHE_DB_NAME}. Beweise Kalt-/Warm-Pfad + Hash-Invalidierung.`,
  );

  // --- Garantie 1: KALTER Aufbau -----------------------------------------
  // Cache vorab droppen, damit Lauf 1 garantiert kalt ist.
  dropCache();
  const cold = runOrchestrator("Lauf 1 (kalt)");
  assertCold("Lauf 1 (kalt)", cold);

  // --- Garantie 2: WARME Wiederverwendung + messbar schneller -------------
  const warm = runOrchestrator("Lauf 2 (warm)");
  assertWarm("Lauf 2 (warm)", warm);

  const delta = cold.ms - warm.ms;
  if (delta <= 0) {
    fail(
      `Warmer Lauf war NICHT schneller (kalt ${cold.ms}ms vs warm ${warm.ms}ms). ` +
        `Erwartet: warm < kalt, da Push + Seeds entfallen.`,
    );
  }
  ok(
    `Warmer Lauf messbar schneller: ${warm.ms}ms vs ${cold.ms}ms kalt ` +
      `(−${delta}ms / −${Math.round((delta / cold.ms) * 100)}%).`,
  );

  // --- Garantie 3: Seed-/Schema-Änderung invalidiert den Cache -----------
  const original = readFileSync(PROBE_FILE);
  let invalidation: RunResult | null = null;
  try {
    writeFileSync(PROBE_FILE, Buffer.concat([original, Buffer.from(PROBE_MARKER)]));
    console.log(
      `\n[verify-cache] Hash-Quelle geändert (${PROBE_FILE}) — erwarte erneuten KALT-Aufbau.`,
    );
    invalidation = runOrchestrator("Lauf 3 (nach Hash-Änderung)");
  } finally {
    // Datei IMMER byte-genau wiederherstellen.
    writeFileSync(PROBE_FILE, original);
    console.log(`[verify-cache] Hash-Quelle ${PROBE_FILE} wiederhergestellt.`);
  }
  assertCold("Lauf 3 (nach Hash-Änderung)", invalidation);
  ok("Hash-Änderung invalidiert den Cache — erneuter KALT-Aufbau bestätigt.");

  // Aufräumen + sauberer Endzustand: Der in Lauf 3 gebaute Cache basiert noch auf
  // der temporären Probe-Quelle. Wir droppen ihn und bauen den Cache ein letztes
  // Mal aus der WIEDERHERGESTELLTEN Quelle neu. So bleibt eine GÜLTIGE, WARME
  // Cache-DB zurück — sonst startete der nächste (ggf. parallele) Lauf wieder
  // KALT, und zwei zeitgleiche Kalt-Builds rennen um dieselbe geteilte Cache-DB
  // (drizzle-kit push -> exit 1).
  dropCache();
  const rebuilt = runOrchestrator("Abschluss (Cache aus Originalquelle neu)");
  assertCold("Abschluss (Cache aus Originalquelle neu)", rebuilt);
  ok("Cache aus wiederhergestellter Originalquelle neu gebaut — Endzustand WARM/gültig.");

  console.log(
    `\n[verify-cache] ✅ ALLE Garantien erfüllt: kalt baut, warm überspringt + ist schneller, ` +
      `Hash-Änderung invalidiert.`,
  );
}

main();
