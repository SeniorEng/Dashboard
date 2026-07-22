/**
 * Task #575 — Architektur-Test: km-Mengen-Anzeigen müssen den zentralen
 * Helper aus `shared/domain/invoice-line-items.ts` nutzen.
 *
 * Hintergrund: Der Drift aus RE-2026-0003 ("Menge × Satz ≠ Summe") ist zum
 * zweiten Mal aufgetreten, weil Code unabhängig von `renderLineItemQuantity`
 * /`formatKmQuantityDisplay` km-Mengen formatiert hat — typischerweise als
 * Template-String `${value} km` mit roh aus `durationMinutes` abgeleitetem
 * Wert. Analog zu `calculations-in-shared.test.ts` zieht dieser Test eine
 * strukturelle Schranke: Sucht im Quellcode nach Patterns wie
 *   `${expr} km` / `${expr}km`
 * und erlaubt sie nur in einer expliziten Allowlist von Dateien, die
 * entweder den Helper selbst bilden, Stunden/Anfahrts-Aggregate für andere
 * Zwecke (z.B. Lexware-Export, Time-Overview, Termin-Vorschau) darstellen,
 * oder Tests sind.
 *
 * Neuer Code, der eine km-Menge auf der Rechnung / dem Leistungsnachweis /
 * im Billing-UI anzeigt, MUSS `renderLineItemQuantity` oder
 * `formatKmQuantityDisplay` aufrufen — sonst schlägt dieser Test fehl mit
 * der Liste der Treffer.
 *
 * Failure-Modus: Test listet Datei:Zeile und den gefundenen Substring und
 * erklärt, wie der Helper einzusetzen ist bzw. wann ein Allowlist-Eintrag
 * legitim ist.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = process.cwd();

/**
 * Pattern: Template-Literal-Segment, das mit einem `${...}`-Expression
 * direkt vor dem Wort `km` (optional Whitespace) endet — z.B.
 *   `${q} km`, `${formatKm(x)} km`, `${n.toFixed(1)}km`.
 * Wir matchen absichtlich NICHT statische Strings ohne Interpolation
 * (`"5 km"`), Kommentare (siehe Filter unten) oder reine Variablennamen,
 * weil die nicht den Drift-Risiko-Vektor abbilden.
 */
const KM_TEMPLATE_PATTERN = /\$\{[^}]+\}\s*km\b/;

/**
 * Pfade, in denen `${...} km`-Strings legitim sind:
 *  - Der zentrale Helper selbst (Quelle der Wahrheit).
 *  - PDF-Generator / Billing-UI rufen `renderLineItemQuantity` auf und
 *    formatieren NICHT selbst — sie sind hier nicht gelistet, weil sie
 *    auch keinen Treffer haben.
 *  - Anzeige-Aggregate, die NICHT auf einer Rechnungs-Line-Item-Menge
 *    basieren (Lexware-Aggregat, Time-Tracking-Übersicht, Termin-
 *    Vorschau, Storno-Policy-Beschreibung, Routing-Vorschau,
 *    Budget-Ledger-Transaktionsanzeige, Dokumentations-Formular).
 *  - Tests und Skripte.
 */
const ALLOWED_PATHS = [
  // Source of truth.
  "shared/domain/invoice-line-items.ts",
  // Storno-Policy-Beschreibung: Anzeige der Anfahrts-Strecke in einer
  // Policy-Begründung, nicht auf einer Rechnungs-Line.
  "shared/domain/cancellation-policy.ts",
  // Mitarbeiterabrechnung-Aggregat (Kilometer je Mitarbeiter/Monat als
  // Anzeige-Summe), bewusst NICHT die Rechnungs-Line.
  "client/src/pages/admin/mitarbeiterabrechnung.tsx",
  // Budget-Ledger-Transaktionsanzeige, zeigt eingegebene km roh —
  // keine Rechnungs-Line-Item-Menge.
  "client/src/components/budget/BudgetLedgerSection.tsx",
  // Dokumentations-/Termin-Detail-Formular (zeigt eingegebene km
  // vor dem Speichern), nicht die Rechnungs-Line.
  "client/src/pages/document-appointment.tsx",
  // Time-Tracking-Übersicht / Tages-Detail — Mitarbeiter-Aggregate,
  // nicht die Rechnungs-Line.
  "client/src/features/time-tracking/components/time-overview-summary.tsx",
  "client/src/features/time-tracking/components/day-detail-panel.tsx",
  // Fahrtdienst-Routing-Vorschau (vor dem Speichern, kein Line-Item).
  "client/src/features/appointments/components/fahrtdienst-panel.tsx",
  // Leistungsnachweis-Übersicht: zeigt die roh erfassten Leerfahrt-km eines
  // No-Shows als Aggregat-Anzeige, keine Rechnungs-Line-Item-Menge.
  "client/src/pages/service-records.tsx",
  // Tests, Skripte und Build-Artefakte.
  "tests/",
  "scripts/",
  // CLI-Skripte unter server/scripts (z.B. reconcile-km-drift) loggen km
  // roh in Konsole/Audit, keine Rechnungs-Line-Anzeige.
  "server/scripts/",
  // Startup-Audit (Drift-Detektor zwischen Termin- und Budget-km, Task
  // #616): loggt km-Werte roh ins Server-/Audit-Log für manuelle
  // Superadmin-Korrektur, kein Rechnungs-Line-Renderer.
  "server/startup/audit-appointment-budget-km-drift.ts",
  "dist/",
  "node_modules/",
];

function shouldSkip(absPath: string): boolean {
  const rel = relative(ROOT, absPath).split(sep).join("/");
  return ALLOWED_PATHS.some((p) => rel === p || rel.startsWith(p));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (
      entry.endsWith(".ts") ||
      entry.endsWith(".tsx")
    ) {
      if (entry.endsWith(".d.ts")) continue;
      yield full;
    }
  }
}

/**
 * Strippt Zeilenkommentare (`//...`), damit Beispiele in Kommentaren
 * keine falschen Treffer erzeugen.
 */
function stripLineComment(line: string): string {
  const idx = line.indexOf("//");
  if (idx === -1) return line;
  // Sehr grober Heuristik-Check: liegt das `//` in einem String? Wir
  // ignorieren das bewusst, da km-Template-Literale ohne ein vorheriges
  // `//` praktisch immer vor dem Kommentar stehen.
  return line.slice(0, idx);
}

describe("Architektur — km-Mengen-Anzeigen via zentralem Helper", () => {
  it("Keine `${...} km`-Template-Strings außerhalb der Allowlist", () => {
    const hits: Array<{ file: string; line: number; snippet: string }> = [];

    const scanRoots = ["server", "client/src", "shared"].map((p) => join(ROOT, p));
    for (const root of scanRoots) {
      try { statSync(root); } catch { continue; }
      for (const file of walk(root)) {
        if (shouldSkip(file)) continue;
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        let inBlockComment = false;
        for (let i = 0; i < lines.length; i++) {
          let line = lines[i];
          // Block-Kommentar-State grob tracken.
          if (inBlockComment) {
            const end = line.indexOf("*/");
            if (end === -1) continue;
            line = line.slice(end + 2);
            inBlockComment = false;
          }
          // Block-Kommentar-Start auf dieser Zeile?
          const blockStart = line.indexOf("/*");
          if (blockStart !== -1) {
            const blockEnd = line.indexOf("*/", blockStart + 2);
            if (blockEnd === -1) {
              line = line.slice(0, blockStart);
              inBlockComment = true;
            } else {
              line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
            }
          }
          line = stripLineComment(line);
          if (!line) continue;
          const m = line.match(KM_TEMPLATE_PATTERN);
          if (m) {
            hits.push({
              file: relative(ROOT, file).split(sep).join("/"),
              line: i + 1,
              snippet: m[0],
            });
          }
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits
        .map((h) => `  ${h.file}:${h.line} — '${h.snippet}'`)
        .join("\n");
      expect.fail(
        `Folgende km-Anzeigen umgehen den zentralen Helper aus ` +
        `'shared/domain/invoice-line-items.ts':\n` +
        `${msg}\n\n` +
        `Fix: Nutze 'renderLineItemQuantity(item)' (für persistierte ` +
        `Line-Items) oder 'formatKmQuantityDisplay(km)' (für lose ` +
        `km-Werte). Wenn der Treffer ein legitimer Sonderfall ist ` +
        `(z.B. Lexware-Aggregat, Time-Tracking-Übersicht, Routing-` +
        `Vorschau ohne Bezug zur Rechnungs-Line), ergänze die ` +
        `Allowlist 'ALLOWED_PATHS' in ` +
        `'tests/architecture/km-display-via-helper.test.ts' mit einer ` +
        `kurzen Begründung im Kommentar.`,
      );
    }
  });
});
