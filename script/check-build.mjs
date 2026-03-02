import { readFile, readdir } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";

async function getSourceHash() {
  const hash = createHash("sha256");
  const dirs = ["server", "shared", "client/src"];

  async function walkDir(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          await walkDir(fullPath);
        } else if (entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name)) {
          const content = await readFile(fullPath);
          hash.update(`${fullPath}:`);
          hash.update(content);
        }
      }
    } catch {}
  }

  for (const dir of dirs) await walkDir(dir);
  return hash.digest("hex").slice(0, 16);
}

async function main() {
  try {
    const meta = JSON.parse(await readFile("dist/.build-meta.json", "utf-8"));
    const currentHash = await getSourceHash();
    
    if (meta.sourceHash !== currentHash) {
      console.error(`\n⚠️  BUILD VERALTET! Build-Hash: ${meta.sourceHash}, Quellcode-Hash: ${currentHash}`);
      console.error(`   Build erstellt am: ${meta.builtAt}`);
      console.error(`   Bitte 'npm run build' ausführen vor dem Deployment!\n`);
      process.exit(1);
    }
    
    console.log(`✓ Build ist aktuell (Hash: ${currentHash}, erstellt: ${meta.builtAt})`);
  } catch (err) {
    console.error("\n⚠️  Kein Build gefunden! Bitte 'npm run build' ausführen.\n");
    process.exit(1);
  }
}

main();
