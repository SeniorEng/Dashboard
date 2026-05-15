import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const CLIENT_SRC = join(process.cwd(), "client/src");
const QUERY_INVALIDATION_FILE = join(CLIENT_SRC, "lib/query-invalidation.ts");
const ALLOWED_FILE = "client/src/lib/query-invalidation.ts";
const ALLOW_MARKER = "invalidate-direct-allowed";

const BUDGET_KEY_PREFIXES = [
  "budget-",
  "initial-balances",
];

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

  it("registers every budget-related useQuery key in DOMAIN_QUERY_KEYS.budget", () => {
    const registry = readFileSync(QUERY_INVALIDATION_FILE, "utf8");
    const budgetBlockMatch = registry.match(/budget:\s*\[([\s\S]*?)\],?\s*\n\s*notifications:/);
    expect(budgetBlockMatch, "DOMAIN_QUERY_KEYS.budget block must be present").not.toBeNull();
    const registered = new Set<string>();
    for (const m of (budgetBlockMatch![1].matchAll(/\[\s*"([^"]+)"/g))) {
      registered.add(m[1]);
    }

    const files = walk(CLIENT_SRC);
    // Capture the first segment AND the second segment (if any) of a queryKey array.
    // Second segment may be: "literal" | 'literal' | identifier (variable, expression).
    const queryKeyRegex = /queryKey:\s*\[\s*(?:"([^"]+)"|'([^']+)')\s*(?:,\s*([^,\]]+))?/g;
    const registryOffenders: string[] = [];
    const shapeOffenders: string[] = [];

    for (const file of files) {
      const rel = relative(process.cwd(), file).replace(/\\/g, "/");
      if (rel === ALLOWED_FILE) continue;
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(queryKeyRegex)) {
        const key = match[1] ?? match[2];
        if (!key) continue;
        const isBudgetKey = BUDGET_KEY_PREFIXES.some((p) => key === p.replace(/-$/, "") || key.startsWith(p));
        if (!isBudgetKey) continue;
        if (!registered.has(key)) {
          registryOffenders.push(`${rel}: queryKey starts with "${key}" but is not registered in DOMAIN_QUERY_KEYS.budget`);
        }
        // Check the customer-scoping shape: second segment must look like a numeric customerId
        // (numeric literal, or an expression that converts to number — parseInt(...), Number(...), or a *Id-suffixed identifier).
        const second = (match[3] ?? "").trim();
        if (!second) continue;
        const isNumericLiteral = /^-?\d+$/.test(second);
        const isNumericExpr = /^(?:parseInt|Number)\s*\(/.test(second);
        const isNumericIdentifier = /[A-Za-z_$]Id\b/.test(second) && !/^"|^'/.test(second);
        const isStringLiteral = /^["']/.test(second);
        if (isStringLiteral) {
          shapeOffenders.push(`${rel}: budget key "${key}" has a string second segment (${second}); customerId must be numeric`);
          continue;
        }
        if (!isNumericLiteral && !isNumericExpr && !isNumericIdentifier) {
          // Allow unknown expressions (e.g. computed values) — only flag clearly wrong shapes.
          continue;
        }
      }
    }

    expect(
      registryOffenders,
      `Every budget-related useQuery key must be registered in DOMAIN_QUERY_KEYS.budget so that invalidateRelated(qc, "budget", ...) reaches it. Add the top-level key (without customerId) to client/src/lib/query-invalidation.ts. Offenders:\n${registryOffenders.join("\n")}`,
    ).toEqual([]);
    expect(
      shapeOffenders,
      `Budget query keys must follow [<key>, <numeric customerId>, ...] — string customerIds break scoped invalidation. Offenders:\n${shapeOffenders.join("\n")}`,
    ).toEqual([]);
  });
});
