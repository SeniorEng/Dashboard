/**
 * Task #1042 — Object-Storage-Isolation pro Umgebung für Rechnungs-/
 * Leistungsnachweis-PDFs.
 *
 * Dev, Test und Produktion teilen sich denselben Object-Storage-Bucket, und
 * Rechnungsnummern (`RE-2026-00xx`) kollidieren über die Dev- und Prod-DBs
 * hinweg. Ohne Isolation überschreibt ein Dev-/Test-Lauf, der `RE-2026-0034`
 * erzeugt, das echte Produktions-PDF unter demselben Object-Key.
 *
 * Garantien dieser Suite (Done-Kriterien):
 *  1. Produktion behält den nackten Key-Space `invoices/<nummer>.pdf` /
 *     `invoices/<nummer>-leistungsnachweis.pdf` (Bestands-`pdf_path`/`pdf_hash`/
 *     ZUGFeRD bleiben byte-genau gültig).
 *  2. Nicht-Produktion schreibt unter einen getrennten Prefix
 *     `_nonprod/<NODE_ENV>/invoices/…`.
 *  3. Dieselbe Rechnungsnummer in zwei Umgebungen erzeugt zwei verschiedene
 *     Object-Keys — kein Überschreiben möglich.
 *  4. Der Schreib-Guard schlägt in Nicht-Produktion hart fehl, wenn ein
 *     Object-Key den Produktions-Prefix verwenden würde (Defense-in-Depth).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  buildInvoicePdfObjectKey,
  assertInvoicePdfWriteKeyAllowed,
  getInvoicePdfKeyPrefix,
  isProductionPdfEnv,
} from "../../server/lib/object-storage-helpers";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
}

afterEach(() => {
  setEnv(ORIGINAL_NODE_ENV);
});

describe("Invoice PDF storage isolation (Task #1042)", () => {
  it("Produktion behält den nackten invoices/<nummer>-Key-Space", () => {
    setEnv("production");
    expect(isProductionPdfEnv()).toBe(true);
    expect(getInvoicePdfKeyPrefix()).toBe("");
    expect(buildInvoicePdfObjectKey("RE-2026-0034")).toBe("invoices/RE-2026-0034.pdf");
    expect(buildInvoicePdfObjectKey("RE-2026-0034", { leistungsnachweis: true })).toBe(
      "invoices/RE-2026-0034-leistungsnachweis.pdf",
    );
  });

  it("Nicht-Produktion scoped den Key unter _nonprod/<NODE_ENV>/", () => {
    setEnv("development");
    expect(isProductionPdfEnv()).toBe(false);
    expect(getInvoicePdfKeyPrefix()).toBe("_nonprod/development");
    expect(buildInvoicePdfObjectKey("RE-2026-0034")).toBe(
      "_nonprod/development/invoices/RE-2026-0034.pdf",
    );
    expect(buildInvoicePdfObjectKey("RE-2026-0034", { leistungsnachweis: true })).toBe(
      "_nonprod/development/invoices/RE-2026-0034-leistungsnachweis.pdf",
    );
  });

  it("dieselbe Rechnungsnummer ergibt in zwei Umgebungen verschiedene Object-Keys (kein Overwrite)", () => {
    setEnv("production");
    const prodKey = buildInvoicePdfObjectKey("RE-2026-0034");
    const prodLnKey = buildInvoicePdfObjectKey("RE-2026-0034", { leistungsnachweis: true });

    setEnv("test");
    const testKey = buildInvoicePdfObjectKey("RE-2026-0034");
    const testLnKey = buildInvoicePdfObjectKey("RE-2026-0034", { leistungsnachweis: true });

    expect(testKey).not.toBe(prodKey);
    expect(testLnKey).not.toBe(prodLnKey);
    // Test-Key darf nicht im Produktions-Key-Space liegen.
    expect(testKey.startsWith("invoices/")).toBe(false);
    expect(testKey.startsWith("_nonprod/test/")).toBe(true);
  });

  it("zwei verschiedene Nicht-Produktions-Umgebungen kollidieren ebenfalls nicht", () => {
    setEnv("development");
    const devKey = buildInvoicePdfObjectKey("RE-2026-0034");
    setEnv("test");
    const testKey = buildInvoicePdfObjectKey("RE-2026-0034");
    expect(devKey).not.toBe(testKey);
  });

  it("der Schreib-Guard lässt korrekt gescopte Nicht-Produktions-Keys durch", () => {
    setEnv("development");
    const key = buildInvoicePdfObjectKey("RE-2026-0034");
    expect(() => assertInvoicePdfWriteKeyAllowed(key)).not.toThrow();
  });

  it("der Schreib-Guard verbietet Nicht-Produktions-Schreibvorgänge im Produktions-Key-Space", () => {
    setEnv("development");
    // Simuliert eine zukünftige Fehlkonfiguration, die den Prefix umgeht.
    expect(() => assertInvoicePdfWriteKeyAllowed("invoices/RE-2026-0034.pdf")).toThrow(
      /Object-Storage-Isolation/,
    );
    expect(() =>
      assertInvoicePdfWriteKeyAllowed("invoices/RE-2026-0034-leistungsnachweis.pdf"),
    ).toThrow(/Object-Storage-Isolation/);
  });

  it("der Schreib-Guard ist in Produktion ein No-op (nackter Key-Space erlaubt)", () => {
    setEnv("production");
    expect(() => assertInvoicePdfWriteKeyAllowed("invoices/RE-2026-0034.pdf")).not.toThrow();
  });
});
