/**
 * Task #716 — Architektur-Test: Der Backfill-Sentinel `"1970-01-01"` darf
 * NUR in `shared/domain/budget-settings-sentinel.ts` als String-Literal
 * stehen. Alle anderen Stellen (Backend-Routen, Storage, Startup-Migrationen,
 * Frontend) MÜSSEN `SETTINGS_VALID_FROM_EPOCH` aus dem Shared-Modul
 * importieren — sonst drifted die UI-Maskierung (Frontend zeigt „01.01.1970"
 * an, weil ein neuer Caller das Literal nicht maskiert).
 *
 * Whitelist:
 * - `shared/domain/budget-settings-sentinel.ts` (Quelle)
 * - Startup-Migrationen, die historische Zeilen MIT dem Sentinel-Wert
 *   befüllen — sie kommen ohne TS-Konstante aus, weil sie SQL emittieren.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

const WHITELIST: ReadonlyArray<string> = [
  // SSoT
  "shared/domain/budget-settings-sentinel.ts",
  // Startup-Migration befüllt historische Zeilen mit diesem Wert per Roh-
  // SQL; die Konstante hier zu importieren würde nichts gewinnen, weil das
  // SQL-Template das Literal ohnehin wieder als String enthalten muss.
  "server/startup/backfill-budget-historization.ts",
  // Termin-Policy verwendet "1970-01-01" als unabhängigen Stub-Wert für
  // einen Datums-Check, der gar nicht ausgewertet wird. Kein Bezug zum
  // Budget-Sentinel.
  "server/routes/appointments.ts",
];

const SCAN_ROOTS: ReadonlyArray<string> = ["client/src", "server", "shared"];
const EXTS = new Set([".ts", ".tsx"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (EXTS.has(full.slice(full.lastIndexOf(".")))) {
      out.push(full);
    }
  }
}

describe("Budget-Sentinel-Eindeutigkeit (Task #716)", () => {
  it("\"1970-01-01\" steht nur in shared/domain/budget-settings-sentinel.ts (oder Whitelist)", () => {
    const files: string[] = [];
    for (const r of SCAN_ROOTS) walk(join(ROOT, r), files);

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (WHITELIST.includes(rel)) continue;
      // Tests dürfen den Wert aus Inspektionsgründen erwähnen.
      if (rel.startsWith("tests/")) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("1970-01-01")) continue;
        const trimmed = lines[i].trim();
        // Kommentar-Erwähnungen (Doku, JSDoc, Inline-Kommentar) sind kein
        // Drift-Risiko — sie kompilieren nicht in Laufzeit-Verhalten.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        offenders.push({ file: rel, line: i + 1, text: trimmed });
      }
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map(o => `  ${o.file}:${o.line} → ${o.text}`)
        .join("\n");
      throw new Error(
        `Free-standing \"1970-01-01\" outside sentinel module:\n${msg}\n` +
        `→ Bitte SETTINGS_VALID_FROM_EPOCH aus @shared/domain/budget-settings-sentinel importieren.`,
      );
    }
    expect(offenders.length).toBe(0);
  });
});
