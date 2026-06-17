/**
 * Task #1308 — Architektur-Test: kein Puppeteer-Render innerhalb einer
 * gehaltenen DB-Transaktion in den Rechnungs-Render-/Versand-Pfaden.
 *
 * Hintergrund: Task #1305 hat den Single-Invoice-Persist-Pfad
 * (`persistInvoicePdf`) in drei Phasen aufgeteilt — Plan (kurze tx1) →
 * Render+Upload (OHNE Transaktion / OHNE gepoolte DB-Verbindung) → Commit
 * (kurze tx2). Der teure, mehrsekündige Puppeteer-Render darf KEINE der 20
 * gepoolten Neon-Verbindungen über seine gesamte Laufzeit blockieren, sonst
 * hungert der Pool unter Last aus (Bulk-Druck / Stapelversand rendern viele
 * PDFs in Folge).
 *
 * Diese Fitness-Function friert die Eigenschaft für die Bulk-Print- und
 * Send-Pfade ein: In `server/routes/billing.ts` und
 * `server/services/invoice-pdf-orchestrator.ts` darf KEIN Render-Aufruf
 * (`generatePdf`, `buildInvoicePdfBytes`, `renderAndUploadInvoiceArtifacts`,
 * `renderLeistungsnachweisOnTheFly`, `loadOrRenderSendablePdfs`) lexikalisch
 * innerhalb eines `db.transaction(...)`- oder `withAudit(...)`-Callbacks
 * stehen. Die schnellen Metadaten-Lese-Transaktionen (Plan-Phase) und die
 * Commit-Transaktionen bleiben erlaubt, solange sie nicht rendern.
 *
 * Failure-Modus: Test schlägt fehl mit Datei:Zeile des Render-Aufrufs und der
 * umschließenden Transaktion, plus dem Hinweis, den Render nach dem #1305-
 * Muster aus der Transaktion herauszuziehen.
 *
 * Methodik (ast-grep statt Regex): Es werden nur echte `call_expression`-
 * Knoten betrachtet — Render-Namen in Kommentaren/Strings (z. B. diesem
 * JSDoc-Block) lösen daher KEINEN False-Positive aus.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ROOT, parseSource } from "./ast-grep-helpers";

// Dateien, die die Bulk-Print- und Send-Render-Pfade enthalten.
const TARGET_FILES = [
  "server/routes/billing.ts",
  "server/services/invoice-pdf-orchestrator.ts",
];

// Aufrufe, die einen (mehrsekündigen) Puppeteer-Render auslösen oder kapseln.
// `persistInvoicePdf` selbst ist BEWUSST nicht gelistet — es ist der sichere
// 3-Phasen-Wrapper (#1305), der intern bereits außerhalb seiner Transaktionen
// rendert und von den Routen außerhalb von Transaktionen aufgerufen wird.
const RENDER_CALLS = new Set([
  "generatePdf",
  "buildInvoicePdfBytes",
  "renderAndUploadInvoiceArtifacts",
  "renderLeistungsnachweisOnTheFly",
  "loadOrRenderSendablePdfs",
]);

// Callees, die eine gepoolte DB-Verbindung über ihren Callback-Körper halten.
function holdsConnection(calleeText: string): boolean {
  return (
    calleeText === "db.transaction" ||
    calleeText === "withAudit" ||
    calleeText.endsWith(".transaction")
  );
}

interface Violation {
  file: string;
  line: number;
  render: string;
  enclosing: string;
}

function findViolations(file: string): Violation[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const root = parseSource(source, false);
  const out: Violation[] = [];

  for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
    const fn = call.field("function");
    if (!fn) continue;
    if (!holdsConnection(fn.text())) continue;

    // Innerhalb dieses transaktions-haltenden Aufrufs nach Render-Aufrufen
    // suchen. ast-grep liefert nur echte call_expression-Knoten — Render-Namen
    // in Kommentaren/Strings im Callback werden ignoriert.
    for (const inner of call.findAll({ rule: { kind: "call_expression" } })) {
      const innerFn = inner.field("function");
      if (!innerFn) continue;
      const base = innerFn.text().split(".").pop();
      if (base && RENDER_CALLS.has(base)) {
        out.push({
          file,
          line: inner.range().start.line + 1,
          render: base,
          enclosing: fn.text(),
        });
      }
    }
  }

  return out;
}

describe("Architektur: kein Puppeteer-Render in gehaltener DB-Transaktion (Task #1308)", () => {
  it("Bulk-Print- und Send-Pfade rendern außerhalb von db.transaction/withAudit", () => {
    const violations = TARGET_FILES.flatMap(findViolations);

    const message = violations
      .map(
        (v) =>
          `  ${v.file}:${v.line} — Render-Aufruf '${v.render}(...)' steht innerhalb von '${v.enclosing}(...)'.`,
      )
      .join("\n");

    expect(
      violations,
      violations.length === 0
        ? ""
        : `Render darf KEINE gepoolte DB-Verbindung über seine Laufzeit halten ` +
            `(Pool-Starvation bei Bulk-Druck/Stapelversand, siehe Task #1305/#1308).\n` +
            `Den Render nach dem 3-Phasen-Muster aus der Transaktion ziehen ` +
            `(Plan/kurze tx → Render ohne Verbindung → Commit/kurze tx):\n${message}`,
    ).toHaveLength(0);
  });
});
