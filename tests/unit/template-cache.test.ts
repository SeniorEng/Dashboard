/**
 * Task #907 — Unit-Tests für die reine Entscheidungs-/Hash-Logik der
 * wiederverwendeten Cache-Template-DB.
 *
 * `isCacheFresh` entscheidet, ob die vorhandene Cache-DB für den aktuellen
 * Schema-/Seed-Hash wiederverwendet werden darf. `computeTemplateHash` muss
 * deterministisch sein und auf jede inhaltliche Änderung der gehashten Quellen
 * reagieren — sonst würde ein veralteter Cache stillschweigend ein falsches
 * Schema klonen.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  advisoryLockKey,
  CACHE_BUILD_LOCK_KEY,
  CACHE_DB_NAME,
  collectHashableFiles,
  computeTemplateHash,
  isCacheFresh,
} from "../../scripts/lib/template-cache.ts";

describe("CACHE_DB_NAME", () => {
  it("behält das cc_test_-Präfix (Sicherheits-Invariante)", () => {
    expect(CACHE_DB_NAME.startsWith("cc_test_")).toBe(true);
  });
});

describe("advisoryLockKey (Task #913)", () => {
  it("ist deterministisch für denselben Namen", () => {
    expect(advisoryLockKey("foo")).toBe(advisoryLockKey("foo"));
  });

  it("unterscheidet sich für unterschiedliche Namen", () => {
    expect(advisoryLockKey("foo")).not.toBe(advisoryLockKey("bar"));
  });

  it("liefert einen positiven, vorzeichenbehafteten 63-Bit-bigint (Postgres-tauglich)", () => {
    const key = advisoryLockKey("foo");
    expect(typeof key).toBe("bigint");
    expect(key >= 0n).toBe(true);
    expect(key < 1n << 63n).toBe(true);
  });

  it("CACHE_BUILD_LOCK_KEY ist aus dem Cache-DB-Namen abgeleitet", () => {
    expect(CACHE_BUILD_LOCK_KEY).toBe(advisoryLockKey(CACHE_DB_NAME));
  });
});

describe("isCacheFresh", () => {
  it("ist frisch, wenn der hinterlegte Hash exakt passt", () => {
    expect(isCacheFresh("abc123", "abc123")).toBe(true);
  });

  it("ist nicht frisch bei abweichendem Hash", () => {
    expect(isCacheFresh("abc123", "def456")).toBe(false);
  });

  it("ist nicht frisch, wenn kein Hash hinterlegt ist (null/leer)", () => {
    expect(isCacheFresh(null, "abc123")).toBe(false);
    expect(isCacheFresh("", "abc123")).toBe(false);
  });
});

describe("computeTemplateHash", () => {
  let root: string;

  function seedFixture(): void {
    mkdirSync(join(root, "shared", "schema"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "shared", "schema", "users.ts"), "export const users = {};\n");
    writeFileSync(join(root, "shared", "schema", "index.ts"), "export * from './users';\n");
    writeFileSync(join(root, "shared", "schema.ts"), "export * from './shared/schema';\n");
    writeFileSync(join(root, "drizzle.config.ts"), "export default {};\n");
    writeFileSync(join(root, "scripts", "ci-seed-superadmin.ts"), "// seed admin\n");
    writeFileSync(join(root, "scripts", "seed-test-reference-data.ts"), "// seed ref\n");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tmpl-cache-"));
    seedFixture();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ist deterministisch für identische Quellen", () => {
    expect(computeTemplateHash(root)).toBe(computeTemplateHash(root));
  });

  it("ändert sich, wenn eine Schema-Datei geändert wird", () => {
    const before = computeTemplateHash(root);
    writeFileSync(join(root, "shared", "schema", "users.ts"), "export const users = { id: 1 };\n");
    expect(computeTemplateHash(root)).not.toBe(before);
  });

  it("ändert sich, wenn eine neue Schema-Datei hinzukommt", () => {
    const before = computeTemplateHash(root);
    writeFileSync(join(root, "shared", "schema", "budget.ts"), "export const budget = {};\n");
    expect(computeTemplateHash(root)).not.toBe(before);
  });

  it("ändert sich, wenn ein Seed-Skript geändert wird", () => {
    const before = computeTemplateHash(root);
    writeFileSync(join(root, "scripts", "seed-test-reference-data.ts"), "// seed ref v2\n");
    expect(computeTemplateHash(root)).not.toBe(before);
  });

  it("ändert sich, wenn die drizzle.config geändert wird", () => {
    const before = computeTemplateHash(root);
    writeFileSync(join(root, "drizzle.config.ts"), "export default { out: './x' };\n");
    expect(computeTemplateHash(root)).not.toBe(before);
  });
});

describe("computeTemplateHash gegen das echte Repo (Smoke)", () => {
  it("findet die realen Quellen und liefert einen stabilen, nicht-leeren Hash", () => {
    const repoRoot = join(__dirname, "..", "..");
    const files = collectHashableFiles(repoRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes(join("shared", "schema")))).toBe(true);
    expect(files.some((f) => f.endsWith("drizzle.config.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("seed-test-reference-data.ts"))).toBe(true);

    const hash = computeTemplateHash(repoRoot);
    expect(hash).toMatch(/^[0-9a-f]{16,}$/);
    expect(computeTemplateHash(repoRoot)).toBe(hash);
  });
});
