/**
 * Task #1792 — Der Superadmin-Rückdatierungs-Override hat eine bewusst KLEINE
 * server-seitige Angriffsfläche. Das Bypass-Flag `overrideBackdateGuard` darf im
 * Produktionscode (Scope `server` + `shared`) ausschließlich an ZWEI Orten
 * auftauchen:
 *
 *   - `server/routes/budget.ts`                       (das Request-Gate: nur
 *                                                       Superadmin, Begründung ≥ 20)
 *   - `server/storage/budget/preferences-storage.ts`  (die SSoT-Bypass-Logik +
 *                                                       revisionssicheres Audit)
 *   - `server/storage/budget-storage.ts`              (die Storage-Facade — reine
 *                                                       Typ-Durchreiche der Option
 *                                                       an die SSoT, keine Logik)
 *
 * Taucht das Flag anderswo auf, ist die GoBD-Sperre womöglich an einem dritten,
 * ungeprüften Ort aufweichbar — das ist eine Verletzung. Nicht-Request-Pfade
 * (Tests, Einmal-Skripte, Startup-Migrationen) sind wie bei den übrigen
 * Budget-Fitness-Functions vom Scope ausgenommen; der Client liegt außerhalb des
 * gescannten Server-/Shared-Baums.
 *
 * Der Detektor ist PUR und wird vom Real-Tree-Scan UND von Negativ-Tests mit
 * DERSELBEN Funktion aufgerufen.
 */
import { describe, it, expect } from "vitest";
import {
  collectScanFiles,
  stripComments,
  formatViolations,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";

const OVERRIDE_ALLOWLIST = new Set<string>([
  "server/routes/budget.ts",
  "server/storage/budget/preferences-storage.ts",
  "server/storage/budget-storage.ts",
]);

const EXCLUDED_PREFIXES = [
  "tests/",
  "server/scripts/",
  "scripts/",
  "server/startup/",
];

const OVERRIDE_FLAG_RE = /overrideBackdateGuard/;

export function detectOverrideSurfaceViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (OVERRIDE_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (OVERRIDE_FLAG_RE.test(code)) {
      out.push({
        file: rel,
        detail:
          "referenziert `overrideBackdateGuard` außerhalb von Route-Gate + SSoT-Storage — die GoBD-Rückdatierungssperre darf nur dort aufweichbar sein",
      });
    }
  }
  return out;
}

describe("Architektur — kleine Angriffsfläche des Backdate-Overrides (Task #1792)", () => {
  const scanFiles = collectScanFiles(["server", "shared"]);

  it("`overrideBackdateGuard` erscheint nur in Route-Gate + SSoT-Storage", () => {
    const v = detectOverrideSurfaceViolations(scanFiles);
    if (v.length > 0) {
      expect.fail(
        "Backdate-Override-Angriffsfläche verletzt — `overrideBackdateGuard` außerhalb der erlaubten Dateien gefunden:\n" +
          formatViolations(v) +
          "\n\nDas Bypass-Flag darf im Server-/Shared-Code nur im Request-Gate " +
          "(server/routes/budget.ts) und in der SSoT " +
          "(server/storage/budget/preferences-storage.ts) vorkommen. Ist ein " +
          "neuer, dokumentierter Sonderfall nötig, ergänze die OVERRIDE_ALLOWLIST " +
          "in tests/architecture/budget-backdate-override-surface.test.ts.",
      );
    }
  });

  it("Positiv-Nachweis: beide erlaubten Dateien referenzieren das Flag (Detektor greift dort)", () => {
    for (const rel of OVERRIDE_ALLOWLIST) {
      const f = scanFiles.find((sf) => sf.rel === rel);
      expect(f, `${rel} muss im Scan enthalten sein`).toBeTruthy();
      const v = detectOverrideSurfaceViolations([
        { rel: "server/routes/__probe__.ts", content: f!.content },
      ]);
      expect(v.length, `${rel} muss das Flag enthalten`).toBeGreaterThan(0);
    }
  });

  it("Negativ: ein bewusst eingebauter Zugriff außerhalb der Allowlist wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-override.ts",
        content:
          "export function bad(opts: { overrideBackdateGuard?: boolean }) { return opts.overrideBackdateGuard === true; }",
      },
    ];
    const v = detectOverrideSurfaceViolations(synthetic);
    expect(v.map((h) => h.file)).toEqual(["server/routes/fake-override.ts"]);
  });

  it("Negativ-Ausnahme: dasselbe Flag in einem ausgeschlossenen Pfad (Skript/Startup) ist KEINE Verletzung", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/scripts/seed-something.ts",
        content: "const x = { overrideBackdateGuard: true };",
      },
      {
        rel: "server/startup/some-migration.ts",
        content: "await save({ overrideBackdateGuard: false });",
      },
    ];
    expect(detectOverrideSurfaceViolations(synthetic)).toEqual([]);
  });

  it("Kommentar-Erwähnungen lösen keinen False-Positive aus", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/other.ts",
        content:
          "// siehe overrideBackdateGuard in budget.ts — hier NICHT verwendet\nexport const x = 1;",
      },
    ];
    expect(detectOverrideSurfaceViolations(synthetic)).toEqual([]);
  });
});
