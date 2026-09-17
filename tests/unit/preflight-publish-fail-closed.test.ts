/**
 * Die Publish-Checkliste darf „nicht geprüft" NIE als „nichts gefunden" ausgeben.
 *
 * ── Der Vorfall, der diesen Wächter erzeugt hat (17.09.2026) ─────────────
 * Vor dem ersten Lauf des Deploy-Gates lief `script/preflight-publish.mjs` und
 * meldete:
 *
 *     [ ✓ ] Keine destruktiven Schema-Änderungen erkannt
 *             … Replica-Diff übersprungen (PROD_DATABASE_URL nicht gesetzt)
 *     [ ✓ ] Pre-Publish-Backup nicht zwingend nötig (keine DROP-Statements)
 *
 * Beide Häkchen ruhten auf NULL Evidenz:
 *   - Der Replica-Diff — die einzige Prüfung, die Dev gegen Prod stellt — war
 *     übersprungen. `available:false` lieferte eine leere Drop-Liste, und eine
 *     leere Liste las sich wie „nichts gefunden".
 *   - Der Migrations-Grep ist bei `drizzle-kit push` PER KONSTRUKTION blind
 *     (push schreibt keine Migrationsdateien, CLAUDE.md). Er konnte gar nichts
 *     finden.
 *
 * Und daraus wurde die Empfehlung, das Backup wegzulassen — vor einem Publish
 * mit 29 Tagen ungemessenem Schema-Delta.
 *
 * Das ist exakt die Mechanik des 10.08.2026-Incidents (fail-open
 * `ensureQontoAdviceMatchSchema`, Container bootete grün, `invoices.issued_at`
 * fehlte trotzdem). **Eine übersprungene Prüfung, die als bestanden ausgewiesen
 * wird, ist gefährlicher als eine, die rot wird.**
 *
 * ── Warum als Subprozess ────────────────────────────────────────────────
 * `preflight-publish.mjs` ist ein Skript mit Top-Level-await, das beim Import
 * läuft und `process.exitCode` setzt. Es lässt sich nicht als Modul einzeln
 * befragen — geprüft wird deshalb, was der Operator tatsächlich sieht.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const REPO = path.resolve(__dirname, "../..");

/**
 * Fährt die Checkliste OHNE `PROD_DATABASE_URL` — der Zustand, in dem der
 * Replica-Diff nicht laufen kann.
 */
async function preflightOhneProd(): Promise<{ code: number; out: string }> {
  const env = { ...process.env };
  delete env.PROD_DATABASE_URL;
  try {
    const { stdout, stderr } = await run("node", ["script/preflight-publish.mjs"], {
      cwd: REPO,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("Publish-Checkliste — fail-closed ohne Prod-Diff", () => {
  it("PF-1 – meldet NICHT „keine destruktiven Änderungen“, wenn nicht nachgesehen wurde", async () => {
    const { out } = await preflightOhneProd();

    // Die Zeile darf es geben — aber nicht als bestandenen Punkt. Geprüft wird
    // deshalb das Häkchen davor, nicht der Text allein.
    const gruenOhneEvidenz = out
      .split("\n")
      .some((z) => z.includes("[ ✓ ]") && z.includes("Keine destruktiven Schema-Änderungen"));

    expect(
      gruenOhneEvidenz,
      "übersprungener Replica-Diff wurde als bestandene Prüfung ausgewiesen",
    ).toBe(false);
  });

  it("PF-2 – empfiehlt NICHT, das Backup wegzulassen", async () => {
    // Der teuerste Satz: die Aussage, die das Backup entbehrlich machen würde,
    // ist genau die ungeprüfte.
    const { out } = await preflightOhneProd();
    const gruenesBackupOptional = out
      .split("\n")
      .some((z) => z.includes("[ ✓ ]") && z.includes("Backup nicht zwingend nötig"));

    expect(
      gruenesBackupOptional,
      "Backup als entbehrlich ausgewiesen, ohne den Schema-Diff gemessen zu haben",
    ).toBe(false);
  });

  it("PF-3 – benennt den Grund und endet mit Exit != 0", async () => {
    const { code, out } = await preflightOhneProd();

    // Ein Mensch muss ohne Rückfrage wissen, WAS fehlt und WAS zu tun ist.
    expect(out).toMatch(/PROD_DATABASE_URL/);
    expect(out).toMatch(/NICHT bereit für Publish/);
    // Und ein Skript/CI muss es am Exit-Code merken, nicht am Text.
    expect(code, "fail-closed heisst auch: Exit != 0").not.toBe(0);
  });

  it("PF-4 – sagt dazu, dass der Migrations-Grep allein nichts beweist", async () => {
    // Ohne diesen Satz liest jemand „jüngste Migration: …" als Entwarnung.
    // Seit dem Cutover läuft der Schema-Pfad über `drizzle-kit push`, und der
    // schreibt keine Migrationsdateien.
    const { out } = await preflightOhneProd();
    expect(out).toMatch(/push/);
    expect(out).toMatch(/blind|beweist nichts/);
  });
});
