import { defineConfig } from "vitest/config";
import path from "path";

// Gemeinsame Modul-Aliase für alle Projects.
const alias = {
  "@shared": path.resolve(__dirname, "./shared"),
  "@assets": path.resolve(__dirname, "./attached_assets"),
  "@": path.resolve(__dirname, "./client/src"),
};

// Pure Tests, die KEINEN laufenden App-Server / keine DB brauchen und daher
// gefahrlos parallel (mit Datei-Isolation) laufen können.
const UNIT_INCLUDE = [
  "tests/unit/**/*.test.ts",
  "tests/unit/**/*.test.tsx",
  "tests/architecture/**/*.test.ts",
  "tests/architecture/**/*.test.tsx",
];

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: { alias },
  test: {
    // Flake-Härtung (Task #774): Datei-Isolation EXPLIZIT an. Jede Testdatei
    // läuft in einem frischen Modul-Graph, damit Modul-State nicht zwischen
    // Dateien leckt (häufige Flake-Ursache bei geteilten Singletons/Caches).
    isolate: true,
    // Mergify-Flake-Guide: Unit- und Integration-Pool sauber trennen.
    //  - unit:        parallel, kein Server-/DB-Setup, schnelles Feedback.
    //  - integration: sequenziell, teilt sich eine DB + laufenden App-Server,
    //                 daher KEINE Datei-Parallelität (sonst Race-Conditions
    //                 auf gemeinsamem State).
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
          // Sequenziell: gemeinsamer App-Server + DB-State.
          fileParallelism: false,
          testTimeout: 60000,
          hookTimeout: 60000,
          setupFiles: ["./tests/setup.ts"],
          globalSetup: ["./tests/globalSetup.ts"],
        },
      },
    ],
  },
});
