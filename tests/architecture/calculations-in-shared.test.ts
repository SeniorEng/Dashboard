/**
 * Task #427 — Architektur-Test: zentrale Berechnungen leben in `shared/domain/`.
 *
 * Hintergrund: Drift zwischen Anzeige und Buchung entsteht typischerweise,
 * wenn dieselbe Berechnung an zwei Orten parallel implementiert wird. Diese
 * Konvention zwingt uns, neue Cap-/Pricing-/Pro-Rata-/Cutoff-Funktionen in
 * `shared/domain/` (oder `shared/utils/`) zu verankern, damit Read- und
 * Write-Pfad denselben Code aufrufen.
 *
 * Was geprüft wird: Es darf keine NEUEN Funktionen mit Namen
 * `calculate*`/`compute*` für die unten gelisteten Hotspot-Kategorien
 * außerhalb von `shared/domain/`, `shared/utils/` oder einer expliziten
 * Allowlist (siehe `ALLOWED_PATHS`) entstehen. Bestehende
 * `server/storage/...`-Wrapper, die ausschließlich `shared/domain/` aufrufen,
 * sind in der Allowlist enthalten.
 *
 * Failure-Modus: Test schlägt fehl mit der Liste der Treffer und einer
 * Erklärung, wie man die Berechnung nach `shared/domain/` zieht.
 *
 * Task #776 — Die Hotspot-Erkennung (zweiter `it`) wurde von einer
 * zeilenweisen Regex (`extractDeclaredName`) auf `ast-grep` umgestellt. Die
 * Regex hat Funktionsnamen auch in Kommentaren/Strings sowie in reinen
 * Wert-Variablen (`const x = computeCap(...)`) getroffen und mehrzeilige
 * Deklarationen verfehlt. `ast-grep` matcht nur echte Funktions-Knoten im
 * AST. Der km-Rundungs-Test bleibt vorerst regex-basiert (Ausdrucks-Muster,
 * nicht Deklarations-Muster).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import {
  ROOT,
  walkTsFiles,
  parseSource,
  collectNamedFunctions,
} from "./ast-grep-helpers";

// Hotspot-Schlüsselwörter: wenn der DEKLARIERTE Funktionsname auf eines
// dieser Muster passt, MUSS er in shared/domain/ wohnen (oder explizit in
// der Allowlist stehen). Das `NAME`-Capture wird vom Declaration-Matcher
// unten eingesetzt.
const HOTSPOT_NAME_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /^calculate(Cap|MonthlyLimit|.*45b|.*45a)/i, reason: "Cap-Mathe" },
  { regex: /^compute(Cap|MonthlyLimit|.*45b)/i, reason: "Cap-Mathe" },
  { regex: /^calculate(Pflegegrad|.*Price)/i, reason: "Pflegegrad-Preise" },
  { regex: /^calculate(ProRata|.*Vacation|.*Entitlement)/i, reason: "Pro-Rata-Urlaub" },
  { regex: /^calculate(.*Travel|.*Reisekost)/i, reason: "Reisekosten" },
  { regex: /^compute(.*Cutoff|.*MonthClose)/i, reason: "Monatsabschluss-Cutoff" },
];

// Pfade, die explizit erlaubt sind, weil sie reine Wrapper/Storage-Layer um
// shared/domain/ sind oder die kanonische Implementation bilden.
const ALLOWED_PATHS = [
  "shared/domain/",
  "shared/utils/",
  // Storage-Wrapper, die nur calculate*-Funktionen aus shared/domain/ aufrufen
  // bzw. die DB-Side-Effekte durchführen, die nicht reine Mathematik sind.
  // Wenn diese Wrapper neue Mathematik einführen, muss sie nach shared/domain/.
  "server/storage/budget/cap-calculator.ts",
  "server/storage/budget/appointment-cost-calculator.ts",
  "server/storage/time-tracking/vacation.ts",
  "server/services/month-close-scheduler.ts",
  // Bekannte Baseline-Treffer (Stand Task #427): bereits existierende
  // Funktionen, die historisch außerhalb von shared/domain/ leben. Vor
  // weiteren Refactors hier eintragen, NIEMALS einfach erweitern, ohne den
  // Hotspot zu prüfen — der Sinn der Architektur-Schranke wäre sonst hinüber.
  "server/services/travel-time.ts",
  "server/storage/budget/allocation-storage.ts",
  // Tests dürfen Referenzen auf hotspot-Berechnungen haben.
  "tests/",
  // Build/Skript-Artefakte.
  "dist/",
  "node_modules/",
];

function shouldSkip(absPath: string): boolean {
  const rel = relative(ROOT, absPath).split(sep).join("/");
  return ALLOWED_PATHS.some((p) => rel.startsWith(p));
}

describe("Architektur — zentrale Berechnungen in shared/domain/", () => {
  /**
   * Task #616 — verbietet zusätzlich `km.toFixed(...)` und das Muster
   * `Math.round(<...km...> * <...rate...>)` außerhalb der km-Domain
   * (`shared/domain/invoice-line-items.ts`). Vor #616 lebten zwei dieser
   * Rundungen parallel im Budget-Ledger (1 NK) und im Rechnungs-Render
   * (2 NK) — exakt der Anzeige-≠-Buchung-Drift aus dem Screenshot-Fall.
   * Alles, was km bezogen runden/formatieren will, MUSS die Helper aus
   * `shared/domain/invoice-line-items.ts` aufrufen.
   */
  it("Keine km-Rundung/-Formatierung (`toFixed`, `Math.round(km*rate)`) außerhalb shared/domain/invoice-line-items.ts (Task #616)", () => {
    const allowedFile = "shared/domain/invoice-line-items.ts";
    const hits: Array<{ file: string; line: number; snippet: string }> = [];

    const tofixedRe = /\b(km|kilometer|kilometers|kilometre|travel(?:Kilometers)?|customerKilometers)\b[^\n;]{0,40}\.toFixed\s*\(/i;
    const mathRoundKmRateRe = /Math\.round\s*\(\s*[^)]*\b(?:km|kilometer|kilometers|travel(?:Kilometers)?|customerKilometers)\b[^)]*\b(?:rate|cents)\b[^)]*\)/i;

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walkTsFiles(root)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (rel === allowedFile) continue;
        if (rel.startsWith("tests/")) continue;
        // One-off Wartungs-Skripte (Reconcile/Backfill) sind keine Hot-Loop-
        // Berechnungspfade — die laufen nicht im normalen Request-Flow.
        if (rel.startsWith("server/scripts/")) continue;
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (tofixedRe.test(line) || mathRoundKmRateRe.test(line)) {
            hits.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 140) });
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits.map((h) => `  ${h.file}:${h.line} — ${h.snippet}`).join("\n");
      expect.fail(
        `Folgende km-Rundungen/-Formatierungen liegen außerhalb von '${allowedFile}':\n` +
        `${msg}\n\n` +
        `Verwende stattdessen die Helper aus 'shared/domain/invoice-line-items.ts' ` +
        `(\`quantizeKm\`, \`computeKmLineTotalCents\`, \`formatKmQuantityDisplay\`).`,
      );
    }
  });

  /**
   * Task #1514 — verbietet hartcodierte Preis-/Lohn-/km-Satz-Magic-Numbers
   * außerhalb der Katalog-SSoT. Hintergrund: Der „Wirtschaftlicher Überblick"
   * zeigte Raten (38,00 € / 16,00 € / 0,35 €), und ein App-weiter Audit musste
   * sicherstellen, dass JEDE angezeigte/berechnete Rate ausschließlich aus den
   * SSoT-Resolvern (`priceFor`/`wageFor`) bzw. der Katalog-/Preis-/Lohn-Tabelle
   * stammt — NIE aus einer hartcodierten Zahl oder einem Dummy-Fallback.
   *
   * Geprüft werden die distinktiven Katalog-Cent-Werte (3800/1600/4200/1800)
   * sowie km-Satz-Fallbacks/-Zuweisungen (35/30 ct bzw. 0,35/0,30 €), jeweils
   * NUR wenn die Zeile zusätzlich ein Geld-/Raten-Stichwort
   * (cents/rate/preis/price/lohn/wage/satz/km/kilometer) enthält — das hält
   * Fehlalarme (Urlaubstage `?? 30`, Margin-Farben `>= 30`, Timeouts `1800`)
   * heraus. Vergleichsoperatoren (`>=`/`<=`/`==`) werden bewusst ausgenommen.
   *
   * Legitime Heimat der Rate-Literale ist die Katalog-SSoT
   * (`shared/config/services.ts`) und das einmalige Recovery-Skript
   * (`recover-prices-from-backup.ts`, Soll-Wert-Assertions). Gesetzliche
   * Konstanten (§45b 131 €, §39/§42a) und MwSt-Sätze haben andere Werte und
   * sind nicht betroffen. Für seltene, begründete Ausnahmen gibt es den
   * Inline-Escape `// rate-literal-allowed: <Grund>`.
   */
  it("Keine hartcodierten Preis-/Lohn-/km-Satz-Magic-Numbers außerhalb der Katalog-SSoT (Task #1514)", () => {
    // Pfade, in denen Rate-Literale legitim leben.
    const RATE_LITERAL_ALLOWED_PATHS = [
      "shared/config/services.ts", // die Katalog-SSoT selbst
      "server/startup/recover-prices-from-backup.ts", // einmaliges Recovery (Soll-Wert-Asserts)
      "server/scripts/", // einmalige Wartungs-/Reconcile-Skripte (kein Request-Flow)
      "tests/",
      "dist/",
      "node_modules/",
    ];

    // Distinktive Katalog-Cent-Werte (HW 3800/1600, AB 4200/1800).
    const distinctiveCentsRe = /\b(3800|1600|4200|1800)\b/;
    // km-Satz als Fallback (`?? 35`) oder Zuweisung (`= 35`, `: 30`), inkl.
    // Euro-Schreibweise (0,35/0,30). Vergleichsoperatoren ausgenommen.
    const kmRateRe = /(?:\?\?|\|\||(?<![<>=!])[:=])\s*(?:0\.3[05]|3[05])\b/;
    // Geld-/Raten-Kontext auf der Zeile (gate gegen Fehlalarme).
    const moneyKeywordRe = /\b(cents?|rate|preis|price|lohn|wage|satz|kilometer|km)/i;

    const hits: Array<{ file: string; line: number; snippet: string }> = [];
    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walkTsFiles(root)) {
        const rel = relative(ROOT, file).split(sep).join("/");
        if (RATE_LITERAL_ALLOWED_PATHS.some((p) => rel.startsWith(p))) continue;
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Inline-Escape für begründete Ausnahmen.
          if (/rate-literal-allowed:/.test(line)) continue;
          const trimmed = line.trim();
          // Reine Kommentar-/Doc-Zeilen ignorieren.
          if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
          // Trailing-Zeilenkommentar abschneiden (Werte in Kommentaren zählen nicht).
          const code = line.split("//")[0];
          if (!moneyKeywordRe.test(code)) continue;
          if (distinctiveCentsRe.test(code) || kmRateRe.test(code)) {
            hits.push({ file: rel, line: i + 1, snippet: trimmed.slice(0, 140) });
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits.map((h) => `  ${h.file}:${h.line} — ${h.snippet}`).join("\n");
      expect.fail(
        `Folgende Stellen enthalten hartcodierte Preis-/Lohn-/km-Satz-Werte ` +
        `außerhalb der Katalog-SSoT:\n${msg}\n\n` +
        `Raten MÜSSEN aus den SSoT-Resolvern (\`priceFor\`/\`wageFor\`) bzw. der ` +
        `Katalog-/Preis-/Lohn-Tabelle (\`shared/config/services.ts\`, \`prices\`, ` +
        `\`role_wage_rates\`) stammen — nie aus einer hartcodierten Zahl/einem ` +
        `Dummy-Fallback. Für eine begründete Ausnahme: \`// rate-literal-allowed: <Grund>\`.`,
      );
    }
  });

  it("Keine neuen Hotspot-`calculate*`/`compute*`-Funktionen außerhalb der Allowlist", () => {
    const hits: Array<{ file: string; line: number; match: string; reason: string }> = [];

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walkTsFiles(root)) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        // ast-grep statt zeilenweiser Regex: Es werden nur echte benannte
        // Funktions-Definitionen aus dem AST gezogen — Vorkommen in
        // Kommentaren/Strings sowie reine Wert-Variablen
        // (`const x = computeCap(...)`) sind eigene Knoten und werden NICHT
        // mitgezählt (Task #776).
        const astRoot = parseSource(content, file.endsWith(".tsx"));
        for (const { name, line } of collectNamedFunctions(astRoot)) {
          for (const { regex, reason } of HOTSPOT_NAME_PATTERNS) {
            if (regex.test(name)) {
              hits.push({
                file: relative(ROOT, file).split(sep).join("/"),
                line,
                match: name,
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
        .map((h) => `  ${h.file}:${h.line} — '${h.match}' (${h.reason})`)
        .join("\n");
      expect.fail(
        `Folgende Hotspot-Berechnungen liegen außerhalb von 'shared/domain/' bzw. der Allowlist:\n` +
        `${msg}\n\n` +
        `Verschiebe die Berechnungslogik nach 'shared/domain/' (oder ergänze die ` +
        `Allowlist in 'tests/architecture/calculations-in-shared.test.ts', wenn der ` +
        `Treffer ein reiner Wrapper ist).`,
      );
    }
  });
});
