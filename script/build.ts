import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile } from "fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "@neondatabase/serverless",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
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
  "ws",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  const buildTimestamp = new Date().toISOString();
  console.log(`Build started at ${buildTimestamp}`);

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().then(async () => {
  const sourceHash = await getSourceHash();
  await writeFile("dist/.build-meta.json", JSON.stringify({
    builtAt: new Date().toISOString(),
    sourceHash,
  }));
  console.log(`Build complete. Source hash: ${sourceHash}`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

async function getSourceHash(): Promise<string> {
  const { createHash } = await import("crypto");
  const { readdir, readFile: rf } = await import("fs/promises");
  const { join } = await import("path");

  const hash = createHash("sha256");
  const dirs = ["server", "shared", "client/src"];

  async function walkDir(dir: string) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          await walkDir(fullPath);
        } else if (entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name)) {
          const content = await rf(fullPath);
          hash.update(`${fullPath}:`);
          hash.update(content);
        }
      }
    } catch {}
  }

  for (const dir of dirs) await walkDir(dir);
  return hash.digest("hex").slice(0, 16);
}
