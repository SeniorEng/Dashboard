/**
 * Task #447 — Architektur-Snapshot: Soft-Delete-Coverage in Routen.
 *
 * Hintergrund: Soft-Delete (`deletedAt IS NULL`) wurde historisch an mehreren
 * Stellen in `server/routes/**` vergessen. Die ESLint-Regel
 * `restrict-soft-delete-from` verhindert NEUE direkte
 * `db.select().from(<soft-deletable-Tabelle>)`-Aufrufe in Routen — sie MÜSSEN
 * stattdessen die Repos aus `server/repos/index.ts` nutzen, die den Filter
 * automatisch setzen.
 *
 * Dieser Test ist die ergänzende Snapshot-Regression: er listet pro
 * Routen-Datei auf, welche soft-deletable Tabellen referenziert werden und
 * welches Repo dafür importiert sein muss. Wenn jemand das Lint deaktiviert
 * oder eine neue Route-Datei ohne Repo-Import einführt, schlägt der Test fehl.
 *
 * Failure-Modus: Wenn eine Routen-Datei eine soft-deletable Tabelle in einem
 * `.from(<table>)`-Aufruf referenziert, muss in derselben Datei das
 * korrespondierende Repo (oder ein Repo derselben Tabelle) importiert sein.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { SOFT_DELETABLE_TABLE_IDENTS } from "../../server/repos";

const ROOT = process.cwd();
const ROUTES_ROOT = join(ROOT, "server", "routes");
const STORAGE_ROOT = join(ROOT, "server", "storage");
const SERVICES_ROOT = join(ROOT, "server", "services");

const REPO_NAME_BY_TABLE: Record<string, string> = Object.fromEntries(
  SOFT_DELETABLE_TABLE_IDENTS.map((t) => [t, `${t}Repo`]),
);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

function checkNoDirectFrom(label: string, root: string) {
  const violations: Array<{ file: string; line: number; table: string; snippet: string }> = [];

  const fromRegex = new RegExp(
    `\\.from\\(\\s*(${SOFT_DELETABLE_TABLE_IDENTS.join("|")})\\s*[\\),]`,
  );

  for (const file of walkTs(root)) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(fromRegex);
      if (!m) continue;
      violations.push({
        file: relative(ROOT, file).split(sep).join("/"),
        line: i + 1,
        table: m[1],
        snippet: lines[i].trim(),
      });
    }
  }

  if (violations.length > 0) {
    const msg = violations
      .map((v) => `  ${v.file}:${v.line} — .from(${v.table})  →  use ${REPO_NAME_BY_TABLE[v.table]}\n    ${v.snippet}`)
      .join("\n");
    expect.fail(
      `Folgende Dateien (${label}) rufen direkt \`.from(<soft-deletable-Tabelle>)\` auf — der ` +
      `\`deletedAt IS NULL\`-Filter wird hier regelmäßig vergessen. ` +
      `Bitte die Repos aus \`server/repos/index.ts\` verwenden:\n${msg}\n\n` +
      `Repo-Pattern: \`<repoName>.selectColumnsFrom({...}, tx?).where(and(..., <repoName>.activeOnly()))\`.`,
    );
  }
}

function repoUsageSnapshot(root: string): Record<string, string[]> {
  const usage: Record<string, string[]> = {};
  for (const file of walkTs(root)) {
    const content = readFileSync(file, "utf-8");
    const rel = relative(ROOT, file).split(sep).join("/");
    const usedRepos = SOFT_DELETABLE_TABLE_IDENTS
      .map((t) => REPO_NAME_BY_TABLE[t])
      .filter((repo) => new RegExp(`\\b${repo}\\b`).test(content))
      .sort();
    if (usedRepos.length > 0) {
      usage[rel] = usedRepos;
    }
  }
  return usage;
}

describe("Architektur — Soft-Delete-Coverage in server/routes/**", () => {
  it("Routen dürfen kein `db.select().from(<soft-deletable-Tabelle>)` direkt nutzen", () => {
    checkNoDirectFrom("server/routes/**", ROUTES_ROOT);
  });

  it("Snapshot: pro Routen-Datei sind nur Repo-vermittelte Reads für soft-deletable Tabellen registriert", () => {
    // Snapshot: pro Datei die Menge der referenzierten Repos. Dieser Test
    // sichert, dass künftige Refactors die Verteilung der Repos über die
    // Routen nicht versehentlich auf direkte DB-Calls zurückdrehen. Wenn
    // sich die Menge legitim ändert, einfach mit `-u` aktualisieren.
    expect(repoUsageSnapshot(ROUTES_ROOT)).toMatchSnapshot();
  });
});

describe("Architektur — Soft-Delete-Coverage in server/storage/** (Task #454)", () => {
  it("Storage-Module dürfen kein `db.select().from(<soft-deletable-Tabelle>)` direkt nutzen", () => {
    checkNoDirectFrom("server/storage/**", STORAGE_ROOT);
  });

  it("Snapshot: pro Storage-Datei sind nur Repo-vermittelte Reads registriert", () => {
    expect(repoUsageSnapshot(STORAGE_ROOT)).toMatchSnapshot();
  });
});

describe("Architektur — Soft-Delete-Coverage in server/services/** (Task #454)", () => {
  it("Service-Module dürfen kein `db.select().from(<soft-deletable-Tabelle>)` direkt nutzen", () => {
    checkNoDirectFrom("server/services/**", SERVICES_ROOT);
  });

  it("Snapshot: pro Service-Datei sind nur Repo-vermittelte Reads registriert", () => {
    expect(repoUsageSnapshot(SERVICES_ROOT)).toMatchSnapshot();
  });
});
