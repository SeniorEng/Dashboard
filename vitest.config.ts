import { defineConfig, mergeConfig, type UserConfig } from "vitest/config";
import path from "path";

// Gemeinsame Modul-Aliase für alle Configs (Haupt-Config + die zwei
// Stryker-Profile). Single-Source-of-Truth — die Stryker-Configs erben sie über
// `mergeConfig(baseConfig, …)`, statt sie zu wiederholen.
const alias = {
  "@shared": path.resolve(__dirname, "./shared"),
  "@assets": path.resolve(__dirname, "./attached_assets"),
  "@": path.resolve(__dirname, "./client/src"),
};

// Geteilte Basis für ALLE Vitest-Configs in diesem Repo (Task #930).
// `vitest.config.ts` ist die Single-Source-of-Truth; die Stryker-Profile
// (`vitest.stryker.config.ts` + `vitest.stryker-vitest.config.ts`) erweitern
// diese Basis via `mergeConfig` und tragen nur noch ihre Deltas (eng gepinnte
// `include`-Liste + kürzere Timeouts). Hier liegen daher genau die Settings, die
// JEDES Profil teilt: Modul-Aliase, JSX-Transform und die gemeinsamen
// Test-Grundeinstellungen. Bewusst OHNE `projects`/`globalSetup` — das sind
// Spezifika der Haupt-Config (siehe `default export`).
export const baseConfig: UserConfig = defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: { alias },
  test: {
    globals: true,
    environment: "node",
    // Flake-Härtung (Task #774): Datei-Isolation EXPLIZIT an. Jede Testdatei
    // läuft in einem frischen Modul-Graph, damit Modul-State nicht zwischen
    // Dateien leckt (häufige Flake-Ursache bei geteilten Singletons/Caches).
    isolate: true,
  },
});

// Pure Tests, die KEINEN laufenden App-Server / keine DB brauchen und daher
// gefahrlos parallel (mit Datei-Isolation) laufen können.
const UNIT_INCLUDE = [
  "tests/unit/**/*.test.ts",
  "tests/unit/**/*.test.tsx",
  "tests/architecture/**/*.test.ts",
  "tests/architecture/**/*.test.tsx",
];

// Integrations-Parallelität (Task #894): Der Orchestrator
// `scripts/with-ephemeral-db.ts` setzt `EPHEMERAL_DB_WORKERS` auf die Anzahl der
// provisionierten DB/Server-Paare. Pro Worker existiert genau EINE isolierte DB +
// EIN App-Server (Base-URL-Liste in `TEST_BASE_URLS`, Zuordnung in tests/setup.ts).
// → Wir pinnen den Fork-Pool auf exakt diese Anzahl und aktivieren
// `fileParallelism`, sobald >1 Worker da sind. Ohne Orchestrator (rohes
// `vitest run`, z.B. gegen den Dev-Server) bleibt es bei 1 Worker / sequenziell,
// damit Tests sich keine geteilte DB zerschießen.
const INTEGRATION_WORKERS = Math.max(
  1,
  Number(process.env.EPHEMERAL_DB_WORKERS || "1") || 1,
);
const INTEGRATION_PARALLEL = INTEGRATION_WORKERS > 1;

// Haupt-Config: erweitert `baseConfig` um die zwei Vitest-Projects.
//  - unit:        parallel, kein Server-/DB-Setup, schnelles Feedback.
//  - integration: teilt sich pro Worker eine DB + laufenden App-Server
//                 (Task #894), Datei-Parallelität nur über GETRENNTE Worker-DBs.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      projects: [
        {
          resolve: { alias },
          esbuild: { jsx: "automatic" },
          test: {
            name: "unit",
            globals: true,
            environment: "node",
            include: UNIT_INCLUDE,
            isolate: true,
            // Parallel: schnelles Feedback für reine Logik-/Fitness-Tests.
            fileParallelism: true,
            // Vitest 4: Projects mit unterschiedlichem `maxWorkers` dürfen nicht
            // dieselbe `sequence.groupOrder` teilen (sonst „different 'maxWorkers'
            // but same 'sequence.groupOrder'"-Abbruch vor dem ersten Test). Das
            // `unit`-Project nutzt den Default-Parallelpool, das `integration`-
            // Project pinnt `min/maxWorkers` auf die Worker-DB-Anzahl → wir trennen
            // sie in eigene Order-Gruppen: erst die schnellen Unit-/Fitness-Tests
            // (Gruppe 0), danach die DB-/Server-gebundenen Integrationstests (1).
            sequence: { groupOrder: 0 },
            testTimeout: 30000,
            hookTimeout: 30000,
            setupFiles: ["./tests/setup.ts"],
          },
        },
        {
          resolve: { alias },
          esbuild: { jsx: "automatic" },
          test: {
            name: "integration",
            globals: true,
            environment: "node",
            include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
            // Unit-/Architektur-Tests laufen im `unit`-Project, hier ausschließen,
            // damit sie nicht doppelt ausgeführt werden.
            exclude: [
              "**/node_modules/**",
              "tests/unit/**",
              "tests/architecture/**",
            ],
            isolate: true,
            // Task #894: Datei-Parallelität über isolierte Per-Worker-DB/Server.
            // Jeder Fork-Worker bekommt seine eigene Wegwerf-DB + seinen eigenen
            // App-Server (siehe scripts/with-ephemeral-db.ts + tests/setup.ts), die
            // Fork-Anzahl ist exakt auf die Worker-Anzahl gepinnt. Ohne
            // Orchestrator (1 Worker) bleibt es sequenziell.
            fileParallelism: INTEGRATION_PARALLEL,
            pool: "forks",
            // Vitest 4 (Task #936): `poolOptions.forks.minForks/maxForks` wurde
            // entfernt; die Fork-Anzahl wird jetzt über die Top-Level-Optionen
            // `minWorkers`/`maxWorkers` gepinnt (Pool-Rework, siehe
            // https://vitest.dev/guide/migration#pool-rework). Verhalten
            // unverändert: exakt INTEGRATION_WORKERS Forks → 1:1 Worker→DB-Mapping.
            minWorkers: INTEGRATION_WORKERS,
            maxWorkers: INTEGRATION_WORKERS,
            // Eigene Order-Gruppe (vgl. `unit`-Project oben): läuft NACH den
            // schnellen Unit-/Fitness-Tests, mit eigenem auf die Worker-DB-Anzahl
            // gepinnten Fork-Pool.
            sequence: { groupOrder: 1 },
            testTimeout: 60000,
            hookTimeout: 60000,
            setupFiles: ["./tests/setup.ts"],
            globalSetup: ["./tests/globalSetup.ts"],
          },
        },
      ],
    },
  }),
);
