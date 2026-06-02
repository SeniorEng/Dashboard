// ---------------------------------------------------------------------------
// End-to-End-Regression: Zwei GLEICHZEITIGE Läufe dürfen die WARME, geteilte
// Cache-Template-DB zeitgleich klonen, ohne sich gegenseitig zu zerschießen
// (Follow-up zu Task #913/#917)
//
// Task #917 deckt den KALTEN Race ab (zwei Läufe gegen eine FEHLENDE Cache-DB
// serialisieren ihren Aufbau über einen Advisory-Lock). Dieses Skript deckt den
// KOMPLEMENTÄREN, WARMEN Pfad ab: Ist der Cache bereits frisch, klonen ZWEI
// gleichzeitig gestartete Läufe BEIDE ihre Per-Lauf-Template aus DERSELBEN
// Cache-DB via `CREATE DATABASE ... TEMPLATE cc_test_tmpl_cache`. PostgreSQL
// verlangt für eine TEMPLATE-Quelle Verbindungsfreiheit und lehnt den zweiten
// CREATE sonst mit "source database ... is being accessed by other users" ab.
// `cloneDbFromTemplate()` in `scripts/with-ephemeral-db.ts` fängt das mit einer
// begrenzten Retry-Schleife ab. Diese Retry-Logik war bisher nur ad-hoc
// abgesichert — ein künftiger Refactor könnte sie still entfernen und parallele
// Läufe wieder mit fehlschlagendem CREATE DATABASE flaky machen.
//
// Ablauf:
//   1. Warm-up: EIN Orchestrator-Lauf (provision-only), damit die Cache-DB
//      garantiert frisch/WARM ist (egal ob sie vorher fehlte oder veraltet war).
//   2. ZWEI echte Orchestrator-Läufe GLEICHZEITIG (provision-only). Im Warm-Pfad
//      springen beide direkt zum `cloneDbFromTemplate(..., CACHE_DB_NAME)` und
//      klonen zeitgleich aus derselben Quelle.
//
// Garantie:
//   - BEIDE Läufe beenden mit exit 0 (kein "being accessed by other users"-Crash).
//   - BEIDE melden `CACHE_RESULT=warm` (sie klonen, statt neu zu bauen).
//
// Ob die Retry-Schleife im konkreten Lauf tatsächlich gegriffen hat, ist
// timing-abhängig und wird daher nur informativ geloggt, NICHT hart geprüft
// (sonst wäre der Test flaky). Die harte Garantie ist: beide klonen erfolgreich.
//
// Exit 0 = Garantien erfüllt, sonst Exit 1 mit Begründung. Fehlt DATABASE_URL,
// wird sauber übersprungen (wie die übrigen DB-gegateten Schritte).
//
// Aufruf:  npx tsx scripts/verify-concurrent-template-clone.ts
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from "node:child_process";
import { CACHE_DB_NAME } from "./lib/template-cache.ts";

function fail(msg: string): never {
  console.error(`\n[verify-clone] ❌ ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`[verify-clone] ✅ ${msg}`);
}

if (process.env.NODE_ENV === "production") {
  fail("Verweigert: läuft niemals in Production.");
}

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  // Sauberes Skip wie die übrigen DB-gegateten Schritte (z.B. Forks ohne DB).
  console.log("[verify-clone] DATABASE_URL nicht gesetzt — Schritt übersprungen.");
  process.exit(0);
}

interface RunResult {
  label: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  cacheResult: string | null;
  cloneRetried: boolean;
  cloneStarted: boolean;
  ms: number;
}

const CLONE_START_LINE = "Klone Per-Lauf-Template";
const CLONE_RETRY_RE = /gerade in Benutzung — Retry/;

// Startet den echten Orchestrator im Provision-Only-Modus als eigenständigen
// Prozess und resolved erst, wenn er beendet ist. Werden zwei dieser Promises
// OHNE await nebeneinander erzeugt und gemeinsam awaitet, laufen sie wirklich
// gleichzeitig — genau das Klon-Konkurrenz-Szenario.
function startOrchestrator(label: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    console.log(`[verify-clone] ── ${label}: starte Orchestrator (provision-only) ...`);
    const t0 = Date.now();
    const child = spawn(
      "npx",
      ["tsx", "scripts/with-ephemeral-db.ts", "5099", "node", "-e", ""],
      { env: { ...process.env, EPHEMERAL_PROVISION_ONLY: "1" } },
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
      const cloneRetried = CLONE_RETRY_RE.test(stdout);
      const cloneStarted = stdout.includes(CLONE_START_LINE);
      console.log(
        `[verify-clone] ── ${label}: beendet (code ${code}, signal ${signal}) in ${ms}ms ` +
          `(CACHE_RESULT=${match ? match[1] : "?"}, Klon-Retry=${cloneRetried ? "ja" : "nein"}).`,
      );
      resolve({
        label,
        code,
        signal,
        stdout,
        cacheResult: match ? match[1] : null,
        cloneRetried,
        cloneStarted,
        ms,
      });
    });
  });
}

// Synchroner Warm-up-Lauf: stellt sicher, dass die Cache-DB existiert + frisch
// ist, BEVOR die beiden konkurrierenden Klon-Läufe starten. So nehmen beide
// garantiert den Warm-Pfad (direkter Klon), nicht den Kalt-Aufbau.
function warmUpCache(): void {
  console.log("[verify-clone] Warm-up: stelle frische Cache-DB bereit (provision-only) ...");
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
  const out = (res.stdout || "") + (res.stderr || "");
  if (res.status !== 0) {
    process.stdout.write(out);
    fail(`Warm-up-Lauf fehlgeschlagen (exit ${res.status}, ${ms}ms).`);
  }
  const match = out.match(/CACHE_RESULT=(\w+)/);
  console.log(
    `[verify-clone] Warm-up fertig in ${ms}ms (CACHE_RESULT=${match ? match[1] : "?"}). ` +
      `Cache-DB ${CACHE_DB_NAME} ist jetzt frisch.`,
  );
}

async function main(): Promise<void> {
  console.log(
    `[verify-clone] Cache-DB: ${CACHE_DB_NAME}. Beweise: zwei zeitgleiche Läufe klonen ` +
      `die WARME Vorlage parallel, ohne sich zu zerschießen (beide warm, beide exit 0).`,
  );

  warmUpCache();

  // BEIDE Promises OHNE await erzeugen, dann gemeinsam awaiten → echte Nebenläufigkeit.
  const p1 = startOrchestrator("Lauf A");
  const p2 = startOrchestrator("Lauf B");
  const results = await Promise.all([p1, p2]);

  // Vollen Output beider Läufe durchreichen (CI-Diagnose).
  for (const r of results) {
    console.log(`\n[verify-clone] ── Output ${r.label} ──────────────────────`);
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
        `. Vermutlich ist die Klon-Retry-Schleife in cloneDbFromTemplate() defekt/entfernt ` +
        `("source database is being accessed by other users").`,
    );
  }
  ok("Beide Läufe exit 0 — kein Crash beim parallelen Klonen der Vorlage.");

  // --- Garantie 2: BEIDE Läufe warm + haben den Klon wirklich angestoßen ---
  const notWarm = results.filter((r) => r.cacheResult !== "warm");
  if (notWarm.length > 0) {
    fail(
      `Nicht beide Läufe warm: ` +
        results.map((r) => `${r.label}=${r.cacheResult}`).join(", ") +
        `. Erwartet: nach dem Warm-up klonen BEIDE aus dem frischen Cache (warm), ` +
        `statt ihn neu zu bauen.`,
    );
  }
  const notCloned = results.filter((r) => !r.cloneStarted);
  if (notCloned.length > 0) {
    fail(
      `Klon-Schritt nicht erreicht in: ` +
        notCloned.map((r) => r.label).join(", ") +
        `. Erwartet wurde "${CLONE_START_LINE}" im Output beider Läufe.`,
    );
  }
  ok("Beide Läufe warm + haben die Per-Lauf-Vorlage erfolgreich aus dem Cache geklont.");

  const retried = results.filter((r) => r.cloneRetried);
  if (retried.length > 0) {
    console.log(
      `[verify-clone] ℹ️  Klon-Retry hat in ${retried.length} Lauf/Läufen gegriffen ` +
        `(${retried.map((r) => r.label).join(", ")}) — die Vorlage war kurz in Benutzung, ` +
        `der Retry hat das sauber abgefangen.`,
    );
  } else {
    console.log(
      `[verify-clone] ℹ️  Keine Klon-Retries beobachtet (Timing) — beide Klone liefen sofort durch. ` +
        `Garantie bleibt: beide haben erfolgreich geklont.`,
    );
  }

  console.log(
    `\n[verify-clone] ✅ Garantien erfüllt: zwei zeitgleiche Läufe klonen die warme ` +
      `Vorlage parallel sauber (beide warm, beide exit 0).`,
  );
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
