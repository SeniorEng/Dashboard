/**
 * Task #1659 — Architektur-Test: `services.vatRate` (Prozent-Feld) darf NIE
 * roh mit `*`/`/` verrechnet werden. Die einzige erlaubte Roh-Zugriffsstelle
 * ist die VAT-SSoT `shared/domain/invoice-vat.ts` (`serviceVatRateBP`).
 *
 * Hintergrund (Regression `9d6f9d4`): `services.vatRate` ist als PROZENT
 * gespeichert (Schema `integer NOT NULL DEFAULT 19`, Zod `.max(100)`), der
 * Rechnungs-Erzeugungspfad rechnet USt aber in Basispunkten
 * (`round(netto × rateBP / 10000)`). Beim „thin handler"-Refactor wurde
 * `svc.vatRate` (= 19) in eine irreführend `vatBasisPoints` benannte Variable
 * gelesen und durch 10000 geteilt → 0,19 % statt 19 %. Alle Selbstzahler-
 * Rechnungen (RE-2026-0250 & Co.) trugen dadurch 100× zu wenig USt.
 *
 * Was geprüft wird (positive Hazard-Signale):
 *   A. `.vatRate` direkt gefolgt von `*` oder `/` — direkte Arithmetik auf der
 *      Rohrate (z. B. `svc.vatRate * netto / 10000`).
 *   B. `*`/`/` gefolgt von einem einfachen Operanden, der auf `.vatRate` endet.
 *   C. Eine als Basispunkte deklarierte Variable (Name enthält `Bp`/`BP`/
 *      `BasisPoints`), die DIREKT aus `X.vatRate` (Prozent) befüllt wird — die
 *      exakte Refactor-Regression, bei der die Einheiten-Konversion fehlt.
 *
 * Allowlist:
 *   - `shared/domain/invoice-vat.ts` (die VAT-SSoT/`serviceVatRateBP` selbst).
 *   - `server/lib/zugferd.ts` (`data.vatRate / 100`): operiert auf der
 *     INVOICE-Ebene, wo `vatRate` bereits in Basispunkten (1900) persistiert
 *     ist — NICHT das Service-Prozent-Feld. Der sealed E-Rechnungs-/GoBD-Pfad
 *     mit Byte-Stabilität wird bewusst nicht angefasst.
 *   - `tests/*`, `dist/`, `node_modules/`, `e2e/`.
 *   - Zeilen mit `// vat-rate-arithmetic-allowed: <reason>` (Spot-Override).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

const ALLOWED_PATHS = [
  "shared/domain/invoice-vat.ts",
  "server/lib/zugferd.ts",
  "tests/",
  "dist/",
  "node_modules/",
  "e2e/",
];

const VAT_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\.vatRate\s*[*/]/,
    reason:
      "`.vatRate` direkt mit `*`/`/` verrechnet — `services.vatRate` ist Prozent. Nutze `serviceVatRateBP()` aus `@shared/domain/invoice-vat`.",
  },
  {
    regex: /[*/]\s*[\w.]*\.vatRate\b/,
    reason:
      "Arithmetik auf `.vatRate` — nutze `serviceVatRateBP()` (Prozent → Basispunkte) aus `@shared/domain/invoice-vat`.",
  },
  {
    regex: /(?:BasisPoints?|[Bb][Pp])\b[^=\n]*=[^=\n]*\.vatRate\b/,
    reason:
      "Als Basispunkte deklarierte Variable direkt aus `.vatRate` (Prozent) befüllt — fehlende Einheiten-Konversion. Nutze `serviceVatRateBP()`.",
  },
];

function shouldSkip(absPath: string): boolean {
  const rel = relative(ROOT, absPath).split(sep).join("/");
  return ALLOWED_PATHS.some((p) => rel.startsWith(p) || rel === p);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("Architektur — keine rohe `services.vatRate`-Arithmetik außerhalb der VAT-SSoT", () => {
  it("`services.vatRate` wird nur über `serviceVatRateBP` in `shared/domain/invoice-vat.ts` verrechnet", () => {
    const hits: Array<{ file: string; line: number; snippet: string; reason: string }> = [];

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walk(root)) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/\/\/\s*vat-rate-arithmetic-allowed:/.test(line)) continue;
          if (i > 0 && /\/\/\s*vat-rate-arithmetic-allowed:/.test(lines[i - 1])) continue;
          for (const { regex, reason } of VAT_PATTERNS) {
            if (regex.test(line)) {
              hits.push({
                file: relative(ROOT, file).split(sep).join("/"),
                line: i + 1,
                snippet: line.trim().slice(0, 160),
                reason,
              });
              break;
            }
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits
        .map((h) => `  ${h.file}:${h.line}\n    ${h.reason}\n    > ${h.snippet}`)
        .join("\n");
      expect.fail(
        `Rohe \`services.vatRate\`-Arithmetik außerhalb von ` +
        `'shared/domain/invoice-vat.ts' gefunden:\n${msg}\n\n` +
        `\`services.vatRate\` ist ein PROZENT-Wert; der Rechnungs-Pfad rechnet ` +
        `in Basispunkten. Bitte \`serviceVatRateBP()\` aus ` +
        `'@shared/domain/invoice-vat' verwenden (Prozent → Basispunkte). ` +
        `Falls eine Ausnahme nötig ist (z. B. Invoice-Ebene mit bereits ` +
        `persistierten Basispunkten), die Zeile mit ` +
        `'// vat-rate-arithmetic-allowed: <Begründung>' markieren oder den ` +
        `Pfad in ALLOWED_PATHS dieses Tests eintragen.`,
      );
    }
  });
});
