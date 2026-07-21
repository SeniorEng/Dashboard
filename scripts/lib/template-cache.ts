// ---------------------------------------------------------------------------
// Wiederverwendbare, geseedete Template-DB für Testläufe (Task #907)
//
// Seit Task #903 ist der dominante Fixkosten-Block beim Start eines Testlaufs
// nicht mehr der Server-Boot, sondern der Aufbau der Template-DB:
// `drizzle-kit push --force` + Superadmin-Seed + Basis-Referenzdaten-Seed —
// auf JEDEM Lauf frisch (~12s seriell), obwohl sich Schema + Seeds zwischen den
// meisten Läufen NICHT ändern.
//
// Idee: Wir halten EINE persistente, geseedete Cache-Template-DB
// (`cc_test_tmpl_cache`) vor und schlüsseln sie über einen Hash von
// `shared/schema/**` + `drizzle.config.ts` + den Seed-Skripten. Stimmt der Hash
// beim nächsten Lauf mit dem in der Cache-DB hinterlegten überein (gespeichert
// als `COMMENT ON DATABASE`), überspringen wir Push + Seeds komplett und klonen
// die Per-Lauf-Template direkt aus dem Cache. Ändert sich das Schema oder ein
// Seed-Skript, kippt der Hash und der Cache wird einmalig neu gebaut.
//
// ISOLATION bleibt erhalten: Jeder Lauf klont weiterhin eine eigene Wegwerf-
// Per-Lauf-Template (und daraus die Worker-DBs) — NUR die geseedete Vorlage wird
// über Läufe hinweg wiederverwendet, nie direkt beschrieben.
//
// Diese Datei enthält bewusst die reine, testbare Entscheidungs-/Hash-Logik
// (keine DB-Seiteneffekte) — das psql-/Provisionierungs-Drumherum lebt im
// Orchestrator `scripts/with-ephemeral-db.ts`.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { DB_PREFIX } from "./ephemeral-db-sweep.ts";

// Stabiler, fixer Name der wiederverwendeten Cache-Template-DB. Behält das
// `cc_test_`-Präfix (Sicherheits-Invariante: Orchestrator/Sweep fassen nur
// solche DBs an), wird aber im Orphan-Sweep explizit GESCHÜTZT (sie ist
// langlebig + zwischen Läufen verbindungslos und sähe sonst wie eine Waise aus).
export const CACHE_DB_NAME = `${DB_PREFIX}tmpl_cache`;

// Wird in den Hash gemischt, damit wir bei Änderungen am Cache-/Seed-VERFAHREN
// (nicht nur an den gehashten Dateien) alle bestehenden Caches gezielt
// invalidieren können. Bei inhaltlichen Änderungen am Build-Ablauf hochzählen.
export const CACHE_FORMAT_VERSION = "1";

// Quellen, deren Inhalt das Template-Ergebnis (Schema + Seeds) bestimmt.
// Verzeichnisse werden rekursiv gehasht, Einzeldateien direkt.
export const HASH_SOURCE_DIRS = ["shared/schema"] as const;
export const HASH_SOURCE_FILES = [
  "shared/schema.ts",
  "drizzle.config.ts",
  "scripts/ci-seed-superadmin.ts",
  "scripts/seed-test-reference-data.ts",
] as const;

function collectDirFiles(absDir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(absDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDirFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function fileExists(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

// Sammelt alle hashrelevanten Dateien (absolut, dedupliziert, sortiert) unter
// `rootDir`. Sortierung garantiert plattform-/reihenfolgenunabhängige Hashes.
export function collectHashableFiles(rootDir: string): string[] {
  const found = new Set<string>();
  for (const dir of HASH_SOURCE_DIRS) {
    for (const f of collectDirFiles(join(rootDir, dir))) found.add(f);
  }
  for (const f of HASH_SOURCE_FILES) {
    const abs = join(rootDir, f);
    if (fileExists(abs)) found.add(abs);
  }
  // Nach RELATIVEM Pfad mit „/"-Normalisierung sortieren, damit der Hash auf
  // jeder Plattform identisch ausfällt.
  return [...found].sort((a, b) =>
    relative(rootDir, a).split(sep).join("/") <
    relative(rootDir, b).split(sep).join("/")
      ? -1
      : 1,
  );
}

// Deterministischer SHA-256 über Format-Version + (relativer Pfad, Inhalt) jeder
// Quelldatei. Reine Funktion bis auf das Lesen der Dateien.
export function computeTemplateHash(rootDir: string = process.cwd()): string {
  const h = createHash("sha256");
  h.update(`v${CACHE_FORMAT_VERSION}\0`);
  for (const abs of collectHashableFiles(rootDir)) {
    const rel = relative(rootDir, abs).split(sep).join("/");
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(abs));
    h.update("\0");
  }
  return h.digest("hex");
}

// Reine Entscheidung: Ist die vorhandene Cache-DB für den aktuellen Hash frisch?
// `storedHash === null` => keine Cache-DB / kein hinterlegter Hash => nicht frisch.
export function isCacheFresh(
  storedHash: string | null,
  currentHash: string,
): boolean {
  return storedHash !== null && storedHash.length > 0 && storedHash === currentHash;
}

// Task #913: Stabiler Postgres-Advisory-Lock-Schlüssel, mit dem konkurrierende
// KALTE Cache-Aufbauten serialisiert werden. Zwei gleichzeitig gestartete Läufe
// (im Agent-/Validation-Harness laufen `test` und `e2e-smoke` parallel) würden
// sonst bei FEHLENDEM Cache beide dieselbe Cache-DB droppen/erzeugen und
// gleichzeitig `drizzle-kit push --force` dagegen feuern → einer scheitert.
// Advisory-Locks sind Cluster-weit (Session-Scope, datenbankübergreifend), daher
// reicht EIN fixer Schlüssel, abgeleitet aus dem Cache-DB-Namen. Wir maskieren
// auf 63 Bit, damit der Wert ein positiver, vorzeichenbehafteter bigint bleibt
// (Postgres `pg_advisory_lock(bigint)`).
export function advisoryLockKey(name: string = CACHE_DB_NAME): bigint {
  const digest = createHash("sha256").update(name).digest();
  const raw = digest.readBigUInt64BE(0);
  return raw & ((1n << 63n) - 1n);
}

export const CACHE_BUILD_LOCK_KEY = advisoryLockKey();

// Task #1489: Clusterweites Worker-Slot-Gate gegen Übersubskription des
// cgroup-pids-Limits. Der Agent-/Validation-Harness fährt teils MEHRERE
// Orchestrator-Läufe gleichzeitig (`test`, `e2e-smoke`) — jeder will seine
// Default-Worker (je eigener App-Server + Chromium) starten, in Summe sprengt
// das die PIDs. Wir vergeben daher clusterweit nur ein begrenztes GEMEINSAMES
// Worker-Budget über Postgres-Advisory-Locks: Slot i belegt den Schlüssel
// `WORKER_SLOT_LOCK_BASE + i`. Jeder Lauf reserviert per `pg_try_advisory_lock`
// so viele Slots wie er Worker will (mind. 1), gedeckelt durch das Budget — der
// zweite parallele Lauf bekommt dann automatisch weniger und überschreitet das
// PID-Limit nicht. Advisory-Locks sind session-/clusterweit und werden bei
// Verbindungsabbruch automatisch freigegeben (kein verwaister Lock).
export const WORKER_SLOT_LOCK_BASE = advisoryLockKey("cc_test_worker_slot");

// Konservativer, dokumentierter Default für das gemeinsame Worker-Budget über
// ALLE gleichzeitig laufenden Orchestrator-Läufe hinweg. Override via
// `EPHEMERAL_GLOBAL_WORKER_BUDGET`; `0` deaktiviert das Gate (volle Worker-Zahl).
//
// Task #1818: Von 4 → 2 gesenkt. Bei 4 konnten `test` (Default 2 Worker) und
// `e2e-smoke` (1 Worker) GLEICHZEITIG jeweils ihre volle Worker-Zahl belegen —
// in Summe 3 App-Server + Vite-Client-Build + Chromium-Browser gleichzeitig,
// was im Agent-/Validation-Harness den Memory-Watchdog-/Overload-Restart-Loop
// auslöste. Mit Budget 2 bekommt ein ALLEIN laufender `test` weiterhin seine
// vollen 2 Worker (voller Parallel-Win), aber sobald ein zweiter Lauf parallel
// dazukommt, teilen sie sich das Budget (je min. 1 Worker, garantiert in
// acquireWorkerSlots) → die addierte Spitzenlast bleibt gedeckelt. Wer bewusst
// mehr Parallelität will, setzt `EPHEMERAL_GLOBAL_WORKER_BUDGET` höher.
export const DEFAULT_GLOBAL_WORKER_BUDGET = 2;
