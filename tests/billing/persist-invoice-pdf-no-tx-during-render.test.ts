/**
 * Task #1307 — Regressions-Test für die Pool-Schonung beim Rechnungs-PDF-Persist.
 *
 * Task #1305 hat den teuren Puppeteer-Render + Object-Storage-Upload aus der
 * gehaltenen DB-Transaktion herausgezogen (Drei-Phasen-Modell: kurze Plan-Tx →
 * Render/Upload OHNE Transaktion → kurze Commit-Tx). Damit belegt ein
 * mehrsekündiger Render NICHT mehr eine der 20 gepoolten DB-Verbindungen und
 * hungert unbeteiligte Requests (Session-Validierung, Kundenanlage) nicht aus.
 *
 * Dieser Test verriegelt diese Eigenschaft: Er misst die Schachtelungstiefe der
 * `db.transaction(...)` exakt zu dem Zeitpunkt, an dem der Render (`generatePdf`)
 * und der Upload (`bucket().file().save()`) laufen. Beide MÜSSEN außerhalb jeder
 * Transaktion stattfinden (Tiefe 0). Zusätzlich wird belegt, dass eine völlig
 * unbeteiligte DB-Transaktion zügig durchläuft, WÄHREND ein Render in flight ist.
 *
 * Der Test schlägt fehl, sobald jemand Render+Upload wieder in eine gehaltene
 * `db.transaction` einwickelt (dann wäre die gemessene Tiefe ≥ 1).
 *
 * Alle externen Abhängigkeiten sind gemockt — weder Postgres noch Puppeteer noch
 * Object Storage werden benötigt.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  invoice: null as null | {
    id: number;
    customerId: number;
    invoiceNumber: string;
    billingType: string;
    pdfPath: string | null;
    leistungsnachweisPath: string | null;
    pdfHash: string | null;
    zugferdXml: string | null;
    renderSnapshot: unknown;
    createdByUserId: number | null;
    billingYear: number;
    billingMonth: number;
  },
  // Laufende Schachtelungstiefe der db.transaction(...)-Aufrufe.
  activeTxDepth: 0,
  // Tiefe zum Zeitpunkt des Puppeteer-Renders / des Object-Storage-Uploads.
  txDepthAtRender: null as number | null,
  txDepthAtSave: null as number | null,
  // Gate, um den Render künstlich „in flight" zu halten.
  renderGate: null as null | Promise<void>,
  // Wird gesetzt, sobald der Render begonnen hat (Gate erreicht).
  renderStarted: null as null | (() => void),
  // Wurde eine unbeteiligte Transaktion abgeschlossen, während der Render lief?
  unrelatedTxCompletedDuringRender: false,
  renderInFlight: false,
}));

vi.mock("../../server/storage", () => ({
  storage: {
    getInvoice: vi.fn(async () => state.invoice),
    getInvoiceLineItems: vi.fn(async () => []),
  },
}));

vi.mock("../../server/services/cache", () => ({
  getCachedCompanySettings: vi.fn(async () => ({
    companyName: "Test GmbH",
    logoUrl: null,
  })),
}));

vi.mock("../../server/services/signature-integrity", () => ({
  computeDataHash: (b: unknown) => "h" + String((b as Buffer)?.length ?? 0),
}));

vi.mock("../../server/lib/pdf-determinism", () => ({
  // Längenerhaltende Normalisierung ist hier irrelevant — Buffer unverändert
  // durchreichen, damit der Test keine echten PDF-Bytes braucht.
  normalizePdfDeterminism: (buf: Buffer) => buf,
}));

vi.mock("../../server/lib/invoice-pdf-fingerprint", () => ({
  computeInvoicePdfFingerprint: () => "fp-invoice",
  computeLeistungsnachweisFingerprint: () => "fp-ln",
}));

vi.mock("../../server/replit_integrations/object_storage/objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({
      file: () => ({
        save: vi.fn(async () => {
          // Upload läuft in Phase 2 — Transaktionstiefe hier festhalten.
          state.txDepthAtSave = state.activeTxDepth;
        }),
        exists: vi.fn(async () => [true]),
        download: vi.fn(async () => [Buffer.alloc(0)]),
      }),
    }),
  },
}));

vi.mock("../../server/lib/object-storage-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/lib/object-storage-helpers")>()),
  parseObjectPath: (p: string) => ({ bucketName: "b", objectName: p }),
  getPrivateDir: () => "/private",
  buildInvoicePdfObjectKey: (safeNumber: string, opts?: { leistungsnachweis?: boolean }) =>
    opts?.leistungsnachweis
      ? `invoices/${safeNumber}-leistungsnachweis.pdf`
      : `invoices/${safeNumber}.pdf`,
  assertInvoicePdfWriteKeyAllowed: () => {},
  isObjectStorageConfigured: () => true,
  isProductionPdfEnv: () => false,
  getInvoicePdfKeyPrefix: () => "invoices/",
}));

vi.mock("../../server/lib/db", () => {
  const txCallback = async (cb: (tx: unknown) => Promise<unknown>) => {
    state.activeTxDepth += 1;
    try {
      return await cb({
        execute: vi.fn(async () => undefined),
        update: () => ({
          set: () => ({
            where: vi.fn(async () => undefined),
          }),
        }),
      });
    } finally {
      state.activeTxDepth -= 1;
    }
  };
  // Kunden-Stammdaten-Read in buildInvoicePdfData (kein Snapshot-Pfad).
  const selectChain = () => {
    const rows = [{
      geburtsdatum: null,
      beihilfeBerechtigt: null,
      rechnungAnKunde: null,
      name: "Kunde",
      vorname: null,
      nachname: null,
      strasse: null,
      nr: null,
      plz: null,
      stadt: null,
    }];
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: async () => rows,
    };
    return chain;
  };
  return {
    db: {
      transaction: vi.fn(txCallback),
      select: vi.fn(selectChain),
    },
  };
});

vi.mock("../../server/lib/pdf-generator", () => ({
  generateInvoiceHtml: () => "<html>invoice</html>",
  generateLeistungsnachweisHtml: () => "<html>ln</html>",
  buildInvoiceFooterTemplate: () => "<footer/>",
  buildLeistungsnachweisFooterTemplate: () => "<footer/>",
  generatePdf: vi.fn(async () => {
    // Render läuft in Phase 2 — Transaktionstiefe hier festhalten.
    if (state.txDepthAtRender === null) state.txDepthAtRender = state.activeTxDepth;
    state.renderInFlight = true;
    state.renderStarted?.();
    if (state.renderGate) await state.renderGate;
    state.renderInFlight = false;
    return { buffer: Buffer.from("PDFDATA"), pageCount: 1 };
  }),
}));

vi.mock("../../server/lib/zugferd", () => ({
  DEFAULT_ZUGFERD_PROFILE: "en16931",
  embedZugferdXml: vi.fn(async (pdf: Buffer) => ({
    pdf,
    xml: "<xml/>",
    usedStrictMode: true,
    strictModeReason: null,
  })),
}));

vi.mock("../../server/repos", () => ({
  monthlyServiceRecordsRepo: {},
  appointmentsRepo: {},
  customerServicePricesRepo: {},
}));

beforeEach(() => {
  state.invoice = {
    id: 42,
    customerId: 7,
    invoiceNumber: "R-2026-0042",
    billingType: "selbstzahler",
    pdfPath: null,
    leistungsnachweisPath: null,
    pdfHash: null,
    zugferdXml: null,
    renderSnapshot: null,
    createdByUserId: 1,
    billingYear: 2026,
    billingMonth: 6,
  };
  state.activeTxDepth = 0;
  state.txDepthAtRender = null;
  state.txDepthAtSave = null;
  state.renderGate = null;
  state.renderStarted = null;
  state.unrelatedTxCompletedDuringRender = false;
  state.renderInFlight = false;
  vi.resetModules();
});

describe("persistInvoicePdf — Render/Upload halten KEINE DB-Transaktion (Task #1307)", () => {
  it("Render (generatePdf) läuft außerhalb jeder db.transaction (Tiefe 0)", async () => {
    const { persistInvoicePdf } = await import("../../server/services/invoice-pdf-orchestrator");
    await persistInvoicePdf(42);

    expect(
      state.txDepthAtRender,
      "Render wurde nicht erreicht — Test-Setup prüfen",
    ).not.toBeNull();
    expect(
      state.txDepthAtRender,
      "Pool-Starvation-Regression: der Puppeteer-Render lief INNERHALB einer gehaltenen db.transaction",
    ).toBe(0);
  });

  it("Upload (Object Storage save) läuft außerhalb jeder db.transaction (Tiefe 0)", async () => {
    const { persistInvoicePdf } = await import("../../server/services/invoice-pdf-orchestrator");
    await persistInvoicePdf(42);

    expect(
      state.txDepthAtSave,
      "Upload wurde nicht erreicht — Test-Setup prüfen",
    ).not.toBeNull();
    expect(
      state.txDepthAtSave,
      "Pool-Starvation-Regression: der Object-Storage-Upload lief INNERHALB einer gehaltenen db.transaction",
    ).toBe(0);
  });

  it("eine unbeteiligte db.transaction läuft zügig durch, WÄHREND ein Render in flight ist", async () => {
    // Render künstlich anhalten, damit wir „in flight" beobachten können.
    let releaseRender!: () => void;
    state.renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderReached = new Promise<void>((resolve) => {
      state.renderStarted = resolve;
    });

    const { persistInvoicePdf } = await import("../../server/services/invoice-pdf-orchestrator");
    const { db } = await import("../../server/lib/db");

    const persistPromise = persistInvoicePdf(42);

    // Warten, bis der Render tatsächlich begonnen hat (Phase 2, kein Lock gehalten).
    await renderReached;
    expect(state.renderInFlight).toBe(true);

    // Während der Render hängt: eine unbeteiligte Transaktion MUSS sofort
    // durchlaufen (kein gehaltener Connection-/Advisory-Lock blockiert sie).
    const unrelated = await db.transaction(async () => "ok");
    expect(unrelated).toBe("ok");
    state.unrelatedTxCompletedDuringRender = state.renderInFlight;

    // Render freigeben und Persist abschließen.
    releaseRender();
    await persistPromise;

    expect(
      state.unrelatedTxCompletedDuringRender,
      "Eine unbeteiligte Transaktion konnte NICHT abschließen, während der Render lief — Hinweis auf wieder eingewickelten Render",
    ).toBe(true);
    expect(state.txDepthAtRender).toBe(0);
    expect(state.txDepthAtSave).toBe(0);
  });
});
