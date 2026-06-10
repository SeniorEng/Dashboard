import type { Request } from "express";

const ENABLED = process.env.NODE_ENV === "test";

/**
 * Liest aus dem Request-Header `x-test-inject-fault` eine kommaseparierte
 * Liste von Fault-Namen aus, die der atomare Customer-Anlage-Pfad an
 * vordefinierten Stellen wirft. Nur in NODE_ENV=test aktiv — in allen
 * anderen Umgebungen wird der Header ignoriert und ein leeres Set
 * zurückgegeben.
 *
 * Hintergrund (Task #267): Tests laufen gegen einen separaten Server-
 * Prozess, daher kann `vi.spyOn` Storage-Methoden nicht stubbern. Statt
 * dessen instrumentieren wir den Customer-Creation-Helper an exakt den
 * Stellen, an denen ein Pflicht- oder Soft-Cascade-Schritt einsetzt.
 */
export function readTestFaults(req: Request): Set<string> {
  if (!ENABLED) return new Set();
  const header = req.headers["x-test-inject-fault"];
  if (typeof header !== "string" || header.length === 0) return new Set();
  return new Set(
    header.split(",").map(s => s.trim()).filter(Boolean),
  );
}

export function maybeFail(name: string, faults?: Set<string>): void {
  if (!ENABLED) return;
  if (!faults || !faults.has(name)) return;
  throw new Error(`Test fault injected: ${name}`);
}

/**
 * Invoice-zielgenauer Render-Fault für den Sammeldruck (`/bulk-print`). Liest
 * aus dem Header `x-test-fail-invoice-pdf` eine kommaseparierte Liste von
 * Rechnungs-IDs, deren PDF-Render gezielt fehlschlagen soll — OHNE die anderen
 * Rechnungen desselben Laufs zu beeinflussen.
 *
 * Hintergrund: Ein bloß „kaputter" `pdfPath` taugt seit dem Self-Heal-Re-Render
 * (`persistInvoicePdf` erzeugt fehlende Objekte neu) nicht mehr als Fixture für
 * eine nicht-renderbare Rechnung. Der globale `x-test-inject-fault`-Header würde
 * dagegen ALLE Rechnungen treffen. Dieser Header faultet exakt die genannten
 * IDs. Nur in NODE_ENV=test aktiv.
 */
export function readTestFailInvoicePdfIds(req: Request): Set<number> {
  if (!ENABLED) return new Set();
  const header = req.headers["x-test-fail-invoice-pdf"];
  if (typeof header !== "string" || header.length === 0) return new Set();
  return new Set(
    header
      .split(",")
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n)),
  );
}
