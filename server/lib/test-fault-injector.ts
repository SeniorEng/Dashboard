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
