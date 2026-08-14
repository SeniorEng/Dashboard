// ---------------------------------------------------------------------------
// Guard-Test für scripts/prune-git-object-bloat.sh (Task #1904)
//
// Das Skript räumt aufgeblähte `.git`-Verzeichnisse auf und LÖSCHT dabei Refs.
// Es läuft best-effort und unbeaufsichtigt aus `scripts/post-merge.sh`. Eine
// Regression an seiner Kandidaten-Auswahl wäre also still und teuer: entweder
// verschwindet Arbeit, die nirgends sonst existiert, oder der ausgecheckte
// Branch wird unter der laufenden Arbeitskopie weggezogen und HEAD zeigt ins
// Leere.
//
// Der Test spannt dafür ein WEGWERF-Repository in einem Temp-Verzeichnis auf
// (niemals das Repo dieses Workspaces!) und prüft die drei Zusagen des Skripts:
//   1. Ein ausgecheckter `subrepl-*`-Branch wird NIE angefasst — auch wenn seine
//      Spitze uralt ist. Gilt für HEAD und für verlinkte Worktrees.
//   2. Ein alter, nachweislich integrierter Branch (Baum liegt in der Historie
//      eines erhaltenen Refs) wird gelöscht.
//   3. Ein alter, NICHT nachweisbar integrierter Branch wird nicht gelöscht,
//      sondern nach `refs/subrepl-graveyard/*` gerettet und bleibt von dort mit
//      einem Einzeiler wiederherstellbar.
// Zusätzlich: erhaltene Branches (`main`) bleiben unberührt.
//
// DB-frei und server-frei → `unit`-Project, läuft in jedem CI-Fork.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(process.cwd(), "scripts/prune-git-object-bloat.sh");
const OLD_DATE = "2024-01-15T10:00:00+00:00"; // weit jenseits von PRUNE_AGE_DAYS

let repo: string;
let worktreeDir: string;

function git(args: string[], cwd = repo, env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

/** Backdatierter Commit über Plumbing — ohne die Arbeitskopie anzufassen. */
function backdatedCommit(
  fileName: string,
  content: string,
  parent: string | null,
): string {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: content,
    encoding: "utf8",
  }).trim();
  const tree = execFileSync("git", ["mktree"], {
    cwd: repo,
    input: `100644 blob ${blob}\t${fileName}\n`,
    encoding: "utf8",
  }).trim();
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-m", "Saved your changes before starting work");
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: OLD_DATE,
      GIT_COMMITTER_DATE: OLD_DATE,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

function refExists(ref: string, cwd = repo): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

describe("prune-git-object-bloat.sh (Wegwerf-Repository)", () => {
  let integratedTip = "";
  let unverifiedTip = "";
  let checkedOutTip = "";
  let worktreeTip = "";

  beforeAll(() => {
    const base = mkdtempSync(path.join(tmpdir(), "git-bloat-guard-"));
    repo = path.join(base, "repo");
    worktreeDir = path.join(base, "linked-worktree");
    mkdirSync(repo, { recursive: true });

    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.invalid"]);
    git(["config", "user.name", "T"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(repo, "keep.txt"), "kept content\n");
    git(["add", "keep.txt"]);
    git(["commit", "-q", "-m", "base"], repo, {
      GIT_AUTHOR_DATE: OLD_DATE,
      GIT_COMMITTER_DATE: OLD_DATE,
    });
    const mainTip = git(["rev-parse", "main"]);

    // (a) alt + nachweislich integriert: zeigt direkt auf einen main-Commit
    integratedTip = mainTip;
    git(["branch", "subrepl-old-integrated", integratedTip]);

    // (b) alt + NICHT nachweisbar integriert: eigener, einzigartiger Baum
    unverifiedTip = backdatedCommit("unique-a.txt", "only here A\n", mainTip);
    git(["update-ref", "refs/heads/subrepl-old-unverified", unverifiedTip]);

    // (c) alt + ausgecheckt (HEAD dieses Verzeichnisses)
    checkedOutTip = backdatedCommit("unique-b.txt", "only here B\n", mainTip);
    git(["update-ref", "refs/heads/subrepl-old-checkedout", checkedOutTip]);

    // (d) alt + in einem VERLINKTEN Worktree ausgecheckt
    worktreeTip = backdatedCommit("unique-c.txt", "only here C\n", mainTip);
    git(["update-ref", "refs/heads/subrepl-old-worktree", worktreeTip]);
    git(["worktree", "add", "-q", worktreeDir, "subrepl-old-worktree"]);

    git(["checkout", "-q", "subrepl-old-checkedout"]);

    execFileSync("bash", [SCRIPT, "--apply"], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000,
    });
  }, 180_000);

  afterAll(() => {
    if (repo) rmSync(path.dirname(repo), { recursive: true, force: true });
  });

  it("lässt den ausgecheckten subrepl-Branch trotz uralter Spitze unangetastet", () => {
    expect(refExists("refs/heads/subrepl-old-checkedout")).toBe(true);
    expect(git(["symbolic-ref", "HEAD"])).toBe("refs/heads/subrepl-old-checkedout");
    expect(git(["rev-parse", "HEAD"])).toBe(checkedOutTip);
    // und wandert auch nicht heimlich auf den Friedhof
    expect(refExists("refs/subrepl-graveyard/subrepl-old-checkedout")).toBe(false);
  });

  it("lässt einen in einem verlinkten Worktree ausgecheckten subrepl-Branch unangetastet", () => {
    expect(refExists("refs/heads/subrepl-old-worktree")).toBe(true);
    expect(git(["rev-parse", "subrepl-old-worktree"])).toBe(worktreeTip);
    expect(refExists("refs/subrepl-graveyard/subrepl-old-worktree")).toBe(false);
  });

  it("löscht einen alten, nachweislich integrierten subrepl-Branch", () => {
    expect(refExists("refs/heads/subrepl-old-integrated")).toBe(false);
    // integriert = Inhalt liegt schon in main ⇒ kein Friedhof-Eintrag nötig
    expect(refExists("refs/subrepl-graveyard/subrepl-old-integrated")).toBe(false);
    expect(git(["rev-parse", "main"])).toBe(integratedTip);
  });

  it("rettet einen alten, nicht nachweisbar integrierten Branch auf den Friedhof statt ihn zu löschen", () => {
    expect(refExists("refs/heads/subrepl-old-unverified")).toBe(false);
    expect(refExists("refs/subrepl-graveyard/subrepl-old-unverified")).toBe(true);
    expect(git(["rev-parse", "refs/subrepl-graveyard/subrepl-old-unverified"])).toBe(
      unverifiedTip,
    );
    // Wiederherstellung ist ein Einzeiler und liefert den Commit unverändert zurück
    git(["branch", "restored", "refs/subrepl-graveyard/subrepl-old-unverified"]);
    expect(git(["rev-parse", "restored"])).toBe(unverifiedTip);
  });

  it("fasst erhaltene Branches nicht an und lässt das Repository konsistent zurück", () => {
    expect(refExists("refs/heads/main")).toBe(true);
    expect(() =>
      execFileSync("git", ["fsck", "--no-progress", "--connectivity-only"], {
        cwd: repo,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
