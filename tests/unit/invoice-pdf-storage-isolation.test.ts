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
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  buildInvoicePdfObjectKey,
  assertInvoicePdfWriteKeyAllowed,
  getInvoicePdfKeyPrefix,
  isProductionPdfEnv,
} from "../../server/lib/object-storage-helpers";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_RUN_ID = process.env.EPHEMERAL_RUN_ID;
const ORIGINAL_WORKER_ID = process.env.EPHEMERAL_WORKER_ID;

function setEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
}

function setRunId(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.EPHEMERAL_RUN_ID;
  } else {
    process.env.EPHEMERAL_RUN_ID = value;
  }
}

function setWorkerId(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.EPHEMERAL_WORKER_ID;
  } else {
    process.env.EPHEMERAL_WORKER_ID = value;
  }
}

// Diese Suite läuft selbst unter dem Ephemeral-Orchestrator, der
// `EPHEMERAL_RUN_ID` UND `EPHEMERAL_WORKER_ID` setzt (Task #1051/#1263). Für die
// umgebungs-genauen Prefix-Assertions Run- und Worker-ID standardmäßig
// entfernen; die Scoping-Tests setzen sie explizit.
beforeEach(() => {
  setRunId(undefined);
  setWorkerId(undefined);
});

afterEach(() => {
  setEnv(ORIGINAL_NODE_ENV);
  setRunId(ORIGINAL_RUN_ID);
  setWorkerId(ORIGINAL_WORKER_ID);
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

describe("Invoice PDF storage per-run isolation (Task #1051)", () => {
  it("EPHEMERAL_RUN_ID scoped den Nicht-Prod-Prefix pro Lauf", () => {
    setEnv("test");
    setRunId("abc123_42_deadbeef");
    expect(getInvoicePdfKeyPrefix()).toBe("_nonprod/test/run-abc123_42_deadbeef");
    expect(buildInvoicePdfObjectKey("RE-2026-0034")).toBe(
      "_nonprod/test/run-abc123_42_deadbeef/invoices/RE-2026-0034.pdf",
    );
    expect(buildInvoicePdfObjectKey("RE-2026-0034", { leistungsnachweis: true })).toBe(
      "_nonprod/test/run-abc123_42_deadbeef/invoices/RE-2026-0034-leistungsnachweis.pdf",
    );
  });

  it("zwei verschiedene Run-IDs ergeben verschiedene Object-Keys (kein paralleles Overwrite)", () => {
    setEnv("test");
    setRunId("run-one");
    const keyA = buildInvoicePdfObjectKey("RE-2026-0034");
    setRunId("run-two");
    const keyB = buildInvoicePdfObjectKey("RE-2026-0034");
    expect(keyA).not.toBe(keyB);
  });

  it("der Schreib-Guard akzeptiert den lauf-gescopten Key und lehnt fremde Läufe/Prod ab", () => {
    setEnv("test");
    setRunId("my-run");
    const key = buildInvoicePdfObjectKey("RE-2026-0034");
    expect(() => assertInvoicePdfWriteKeyAllowed(key)).not.toThrow();
    // Ein Key OHNE den eigenen run-Prefix (z.B. eines anderen Laufs) wird abgelehnt.
    expect(() =>
      assertInvoicePdfWriteKeyAllowed("_nonprod/test/run-other/invoices/RE-2026-0034.pdf"),
    ).toThrow(/Object-Storage-Isolation/);
    expect(() => assertInvoicePdfWriteKeyAllowed("invoices/RE-2026-0034.pdf")).toThrow(
      /Object-Storage-Isolation/,
    );
  });

  it("ohne EPHEMERAL_RUN_ID bleibt der Prefix der reine Umgebungs-Prefix", () => {
    setEnv("test");
    setRunId(undefined);
    expect(getInvoicePdfKeyPrefix()).toBe("_nonprod/test");
  });

  it("Produktion ignoriert EPHEMERAL_RUN_ID (nackter Key-Space bleibt)", () => {
    setEnv("production");
    setRunId("should-be-ignored");
    expect(getInvoicePdfKeyPrefix()).toBe("");
    expect(buildInvoicePdfObjectKey("RE-2026-0034")).toBe("invoices/RE-2026-0034.pdf");
  });
});

describe("Invoice PDF storage per-worker isolation (Task #1263)", () => {
  it("EPHEMERAL_WORKER_ID hängt ein w-<id>-Segment an den lauf-gescopten Prefix", () => {
    setEnv("test");
    setRunId("run-xyz");
    setWorkerId("0");
    expect(getInvoicePdfKeyPrefix()).toBe("_nonprod/test/run-run-xyz/w-0");
    expect(buildInvoicePdfObjectKey("RE-2026-0034")).toBe(
      "_nonprod/test/run-run-xyz/w-0/invoices/RE-2026-0034.pdf",
    );
    expect(buildInvoicePdfObjectKey("RE-2026-0034", { leistungsnachweis: true })).toBe(
      "_nonprod/test/run-run-xyz/w-0/invoices/RE-2026-0034-leistungsnachweis.pdf",
    );
  });

  it("zwei Worker DESSELBEN Laufs schreiben dieselbe Rechnungsnummer auf verschiedene Keys", () => {
    setEnv("test");
    setRunId("same-run");
    setWorkerId("0");
    const keyW0 = buildInvoicePdfObjectKey("RE-2026-0001");
    setWorkerId("1");
    const keyW1 = buildInvoicePdfObjectKey("RE-2026-0001");
    expect(keyW0).not.toBe(keyW1);
    expect(keyW0).toBe("_nonprod/test/run-same-run/w-0/invoices/RE-2026-0001.pdf");
    expect(keyW1).toBe("_nonprod/test/run-same-run/w-1/invoices/RE-2026-0001.pdf");
  });

  it("der Schreib-Guard akzeptiert den worker-gescopten Key und lehnt fremde Worker ab", () => {
    setEnv("test");
    setRunId("guard-run");
    setWorkerId("0");
    const key = buildInvoicePdfObjectKey("RE-2026-0034");
    expect(() => assertInvoicePdfWriteKeyAllowed(key)).not.toThrow();
    // Ein Key eines anderen Workers (oder des nackten Lauf-Prefix) wird abgelehnt.
    expect(() =>
      assertInvoicePdfWriteKeyAllowed("_nonprod/test/run-guard-run/w-1/invoices/RE-2026-0034.pdf"),
    ).toThrow(/Object-Storage-Isolation/);
    expect(() =>
      assertInvoicePdfWriteKeyAllowed("_nonprod/test/run-guard-run/invoices/RE-2026-0034.pdf"),
    ).toThrow(/Object-Storage-Isolation/);
  });

  it("ohne EPHEMERAL_WORKER_ID bleibt der Prefix unverändert (kein w-Segment)", () => {
    setEnv("test");
    setRunId("no-worker");
    setWorkerId(undefined);
    expect(getInvoicePdfKeyPrefix()).toBe("_nonprod/test/run-no-worker");
  });

  it("Produktion ignoriert EPHEMERAL_WORKER_ID (nackter Key-Space bleibt)", () => {
    setEnv("production");
    setRunId("ignored");
    setWorkerId("3");
    expect(getInvoicePdfKeyPrefix()).toBe("");
    expect(buildInvoicePdfObjectKey("RE-2026-0034")).toBe("invoices/RE-2026-0034.pdf");
  });
});
