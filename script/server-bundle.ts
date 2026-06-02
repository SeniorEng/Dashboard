// ---------------------------------------------------------------------------
// Gemeinsame esbuild-Server-Bundle-Logik (Task #903)
//
// Single-Source-of-Truth für das Server-Bundling, damit der Prod-Build
// (`script/build.ts`) und der Ephemeral-Test-Orchestrator
// (`scripts/with-ephemeral-db.ts`) NICHT zwei divergierende Externals-/Allowlist-
// Kopien pflegen müssen.
//
// Hintergrund (Task #903): Pro Vitest-Worker startet der Orchestrator einen
// eigenen App-Server. Mit `tsx` kostet der Kaltstart (Transpilation des gesamten
// Server-Modulgraphen) ~13 s bis "serving" — DAS ist der Boot-Bottleneck, nicht
// die Startup-Seeder. Wird der Server stattdessen EINMAL pro Lauf via esbuild zu
// einem CJS-Bundle gebaut (~2 s) und mit plain `node` gebootet, ist er in ~3 s
// "serving". Das spart pro Worker ~10 s und nutzt zudem weniger PIDs/Threads als
// `tsx` (entlastet das cgroup `pids.max`-Limit ~1024).
//
// Die Allowlist (= Pakete, die INS Bundle wandern) ist bewusst klein gehalten;
// alles andere bleibt external und wird zur Laufzeit aus node_modules geladen.
// `drizzle-orm`, `drizzle-zod`, `@neondatabase/serverless` und `ws` MÜSSEN external
// bleiben (Bundling von `drizzle-orm` bricht die SQL-Template-Fragment-Komposition,
// siehe replit.md → Gotchas).
// ---------------------------------------------------------------------------
import { build } from "esbuild";
import { readFile } from "fs/promises";

// Pakete, die INS Server-Bundle gebündelt werden. Alles andere = external.
const ALLOWLIST = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "zod",
  "zod-validation-error",
];

/**
 * Liefert die Liste der externen (nicht gebündelten) Pakete: alle prod/dev-
 * Dependencies aus package.json, die NICHT in der Allowlist stehen.
 */
export async function getServerExternals(): Promise<string[]> {
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  return allDeps.filter((dep) => !ALLOWLIST.includes(dep));
}

export interface ServerBundleOptions {
  /** Zielpfad der gebündelten CJS-Datei. */
  outfile: string;
  /**
   * Wenn gesetzt, wird `process.env.NODE_ENV` zur Build-Zeit fest eingebacken
   * (Prod-Build: "production"). Für den Test-Build NICHT setzen — dort
   * entscheidet die Laufzeit-Env (`NODE_ENV=test`).
   */
  defineNodeEnv?: string;
  /** Minify (Prod: true, Test: false für lesbare Stacktraces). */
  minify?: boolean;
  /**
   * Wenn true, wird der Dev-Client-Server (`./vite`) NICHT mitgebündelt
   * (API-only Test-Bundle). Solche Bundles MÜSSEN mit `TEST_SKIP_CLIENT=1`
   * gebootet werden, damit der dynamische `import("./vite")` nie ausgeführt wird.
   */
  excludeClientServer?: boolean;
}

/**
 * Baut `server/index.ts` zu einem self-contained CJS-Bundle. Wird sowohl vom
 * Prod-Build als auch vom Test-Orchestrator genutzt.
 */
export async function buildServerBundle(opts: ServerBundleOptions): Promise<void> {
  const externals = await getServerExternals();
  // Den Dev-Client-Server (und seine vite.config) für API-only-Test-Bundles
  // external lassen → esbuild zieht weder vite noch die React-Plugins ins Bundle.
  const external = opts.excludeClientServer
    ? [...externals, "./vite", "../vite.config"]
    : externals;

  await build({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: opts.outfile,
    define: opts.defineNodeEnv
      ? { "process.env.NODE_ENV": JSON.stringify(opts.defineNodeEnv) }
      : undefined,
    minify: opts.minify ?? false,
    external,
    logLevel: opts.minify ? "info" : "error",
  });
}
