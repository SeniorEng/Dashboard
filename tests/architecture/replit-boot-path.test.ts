/**
 * Task #541 — Regressionsschutz: Der Workspace-Boot-Pfad darf NUR die App starten.
 *
 * Hintergrund (RCA): Der von Replit generierte Sammel-Workflow `Project` startet
 * ALLE Workflows parallel (App + die fünf schweren Checks `typecheck`, `lint`,
 * `test`, `billing-cov`, `e2e-smoke`). Zeigt der `runButton` in `.replit` auf
 * `Project`, fährt der Workspace beim Boot sechs schwere Tasks gleichzeitig hoch
 * → RAM/OOM, Preview-Disconnect. Der dauerhafte Fix: `runButton` zeigt auf
 * `Start application`; die Checks bleiben als On-Demand-Workflows erhalten,
 * werden aber NICHT mehr automatisch gebootet.
 *
 * Dieser Test verriegelt den Boot-Pfad: Er löst auf, welche Shell-Kommandos der
 * `runButton`-Workflow (transitiv, inkl. `workflow.run`-Komposita) tatsächlich
 * startet, und besteht nur, wenn KEIN schweres Test-/Check-Kommando dabei ist.
 *
 * Reiner Datei-Read, kein Server/DB — läuft im `unit`-Project.
 *
 * HINWEIS: Der `runButton` wird über das Replit-Run-Dropdown gesetzt und in
 * `.replit` committet (Agent-Tooling kann ihn nicht setzen — es hält jeden
 * Workflow im parallelen `Project`-Komposit). Schlägt dieser Test mit
 * `runButton = "Project"` fehl, muss der Run-Button einmalig manuell auf
 * `Start application` gestellt werden. Siehe
 * `Replit-Workspace-Overload-Prevention-Plan.md`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

type Task = { task?: string; args?: string };

/**
 * Zeilenbasiertes Mini-Parsing der `.replit`-TOML (keine TOML-Dependency, die
 * Workflow-Sektion ist flach). Liefert den `runButton` und eine Map
 * Workflow-Name -> Tasks.
 */
function parseReplit(toml: string): {
  runButton: string | null;
  workflows: Map<string, Task[]>;
} {
  const lines = toml.split(/\r?\n/);
  let runButton: string | null = null;
  const workflows = new Map<string, Task[]>();

  let curName: string | null = null;
  let curTasks: Task[] | null = null;
  let curTask: Task | null = null;
  let section: "workflow" | "task" | "other" = "other";

  const flushTask = () => {
    if (curTask && curTasks) curTasks.push(curTask);
    curTask = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    const rb = line.match(/^runButton\s*=\s*"([^"]+)"/);
    if (rb) {
      runButton = rb[1];
      continue;
    }

    if (line === "[[workflows.workflow]]") {
      flushTask();
      curName = null;
      curTasks = [];
      section = "workflow";
      continue;
    }
    if (line === "[[workflows.workflow.tasks]]") {
      flushTask();
      curTask = {};
      section = "task";
      continue;
    }
    if (line.startsWith("[")) {
      // Irgendeine andere Sektion beendet den Workflow-Kontext.
      flushTask();
      section = "other";
      continue;
    }

    if (section === "workflow") {
      const nm = line.match(/^name\s*=\s*"([^"]+)"/);
      if (nm && curTasks) {
        curName = nm[1];
        workflows.set(curName, curTasks);
      }
    } else if (section === "task" && curTask) {
      const tk = line.match(/^task\s*=\s*"([^"]+)"/);
      const ag = line.match(/^args\s*=\s*"(.*)"\s*$/);
      if (tk) curTask.task = tk[1];
      else if (ag) curTask.args = ag[1];
    }
  }
  flushTask();

  return { runButton, workflows };
}

/**
 * Sammelt rekursiv alle Shell-Kommandos, die das Starten von `name` auslöst —
 * inklusive `workflow.run`-Verweise (Komposita wie `Project`).
 */
function collectBootCommands(
  name: string,
  workflows: Map<string, Task[]>,
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const cmds: string[] = [];
  for (const t of workflows.get(name) ?? []) {
    if (t.task === "shell.exec" && t.args) cmds.push(t.args);
    else if (t.task === "workflow.run" && t.args)
      cmds.push(...collectBootCommands(t.args, workflows, seen));
  }
  return cmds;
}

// Schwere Test-/Check-/Coverage-Kommandos, die NICHT beim Boot laufen dürfen.
// Bewusst spezifisch: das App-Kommando `NODE_ENV=test tsx server/index.ts`
// enthält das Wort "test" und darf NICHT matchen.
const HEAVY_BOOT_PATTERNS: RegExp[] = [
  /vitest/,
  /coverage-gate/,
  /playwright/,
  /test:e2e/,
  /with-ephemeral-db/,
  /\bnpm run check\b/,
  /\bnpm run lint\b/,
];

describe("Architektur: Workspace-Boot startet nur die App (Task #541)", () => {
  const toml = readFileSync(join(process.cwd(), ".replit"), "utf8");
  const { runButton, workflows } = parseReplit(toml);

  it("hat einen runButton, der auf einen definierten Workflow zeigt", () => {
    expect(runButton, "Kein runButton in `.replit` gefunden.").not.toBeNull();
    expect(
      workflows.has(runButton as string),
      `runButton="${runButton}" verweist auf keinen definierten Workflow. ` +
        `Bekannt: ${[...workflows.keys()].join(", ")}.`,
    ).toBe(true);
  });

  it("startet beim Boot KEIN schweres Test-/Check-Kommando", () => {
    const bootCmds = runButton ? collectBootCommands(runButton, workflows) : [];
    const offenders = bootCmds.filter((c) =>
      HEAVY_BOOT_PATTERNS.some((re) => re.test(c)),
    );
    expect(
      offenders,
      `Der Boot-Pfad (runButton="${runButton}") startet schwere Tasks: ` +
        `${JSON.stringify(offenders)}. Beim Workspace-Start darf NUR ` +
        "`Start application` booten — sonst Überlast/OOM (Task #541). " +
        "Setze den Run-Button auf `Start application` (Run-Dropdown). " +
        "Der Sammel-Workflow `Project` ist Legacy und darf nicht der " +
        "Boot-Pfad sein. Details: Replit-Workspace-Overload-Prevention-Plan.md.",
    ).toEqual([]);
  });

  it("bootet tatsächlich die App (server/index.ts)", () => {
    const bootCmds = runButton ? collectBootCommands(runButton, workflows) : [];
    expect(
      bootCmds.some((c) => /server\/index\.ts/.test(c)),
      `Der Boot-Pfad (runButton="${runButton}") startet die App nicht ` +
        `(kein server/index.ts). Gefundene Kommandos: ${JSON.stringify(bootCmds)}.`,
    ).toBe(true);
  });
});
