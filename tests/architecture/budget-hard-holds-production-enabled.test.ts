/**
 * Task #953 — Regressionsschutz: Budget-Hard-Block MUSS in Produktion scharf sein.
 *
 * Der Overdraft-Hard-Block (422 BUDGET_HARD_BLOCK beim Anlegen eines Termins,
 * der einen nicht-privat-zahlenden Kunden über sein Budget zieht) ist hinter dem
 * Feature-Flag `BUDGET_HARD_HOLDS` gegated (`hardHoldsEnabled()` in
 * `server/storage/budget/reservation-storage.ts`: an = "1"/"true").
 *
 * In Produktion MUSS das Flag aktiv sein. Es wird über die Replit-Env-Scopes
 * in `.replit` gesetzt — entweder produktions-spezifisch (`[userenv.production]`)
 * oder shared (`[userenv.shared]`, gilt dann auch dev). Verschwindet die Zeile
 * (z.B. bei einem unbedachten Edit der Env-Konfiguration), liefe der Server in
 * Produktion still im Legacy-Modus OHNE Überziehungsschutz weiter — eine
 * lautlose Regression. Dieser Test verriegelt das: er liest `.replit` und
 * besteht nur, wenn ein produktions-erreichbarer Scope das Flag auf "1"/"true"
 * setzt.
 *
 * Reiner Datei-Read, kein Server/DB — läuft im `unit`-Project.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const TRUTHY = new Set(["1", "true"]);

/**
 * Extrahiert den Wert von `key` aus genau einem `[userenv.<scope>]`-Block der
 * `.replit`-TOML (ohne TOML-Parser-Dependency: zeilenbasiert, da die Datei
 * flach ist). Gibt `null` zurück, wenn Scope oder Key fehlen.
 */
function readUserenvValue(toml: string, scope: string, key: string): string | null {
  const lines = toml.split(/\r?\n/);
  const header = `[userenv.${scope}]`;
  let inScope = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inScope = line === header;
      continue;
    }
    if (!inScope) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && m[1] === key) return m[2];
  }
  return null;
}

describe("Architektur: Budget-Hard-Block ist in Produktion scharf (Task #953)", () => {
  const toml = readFileSync(join(process.cwd(), ".replit"), "utf8");

  it("setzt BUDGET_HARD_HOLDS in einem produktions-erreichbaren Scope auf '1'/'true'", () => {
    const production = readUserenvValue(toml, "production", "BUDGET_HARD_HOLDS");
    const shared = readUserenvValue(toml, "shared", "BUDGET_HARD_HOLDS");

    const enabledInProd =
      (production !== null && TRUTHY.has(production)) ||
      (shared !== null && TRUTHY.has(shared));

    expect(
      enabledInProd,
      "BUDGET_HARD_HOLDS ist in `.replit` für Produktion NICHT aktiv. " +
        `Gefunden: [userenv.production]=${JSON.stringify(production)}, ` +
        `[userenv.shared]=${JSON.stringify(shared)}. ` +
        "Der Overdraft-Hard-Block würde in Produktion still im Legacy-Modus laufen. " +
        "Setze BUDGET_HARD_HOLDS='1' im production- (oder shared-) Env-Scope.",
    ).toBe(true);
  });
});
