/**
 * Der Freigabe-Check (Ticket 6hcgffPJWm57p72p) steht zweimal: als Datei
 * `scripts/sql/ust-freigabe-check.sql` — die führt der Abnahmetest aus — und
 * als einzeiliger Befehl im Runbook, den Alrik kopiert (Vorgabe: EINZEILIG,
 * `psql -c`, keine Heredocs). Dieser Wächter hält beide gleich: sonst prüfte
 * der Test einen anderen Check als den, der vor dem Abrechnungslauf läuft.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");

/** Die SQL aus dem `psql … -c "…"`-Befehl des Runbooks. */
function sqlAusRunbook(md: string): string | null {
  const zeile = md.split("\n").find((l) => l.includes('psql "$PROD_DATABASE_URL"') && l.includes(' -c "'));
  if (!zeile) return null;
  const start = zeile.indexOf(' -c "') + 5;
  return zeile.slice(start, zeile.lastIndexOf('"'));
}

describe("Freigabe-Check: Runbook = SQL-Datei", () => {
  it("der Runbook-Befehl enthält wörtlich die SQL der Datei", () => {
    const datei = readFileSync(resolve(root, "scripts/sql/ust-freigabe-check.sql"), "utf8").trim();
    const runbook = readFileSync(resolve(root, "docs/ust-4-16g-golive-runbook.md"), "utf8");
    expect(datei.includes("\n"), "die SQL-Datei ist einzeilig").toBe(false);
    expect(sqlAusRunbook(runbook)).toBe(datei);
  });

  it("Selbstprobe: eine abweichende Runbook-Zeile wird erkannt", () => {
    const datei = readFileSync(resolve(root, "scripts/sql/ust-freigabe-check.sql"), "utf8").trim();
    const verfaelscht = `x\nPGOPTIONS='-c default_transaction_read_only=on' psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "${datei.replace("entfernt_am IS NULL", "true")}"\n`;
    expect(sqlAusRunbook(verfaelscht)).not.toBe(datei);
    expect(sqlAusRunbook("kein Befehl")).toBeNull();
  });
});
