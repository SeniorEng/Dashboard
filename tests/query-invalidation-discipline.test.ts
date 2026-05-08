import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const CLIENT_SRC = join(process.cwd(), "client/src");
const ALLOWED_FILE = "client/src/lib/query-invalidation.ts";
const ALLOW_MARKER = "invalidate-direct-allowed";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

describe("query invalidation discipline", () => {
  it("forbids raw queryClient.invalidateQueries calls outside query-invalidation.ts without an allow marker", () => {
    const files = walk(CLIENT_SRC);
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(process.cwd(), file).replace(/\\/g, "/");
      if (rel === ALLOWED_FILE) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (!line.includes(".invalidateQueries(")) return;
        const window = [
          idx > 1 ? lines[idx - 2] : "",
          idx > 0 ? lines[idx - 1] : "",
          line,
        ];
        const allowed = window.some((l) => l.includes(ALLOW_MARKER));
        if (!allowed) {
          violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      violations,
      `Direct queryClient.invalidateQueries() calls must be replaced with invalidateRelated() from "@/lib/query-invalidation". If a call is intentionally scoped (e.g. by record ID), add a "// invalidate-direct-allowed: <reason>" comment on the line above. Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
