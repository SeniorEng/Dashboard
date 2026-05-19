/**
 * Task #523 — Regression-Tests für `server/startup/backfill-invoice-pdfs.ts`.
 *
 * Sichert die zwei kritischen Garantien aus Task #521 ab:
 *   1. **Max 20 Rechnungen pro Boot**: Der Backfill darf den Startup nicht
 *      blockieren. Egal wie viele Bestandsrechnungen ohne PDF existieren,
 *      pro Boot wird `LIMIT 20` ans Statement gehängt.
 *   2. **Kein erneutes Persistieren gecachter PDFs**: Wenn die DB-Query keine
 *      Treffer zurückliefert (weil alle Rechnungen schon ein `pdf_path`
 *      haben), wird `persistInvoicePdf` NICHT mehr aufgerufen.
 *
 * `db`, `persistInvoicePdf` und das Log-Modul werden komplett gemockt — der
 * Test braucht weder Postgres noch Puppeteer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<{
    id: number;
    invoiceNumber: string;
    billingType: string;
    pdfPath: string | null;
    leistungsnachweisPath: string | null;
  }>,
  limitCalls: [] as number[],
  whereCalls: 0,
  persistSpy: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("../../server/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          state.whereCalls += 1;
          return {
            limit: (n: number) => {
              state.limitCalls.push(n);
              return Promise.resolve(state.rows);
            },
          };
        },
      }),
    }),
  },
}));

vi.mock("../../server/lib/log", () => ({
  log: vi.fn(),
}));

vi.mock("../../server/routes/billing", () => {
  const fn = vi.fn(async () => {});
  state.persistSpy = fn;
  return { persistInvoicePdf: fn };
});

vi.mock("../../server/services/pdf-generator", () => ({
  discardBrowser: vi.fn(async () => {}),
}));

// Schemaspalten-Identifier reichen aus — der Mock ignoriert die Inhalte.
vi.mock("@shared/schema", () => ({
  invoices: {
    id: "id",
    invoiceNumber: "invoiceNumber",
    billingType: "billingType",
    pdfPath: "pdfPath",
    leistungsnachweisPath: "leistungsnachweisPath",
  },
}));

async function freshModule() {
  vi.resetModules();
  // Persist-Spy wird beim Re-Import des billing-Mocks NICHT neu erzeugt
  // (vitest cached den Factory-Output). Wir setzen ihn defensiv hier neu auf,
  // falls der erste Test ihn bereits aufgerufen hat.
  state.persistSpy?.mockClear?.();
  return await import("../../server/startup/backfill-invoice-pdfs");
}

beforeEach(() => {
  state.rows = [];
  state.limitCalls = [];
  state.whereCalls = 0;
});

describe("backfillInvoicePdfs — 20-pro-Boot-Cap (Task #521)", () => {
  it("hängt LIMIT 20 ans Statement, egal wie viele Bestandsrechnungen existieren", async () => {
    // Simuliere, dass die DB-Query bereits durch LIMIT auf 20 reduziert ist
    // (genau dieses Verhalten wollen wir absichern).
    state.rows = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      invoiceNumber: `R-${1000 + i}`,
      billingType: "privat",
      pdfPath: null,
      leistungsnachweisPath: null,
    }));

    const { backfillInvoicePdfs } = await freshModule();
    const result = await backfillInvoicePdfs();

    expect(state.limitCalls).toContain(20);
    expect(state.limitCalls).toHaveLength(1);
    expect(state.persistSpy).toHaveBeenCalledTimes(20);
    expect(result).toEqual({ processed: 20, failed: 0 });
  }, 20_000);
});

describe("backfillInvoicePdfs — keine Re-Persistierung gecachter PDFs (Task #521)", () => {
  it("ruft persistInvoicePdf NICHT auf, wenn keine Rechnung ohne pdf_path existiert", async () => {
    state.rows = []; // Query liefert nichts — alles schon gecacht.

    const { backfillInvoicePdfs } = await freshModule();
    const result = await backfillInvoicePdfs();

    expect(state.whereCalls).toBe(1);
    expect(state.limitCalls).toEqual([20]);
    expect(state.persistSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });
});
