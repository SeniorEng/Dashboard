import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Replit-Exit — Build-Metadaten für den Health-Endpoint (Task #1840).
//
// Der Prod-Build (`script/build.ts`) schreibt `dist/.build-meta.json` mit
// `sourceHash` (16-stelliger Quell-Hash) und `builtAt`. Der Health-Endpoint
// gibt diese Version aus, damit ein Deploy gegen den erwarteten Quellstand
// geprüft werden kann. In der Entwicklung (tsx, kein Build) fällt die Version
// auf "dev" zurück. Enthält KEINE PII/Secrets.
// ---------------------------------------------------------------------------

let cached: { version: string; builtAt: string | null } | null = null;

export function getBuildInfo(): { version: string; builtAt: string | null } {
  if (cached) return cached;
  try {
    const raw = readFileSync(join(process.cwd(), "dist", ".build-meta.json"), "utf-8");
    const meta = JSON.parse(raw) as { sourceHash?: unknown; builtAt?: unknown };
    cached = {
      version: typeof meta.sourceHash === "string" ? meta.sourceHash : "unknown",
      builtAt: typeof meta.builtAt === "string" ? meta.builtAt : null,
    };
  } catch {
    cached = { version: "dev", builtAt: null };
  }
  return cached;
}
