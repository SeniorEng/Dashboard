import { build as viteBuild } from "vite";
import { rm, writeFile } from "fs/promises";
import { buildServerBundle } from "./server-bundle";

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  const buildTimestamp = new Date().toISOString();
  console.log(`Build started at ${buildTimestamp}`);

  console.log("building client...");
  await viteBuild();

  console.log("generating OpenAPI spec...");
  {
    const { buildOpenApiDocument } = await import("../shared/api/openapi");
    const { mkdir } = await import("fs/promises");
    await mkdir("docs/api", { recursive: true });
    await writeFile(
      "docs/api/openapi.json",
      JSON.stringify(buildOpenApiDocument(), null, 2) + "\n",
    );
  }

  console.log("building server...");
  await buildServerBundle({
    outfile: "dist/index.cjs",
    defineNodeEnv: "production",
    minify: true,
  });
}

buildAll().then(async () => {
  const sourceHash = await getSourceHash();
  await writeFile("dist/.build-meta.json", JSON.stringify({
    builtAt: new Date().toISOString(),
    sourceHash,
  }));
  console.log(`Build complete. Source hash: ${sourceHash}`);

  try {
    const { checkPrePublishBackup, printPrePublishBackupResult } = await import(
      "./check-pre-publish-backup.mjs"
    );
    const backupResult = await checkPrePublishBackup();
    printPrePublishBackupResult(backupResult);
  } catch (err) {
    console.warn("Pre-Publish-Backup-Check übersprungen:", (err as Error).message);
  }
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
