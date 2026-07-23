/**
 * Task #1842 (SSoT-AP1) — Meta-Guard für die maschinenlesbare SSoT-Registry
 * (`shared/ssot-registry.ts`).
 *
 * Die Registry ist DER Katalog „welche fachliche Frage hat welche kanonische
 * Funktion + welchen Guard?". Dieser Meta-Guard hält sie ehrlich: er erzwingt,
 * dass jeder Eintrag auf real existierenden, exportierten Code UND auf real
 * existierende Guard-Tests zeigt — und dass die Guards ihre Allowlist wirklich
 * aus der Registry beziehen (kein toter Katalog).
 *
 * STATISCH & DB-FREI: Der Test läuft im `unit`-Project (keine DB, kein
 * App-Server). Kanonische Prod-Module werden daher NICHT importiert (das würde
 * DB-Verbindungen/Seiteneffekte beim Import auslösen), sondern rein textuell auf
 * ihren Export geprüft.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SSOT_REGISTRY, getSsotEntry, ssotGuardAllowlist } from "@shared/ssot-registry";

const ROOT = process.cwd();

function readIfExists(rel: string): string | null {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf-8");
}

/**
 * Rein textueller Export-Check: matcht `export (async )?function SYM`,
 * `export const|let|var SYM` ODER einen `export { … SYM … }`-Re-Export. Bewusst
 * ohne Modul-Import (siehe Datei-Kopf: DB-frei).
 */
function fileExportsSymbol(content: string, symbol: string): boolean {
  const patterns = [
    new RegExp(String.raw`export\s+(?:async\s+)?function\s+${symbol}\b`),
    new RegExp(String.raw`export\s+(?:const|let|var)\s+${symbol}\b`),
    new RegExp(String.raw`export\s*\{[^}]*\b${symbol}\b[^}]*\}`),
  ];
  return patterns.some((re) => re.test(content));
}

describe("Meta-Guard — SSoT-Registry (Task #1842)", () => {
  it("hat Einträge und jede id ist eindeutig + hat eine nicht-leere Frage", () => {
    expect(SSOT_REGISTRY.length).toBeGreaterThan(0);
    const ids = SSOT_REGISTRY.map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, `doppelte Registry-ids: ${dupes.join(", ")}`).toEqual([]);
    for (const e of SSOT_REGISTRY) {
      expect(e.id, "id darf nicht leer sein").toMatch(/\S/);
      expect(e.question.trim(), `Eintrag "${e.id}" braucht eine nicht-leere Frage`).not.toBe("");
    }
  });

  it("jede kanonische Funktion existiert und wird von ihrem Modul exportiert (statisch)", () => {
    const problems: string[] = [];
    for (const e of SSOT_REGISTRY) {
      for (const c of e.canonical) {
        const content = readIfExists(c.module);
        if (content === null) {
          problems.push(`  ${e.id}: Modul fehlt — ${c.module}`);
          continue;
        }
        if (!fileExportsSymbol(content, c.symbol)) {
          problems.push(`  ${e.id}: ${c.module} exportiert \`${c.symbol}\` nicht`);
        }
      }
    }
    if (problems.length > 0) {
      expect.fail(
        "SSoT-Registry zeigt auf nicht (mehr) existierende kanonische Symbole:\n" +
          problems.join("\n") +
          "\n\nAktualisiere `shared/ssot-registry.ts` (symbol/module) oder stelle den Export wieder her.",
      );
    }
  });

  it("jeder Eintrag hat mindestens einen Guard und jede Guard-Test-Datei existiert", () => {
    const problems: string[] = [];
    for (const e of SSOT_REGISTRY) {
      if (e.guards.length === 0) {
        problems.push(`  ${e.id}: kein Guard`);
        continue;
      }
      for (const g of e.guards) {
        if (!existsSync(join(ROOT, g.test))) {
          problems.push(`  ${e.id}: Guard-Test fehlt — ${g.test}`);
        }
      }
    }
    if (problems.length > 0) {
      expect.fail("SSoT-Registry hat Einträge ohne (existierenden) Guard:\n" + problems.join("\n"));
    }
  });

  it("Allowlist-Invariante: `allowlistName` und `allowlist` sind gekoppelt (beide oder keine)", () => {
    for (const e of SSOT_REGISTRY) {
      for (const g of e.guards) {
        const hasName = g.allowlistName !== undefined;
        const hasList = g.allowlist !== undefined;
        expect(
          hasName,
          `${e.id}/${g.test}: \`allowlist\` gesetzt, aber \`allowlistName\` fehlt`,
        ).toBe(hasList);
      }
    }
  });

  it("jede benannte Allowlist-Konstante taucht in ihrem Guard-Test auf (kein Tippfehler/toter Verweis)", () => {
    const problems: string[] = [];
    for (const e of SSOT_REGISTRY) {
      for (const g of e.guards) {
        if (!g.allowlistName) continue;
        const content = readIfExists(g.test);
        if (content === null) continue; // Existenz separat getestet
        if (!new RegExp(String.raw`\b${g.allowlistName}\b`).test(content)) {
          problems.push(`  ${e.id}: \`${g.allowlistName}\` fehlt in ${g.test}`);
        }
      }
    }
    if (problems.length > 0) {
      expect.fail(
        "SSoT-Registry benennt Allowlists, die es im Guard-Test nicht gibt:\n" + problems.join("\n"),
      );
    }
  });

  it("mindestens zwei Guard-Tests beziehen ihre Allowlist tatsächlich aus der Registry (Beweis, kein toter Katalog)", () => {
    const guardTests = new Set<string>();
    for (const e of SSOT_REGISTRY) for (const g of e.guards) guardTests.add(g.test);

    const consumers = [...guardTests].filter((t) => {
      const content = readIfExists(t);
      return content !== null && /ssotGuardAllowlist\s*\(/.test(content);
    });

    expect(
      consumers.length,
      "erwarte >=2 Guard-Tests, die `ssotGuardAllowlist(...)` aus der Registry lesen " +
        `(gefunden: ${consumers.join(", ") || "(keine)"})`,
    ).toBeGreaterThanOrEqual(2);
  });

  describe("Accessor-Verhalten", () => {
    it("getSsotEntry liefert bekannten Eintrag und wirft bei unbekannter id", () => {
      const first = SSOT_REGISTRY[0];
      expect(getSsotEntry(first.id)).toBe(first);
      expect(() => getSsotEntry("gibt-es-nicht")).toThrow(/kein Eintrag/);
    });

    it("ssotGuardAllowlist liefert die Liste und wirft bei unbekannter Allowlist/id", () => {
      // Einen Eintrag mit benannter Allowlist finden (aus der Registry selbst).
      const withList = SSOT_REGISTRY.find((e) => e.guards.some((g) => g.allowlistName));
      expect(withList, "Registry sollte mind. eine benannte Allowlist haben").toBeTruthy();
      const guard = withList!.guards.find((g) => g.allowlistName)!;
      expect(ssotGuardAllowlist(withList!.id, guard.allowlistName!)).toEqual(guard.allowlist);

      expect(() => ssotGuardAllowlist(withList!.id, "GIBT_ES_NICHT")).toThrow(/keine Allowlist/);
      expect(() => ssotGuardAllowlist("gibt-es-nicht", "X")).toThrow(/kein Eintrag/);
    });
  });
});
