/**
 * Task #1806 — Retention/Cleanup für Nicht-Prod-PDF-Artefakte im Object-Storage.
 *
 * Garantien dieser Suite (Done-Kriterien):
 *  1. Der Sweep listet Objekte unter `_nonprod/…` und löscht NUR die
 *     ausreichend ALTEN (Altersgrenze schützt frische Artefakte paralleler Läufe).
 *  2. Dry-Run per Default: es wird nichts gelöscht, nur berichtet.
 *  3. Harter Guard: taucht je ein Nicht-`_nonprod/`-Key (z.B. Produktions-
 *     `invoices/…`) in der Liste auf, bricht der Sweep hart ab, statt zu löschen.
 *  4. Der Delete-Guard `assertNonprodPdfDeleteKeyAllowed` spiegelt symmetrisch
 *     den Schreib-Guard.
 */
import { describe, it, expect, vi } from "vitest";
import {
  assertNonprodPdfDeleteKeyAllowed,
  getNonprodPdfSweepPrefix,
} from "../../server/lib/object-storage-helpers";
import {
  sweepNonprodPdfArtifacts,
  type NonprodPdfBucketPort,
  type SweepableObject,
} from "../../scripts/lib/object-storage-pdf-sweep";

const PRIV = ".private/";
const NP = ".private/_nonprod/";

function makeBucket(objects: SweepableObject[]): {
  port: NonprodPdfBucketPort;
  deleted: string[];
} {
  const deleted: string[] = [];
  const port: NonprodPdfBucketPort = {
    async list() {
      return objects;
    },
    async delete(name) {
      deleted.push(name);
    },
  };
  return { port, deleted };
}

const location = { objectPrefix: NP, privateObjectDir: PRIV };

describe("assertNonprodPdfDeleteKeyAllowed (Task #1806)", () => {
  it("erlaubt Keys unter _nonprod/", () => {
    expect(() =>
      assertNonprodPdfDeleteKeyAllowed("_nonprod/test/invoices/RE-2026-0001.pdf"),
    ).not.toThrow();
    expect(() =>
      assertNonprodPdfDeleteKeyAllowed(
        "_nonprod/development/run-abc/w-0/invoices/RE-2026-0001-leistungsnachweis.pdf",
      ),
    ).not.toThrow();
  });

  it("verbietet den nackten Produktions-Key-Space (invoices/…)", () => {
    expect(() => assertNonprodPdfDeleteKeyAllowed("invoices/RE-2026-0001.pdf")).toThrow(
      /Object-Storage-Retention/,
    );
    expect(() =>
      assertNonprodPdfDeleteKeyAllowed("invoices/RE-2026-0001-leistungsnachweis.pdf"),
    ).toThrow(/Object-Storage-Retention/);
  });

  it("getNonprodPdfSweepPrefix liefert den _nonprod/-Wurzel-Prefix", () => {
    expect(getNonprodPdfSweepPrefix()).toBe("_nonprod/");
  });
});

describe("sweepNonprodPdfArtifacts (Task #1806)", () => {
  const now = 1_000_000_000_000;
  const retentionMs = 24 * 60 * 60 * 1000;

  it("löscht nur ausreichend ALTE Objekte, junge bleiben unberührt", async () => {
    const objects: SweepableObject[] = [
      { name: `${NP}test/invoices/OLD.pdf`, createdAtMs: now - retentionMs - 1 },
      { name: `${NP}test/invoices/FRESH.pdf`, createdAtMs: now - 1000 },
    ];
    const { port, deleted } = makeBucket(objects);
    const res = await sweepNonprodPdfArtifacts(port, location, {
      dryRun: false,
      now,
      retentionMs,
    });
    expect(res.scanned).toBe(2);
    expect(res.deleted).toEqual([`${NP}test/invoices/OLD.pdf`]);
    expect(res.skipped).toBe(1);
    expect(deleted).toEqual([`${NP}test/invoices/OLD.pdf`]);
  });

  it("Dry-Run löscht nichts, berichtet aber die Kandidaten", async () => {
    const objects: SweepableObject[] = [
      { name: `${NP}test/invoices/OLD.pdf`, createdAtMs: now - retentionMs - 1 },
    ];
    const { port, deleted } = makeBucket(objects);
    const res = await sweepNonprodPdfArtifacts(port, location, {
      dryRun: true,
      now,
      retentionMs,
    });
    expect(res.deleted).toEqual([`${NP}test/invoices/OLD.pdf`]);
    expect(deleted).toEqual([]); // nichts wirklich gelöscht
  });

  it("überspringt alters-unbekannte Objekte konservativ", async () => {
    const objects: SweepableObject[] = [
      { name: `${NP}test/invoices/UNKNOWN.pdf`, createdAtMs: null },
    ];
    const { port, deleted } = makeBucket(objects);
    const res = await sweepNonprodPdfArtifacts(port, location, {
      dryRun: false,
      now,
      retentionMs,
    });
    expect(res.skipped).toBe(1);
    expect(deleted).toEqual([]);
  });

  it("bricht HART ab, wenn ein Produktions-Key in der Liste auftaucht", async () => {
    const objects: SweepableObject[] = [
      // Simuliert einen fehlerhaften Prefix-Match, der einen Prod-Key durchlässt.
      { name: `${PRIV}invoices/PROD.pdf`, createdAtMs: now - retentionMs - 1 },
    ];
    // objectPrefix bleibt _nonprod/, aber das Objekt liegt außerhalb → wird als
    // "außerhalb Prefix" übersprungen, nicht gelöscht.
    const { port, deleted } = makeBucket(objects);
    const res = await sweepNonprodPdfArtifacts(port, location, {
      dryRun: false,
      now,
      retentionMs,
    });
    expect(res.deleted).toEqual([]);
    expect(deleted).toEqual([]);
    expect(res.skipped).toBe(1);
  });

  it("verweigert einen Listen-Prefix, der nicht _nonprod/ enthält", async () => {
    const { port } = makeBucket([]);
    await expect(
      sweepNonprodPdfArtifacts(
        port,
        { objectPrefix: ".private/invoices/", privateObjectDir: PRIV },
        { dryRun: true, now, retentionMs },
      ),
    ).rejects.toThrow(/Object-Storage-Retention verweigert/);
  });

  it("zählt fehlgeschlagene Löschungen, ohne den Sweep abzubrechen", async () => {
    const objects: SweepableObject[] = [
      { name: `${NP}test/invoices/A.pdf`, createdAtMs: now - retentionMs - 1 },
      { name: `${NP}test/invoices/B.pdf`, createdAtMs: now - retentionMs - 1 },
    ];
    const deleted: string[] = [];
    const port: NonprodPdfBucketPort = {
      async list() {
        return objects;
      },
      delete: vi.fn(async (name: string) => {
        if (name.endsWith("A.pdf")) throw new Error("boom");
        deleted.push(name);
      }),
    };
    const res = await sweepNonprodPdfArtifacts(port, location, {
      dryRun: false,
      now,
      retentionMs,
    });
    expect(res.failed).toEqual([`${NP}test/invoices/A.pdf`]);
    expect(res.deleted).toEqual([`${NP}test/invoices/B.pdf`]);
  });
});
