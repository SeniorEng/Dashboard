/**
 * Task #552 — Regressions-Test für den `persistInvoicePdf`-Mutex.
 *
 * Sichert ab, dass parallele Send-/Mark-Sent-Klicks für dieselbe Rechnung
 * NICHT zweimal gleichzeitig durch den (teuren) Puppeteer-Render-Pfad
 * gehen, sondern auf denselben in-flight-Promise warten.
 *
 * Zusätzlich wird der Cache-Hit-Pfad geprüft: Wenn die Rechnung bereits
 * sowohl `pdfPath` als auch `leistungsnachweisPath` hat, ist
 * `persistInvoicePdf` ein vollständiges No-op — kein `buildInvoicePdfBytes`,
 * keine Object-Storage-Writes, kein DB-Update.
 *
 * Alle externen Abhängigkeiten sind gemockt — der Test braucht weder
 * Postgres noch Puppeteer noch Object Storage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  invoice: null as null | {
    id: number;
    invoiceNumber: string;
    billingType: string;
    pdfPath: string | null;
    leistungsnachweisPath: string | null;
    zugferdXml: string | null;
    createdByUserId: number | null;
  },
  getInvoiceCalls: 0,
  buildPdfBytesCalls: 0,
  buildPdfBytesGate: null as null | Promise<void>,
  storageSaveCalls: 0,
  dbUpdateCalls: 0,
}));

vi.mock("../../server/storage", () => ({
  storage: {
    getInvoice: vi.fn(async (_id: number) => {
      state.getInvoiceCalls += 1;
      if (state.buildPdfBytesGate) await state.buildPdfBytesGate;
      return state.invoice;
    }),
    // Wird nur im (vom Cache-Hit-Test ausgeschlossenen) Voll-Build-Pfad
    // gebraucht — die Mutex-Tests setzen `state.invoice = null`, sodass
    // `persistInvoicePdfInner` vorher hart aussteigt.
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

vi.mock("../../server/replit_integrations/object_storage/objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({
      file: () => ({
        save: vi.fn(async () => {
          state.storageSaveCalls += 1;
        }),
        // Bereits versiegelte Pfade existieren im Storage — verhindert, dass der
        // Self-Heal-Pfad (Task #1066) im Cache-Hit-Test fälschlich re-rendert.
        exists: vi.fn(async () => [true]),
        download: vi.fn(async () => [Buffer.alloc(0)]),
      }),
    }),
  },
}));

vi.mock("../../server/lib/object-storage-helpers", () => ({
  parseObjectPath: (p: string) => ({ bucketName: "b", objectName: p }),
  getPrivateDir: () => "/private",
  buildInvoicePdfObjectKey: (safeNumber: string, opts?: { leistungsnachweis?: boolean }) =>
    opts?.leistungsnachweis
      ? `invoices/${safeNumber}-leistungsnachweis.pdf`
      : `invoices/${safeNumber}.pdf`,
  assertInvoicePdfWriteKeyAllowed: () => {},
  isObjectStorageConfigured: () => true,
}));

vi.mock("../../server/lib/db", () => ({
  // Task #1074 — `persistInvoicePdfInner` umschließt Re-Check + Render + Write
  // mit `db.transaction(...)` (Advisory-Lock auf die Rechnungs-ID). Der Mock
  // führt den Callback synchron mit einem `tx`-Stub aus; der Schreibpfad nutzt
  // `tx.update(...)`, der Lock `tx.execute(...)`.
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        execute: vi.fn(async () => undefined),
        update: () => ({
          set: () => ({
            where: vi.fn(async () => {
              state.dbUpdateCalls += 1;
            }),
          }),
        }),
      }),
    ),
  },
}));

// Verhindert echte Puppeteer-Calls — `buildInvoicePdfBytes` ist im selben
// Modul wie `persistInvoicePdf`, also können wir es nicht direkt mocken.
// Stattdessen mocken wir den darunter liegenden PDF-Generator + ZUGFeRD.
vi.mock("../../server/lib/pdf-generator", () => ({
  generateInvoiceHtml: () => "<html>invoice</html>",
  generateLeistungsnachweisHtml: () => "<html>ln</html>",
  generatePdf: vi.fn(async () => {
    state.buildPdfBytesCalls += 1;
    return { buffer: Buffer.from("PDFDATA"), pageCount: 1 };
  }),
}));

vi.mock("../../server/lib/zugferd", () => ({
  embedZugferdXml: vi.fn(async (pdf: Buffer) => ({ pdf, xml: "<xml/>" })),
}));

// Minimaler Stub für die enrichPdfDataWithSignatures-Datenbankzugriffe.
vi.mock("../../server/repos", () => ({
  monthlyServiceRecordsRepo: {},
  appointmentsRepo: {},
  customerServicePricesRepo: {},
}));


beforeEach(() => {
  // Standard: getInvoice liefert NULL, sodass `persistInvoicePdfInner` direkt
  // nach dem ersten Await aussteigt. Das genügt, um den Mutex zu testen, ohne
  // den vollen Render-Pfad mocken zu müssen.
  state.invoice = null;
  state.getInvoiceCalls = 0;
  state.buildPdfBytesCalls = 0;
  state.buildPdfBytesGate = null;
  state.storageSaveCalls = 0;
  state.dbUpdateCalls = 0;
  vi.resetModules();
});

describe("persistInvoicePdf — Mutex pro Rechnungs-ID (Task #552)", () => {
  it("parallele Aufrufe für dieselbe Invoice-ID teilen sich denselben in-flight-Promise", async () => {
    let release!: () => void;
    state.buildPdfBytesGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { persistInvoicePdf } = await import("../../server/services/invoice-pdf-orchestrator");

    // 5 parallele Aufrufer für dieselbe ID.
    const promises = [
      persistInvoicePdf(42),
      persistInvoicePdf(42),
      persistInvoicePdf(42),
      persistInvoicePdf(42),
      persistInvoicePdf(42),
    ];

    // Gate freigeben — alle 5 Aufrufer sollten denselben Inner-Run ergeben.
    release();
    await Promise.all(promises);

    expect(
      state.getInvoiceCalls,
      "Mutex-Verletzung: storage.getInvoice wurde mehrfach für dieselbe Invoice-ID aufgerufen",
    ).toBe(1);
    expect(
      state.dbUpdateCalls,
      "Mutex-Verletzung: invoices-Update wurde mehrfach ausgeführt",
    ).toBeLessThanOrEqual(1);
  });

  it("Cache-Hit: persistInvoicePdf ist No-op, wenn pdfPath + LN bereits gesetzt sind", async () => {
    state.invoice = {
      id: 42,
      invoiceNumber: "R-2026-0042",
      billingType: "pflegekasse_gesetzlich",
      pdfPath: "/objects/invoices/R.pdf",
      leistungsnachweisPath: "/objects/invoices/R-ln.pdf",
      zugferdXml: null,
      createdByUserId: 1,
    };

    const { persistInvoicePdf } = await import("../../server/services/invoice-pdf-orchestrator");
    await persistInvoicePdf(42);

    expect(state.buildPdfBytesCalls).toBe(0);
    expect(state.storageSaveCalls).toBe(0);
    expect(state.dbUpdateCalls).toBe(0);
  });

  it("nach erfolgreichem Lauf wird die Mutex-Map wieder freigegeben (zweiter Lauf startet neu)", async () => {
    const { persistInvoicePdf } = await import("../../server/services/invoice-pdf-orchestrator");
    await persistInvoicePdf(42);
    const callsAfterFirst = state.getInvoiceCalls;

    // Zweite Welle — der Mutex-Eintrag muss aufgeräumt sein, sonst wird der
    // alte (bereits resolved-)Promise weiterverwendet und es passiert nichts.
    await persistInvoicePdf(42);
    expect(state.getInvoiceCalls).toBeGreaterThan(callsAfterFirst);
  });
});
