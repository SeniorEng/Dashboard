import { beforeAll, afterAll, afterEach } from "vitest";
import fc from "fast-check";
import { thawTime } from "./helpers/frozen-clock";

if (!process.env.TEST_USER_PASSWORD && process.env.TEST_USER_PASSWORD_INTERNAL) {
  process.env.TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD_INTERNAL;
}

// Per-Worker-DB-Routing (Task #894): Der Orchestrator
// `scripts/with-ephemeral-db.ts` startet pro Fork-Worker einen eigenen
// App-Server mit eigener Wegwerf-DB und übergibt deren Base-URLs in
// `TEST_BASE_URLS` (komma-separiert). Vitest weist jedem Fork eine stabile
// `VITEST_POOL_ID` (1-basiert) zu — wir mappen sie auf „ihren" Server und setzen
// `TEST_BASE_URL` entsprechend. Das MUSS auf Modul-Ebene passieren (setupFiles
// laufen vor dem Import der Testdatei), damit die `const BASE_URL =
// process.env.TEST_BASE_URL`-Konstanten der Testdateien die richtige URL sehen.
// → Dateien auf demselben Worker laufen sequenziell gegen DIESELBE DB (kein
// Konflikt), Dateien auf verschiedenen Workern parallel gegen GETRENNTE DBs.
{
  const split = (v: string | undefined) =>
    (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const baseUrls = split(process.env.TEST_BASE_URLS);
  const dbUrls = split(process.env.TEST_DATABASE_URLS);
  if (baseUrls.length > 0) {
    const poolId = Number(
      process.env.VITEST_POOL_ID || process.env.VITEST_WORKER_ID || "1",
    );
    const idx = (Math.max(1, poolId) - 1) % baseUrls.length;
    process.env.TEST_BASE_URL = baseUrls[idx];
    // WICHTIG: Direkt-DB-Tests (`import { db } from server/lib/db`) müssen GEGEN
    // DIESELBE Worker-DB laufen wie der HTTP-Server, den dieser Fork nutzt — sonst
    // sehen sie die Daten der HTTP-Aufrufe nicht (und würden ohne Override auf die
    // geerbte Dev-DB zurückfallen). Gleicher Index → Server und DB sind gepaart.
    // Muss VOR dem ersten Import von server/lib/db passieren; setupFiles laufen
    // vor der Testdatei, daher greift es rechtzeitig.
    if (dbUrls.length > 0) {
      process.env.DATABASE_URL = dbUrls[idx % dbUrls.length];
    }
    // Task #1263: Denselben Worker-Index wie der gepaarte App-Server setzen, damit
    // In-Process-PDF-Renders bzw. Direkt-Object-Storage-Writes dieses Forks unter
    // DEMSELBEN `_nonprod/<env>/run-<id>/w-<index>`-Prefix landen wie die HTTP-
    // erzeugten PDFs. Sonst kollidieren parallele Worker (eigene DBs, gleiche
    // Rechnungsnummern) im geteilten Bucket und überschreiben sich gegenseitig.
    process.env.EPHEMERAL_WORKER_ID = String(idx);
  }
}

// Reproduzierbarkeit für fast-check: gepinnter Seed sorgt dafür, dass
// Property-Failures deterministisch reproduzierbar sind. Einzelne Tests dürfen
// `numRuns` lokal überschreiben (z.B. für API-lastige Setups).
fc.configureGlobal({ seed: 42, numRuns: 100 });

beforeAll(async () => {
  process.env.NODE_ENV = "test";
});

// Sicherheitsnetz: vergessenes `freezeTime` darf nachfolgende Tests nicht
// beeinflussen. `thawTime` ist idempotent (vi.useRealTimers).
afterEach(() => {
  thawTime();
});

afterAll(async () => {
});
