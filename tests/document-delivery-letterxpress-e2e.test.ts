import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "net";
import { PDFDocument } from "pdf-lib";
import type {
  CompanySettings,
  Customer,
  DocumentDelivery,
  GeneratedDocument,
  InsertDocumentDelivery,
} from "@shared/schema";

interface DeliveryRow extends DocumentDelivery {
  errorMessage: string | null;
  letterxpressLetterId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
}

interface DeliveryUpdate {
  status: string;
  errorMessage?: string | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  letterxpressLetterId?: string | null;
}

const deliveryRows: DeliveryRow[] = [];

const TEST_USER_ID = 99;
const TEST_CUSTOMER_ID = 42;
const TEST_DOCUMENT_ID = 101;

const TEST_CUSTOMER = {
  id: TEST_CUSTOMER_ID,
  vorname: "Max",
  nachname: "Mustermann",
  strasse: "Musterstr.",
  nr: "12",
  plz: "12345",
  stadt: "Musterstadt",
  email: "max@example.com",
} as unknown as Customer;

const TEST_SETTINGS = {
  id: 1,
  companyName: "Test GmbH",
  letterxpressUsername: "user@example.com",
  letterxpressApiKey: "secret-api-key",
  letterxpressTestMode: true,
} as unknown as CompanySettings;

const TEST_GENERATED_DOC = {
  id: TEST_DOCUMENT_ID,
  fileName: `Dokument_${TEST_DOCUMENT_ID}.pdf`,
  objectPath: `/storage/doc_${TEST_DOCUMENT_ID}.pdf`,
} as unknown as GeneratedDocument;

async function makeMinimalPdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  page.drawText(label, { x: 20, y: 100 });
  return Buffer.from(await doc.save());
}

vi.mock("../server/storage", () => ({
  storage: {
    getCustomer: vi.fn(async () => TEST_CUSTOMER),
    getCompanySettings: vi.fn(async () => TEST_SETTINGS),
  },
}));

vi.mock("../server/storage/deliveries", () => ({
  deliveryStorage: {
    createDelivery: vi.fn(async (data: InsertDocumentDelivery): Promise<DeliveryRow> => {
      const row: DeliveryRow = {
        id: deliveryRows.length + 1,
        createdAt: new Date(),
        errorMessage: null,
        letterxpressLetterId: null,
        sentAt: null,
        deliveredAt: null,
        ...data,
      } as DeliveryRow;
      deliveryRows.push(row);
      return row;
    }),
    updateDeliveryStatus: vi.fn(async (id: number, updates: DeliveryUpdate) => {
      const row = deliveryRows.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, updates);
      return row;
    }),
    getDeliveriesByCustomer: vi.fn(),
    getDeliveryById: vi.fn(async (id: number) => deliveryRows.find((r) => r.id === id) ?? null),
    getRecentDeliveries: vi.fn(),
  },
}));

vi.mock("../server/storage/documents", () => ({
  documentStorage: {
    getGeneratedDocument: vi.fn(async () => TEST_GENERATED_DOC),
    getGeneratedDocuments: vi.fn(),
  },
}));

// document-pdf is mocked because the real implementation reads from object
// storage. cover-letter is mocked because the real implementation launches a
// puppeteer/chromium process to render HTML→PDF, which is unsuitable for unit
// runs. Both mocks return *real, parseable* PDFs so combinePdfBuffers actually
// merges them — that is the regression we want to protect.
vi.mock("../server/services/document-pdf", () => ({
  getDocumentPdfBuffer: vi.fn(async () => makeMinimalPdf("DOCUMENT")),
  generateAndStorePdf: vi.fn(),
  regeneratePdfWithSignature: vi.fn(),
  createSigningLinkAndRespond: vi.fn(),
}));

vi.mock("../server/services/cover-letter", () => ({
  renderCoverLetterPdf: vi.fn(async () => makeMinimalPdf("COVER")),
  renderEmailSubject: vi.fn(() => "Subject"),
  renderEmailHtml: vi.fn(() => "<p>Body</p>"),
}));

vi.mock("../server/services/logo-resolver", () => ({
  resolveLogoToDataUrl: vi.fn(async () => null),
}));

vi.mock("../server/services/cache", () => ({
  getCachedCompanySettings: vi.fn(),
}));

vi.mock("../server/services/email-service", () => ({
  sendEmail: vi.fn(async () => ({ messageId: "<stub>" })),
  testSmtpConnection: vi.fn(),
}));

const realFetch = globalThis.fetch.bind(globalThis);
const LX_HOST = "api.letterxpress.de";
const fetchMock = vi.fn<typeof fetch>();

const dispatchFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes(LX_HOST)) {
    return fetchMock(input, init);
  }
  return realFetch(input, init);
};

let server: import("http").Server;
let baseUrl: string;

async function startTestServer(): Promise<void> {
  const { default: router } = await import("../server/routes/admin/document-delivery");
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { id: number; isAdmin: boolean } }).user = {
      id: TEST_USER_ID,
      isAdmin: true,
    };
    next();
  });
  app.use("/api/admin", router);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  deliveryRows.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", dispatchFetch);
  await startTestServer();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface SendResponseSuccess {
  status: string;
  deliveryId: number;
}

interface SendResponseError {
  code: string;
  message: string;
  deliveryId: number;
}

describe("POST /api/admin/document-delivery/send (LetterXpress E2E)", () => {
  it("happy path: route → service → storage → letterxpress writes a 'sent' delivery row with the returned letterxpress_letter_id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 200, message: "OK", data: { letter_id: "lx-987" } }),
    );

    const res = await fetch(`${baseUrl}/api/admin/document-delivery/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: TEST_CUSTOMER_ID,
        generatedDocumentIds: [TEST_DOCUMENT_ID],
        deliveryMethod: "post",
      }),
    });
    const body = (await res.json()) as SendResponseSuccess;

    expect(res.status).toBe(200);
    expect(body.status).toBe("sent");
    expect(typeof body.deliveryId).toBe("number");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/setJob");
    const lxBody = JSON.parse((init as RequestInit).body as string) as {
      auth: { username: string; apikey: string };
      letter: {
        base64_file: string;
        specification: { print: string; color: string; mode: string; ship: string };
      };
    };
    expect(lxBody.auth.username).toBe("user@example.com");
    expect(lxBody.auth.apikey).toBe("secret-api-key");
    expect(lxBody.letter.specification.print).toBe("test");

    // Verify the cover letter and document PDF were actually merged into the
    // payload sent to LetterXpress (combinePdfBuffers must succeed; if it had
    // fallen back to "first buffer only" we would only see 1 page).
    const sentPdf = await PDFDocument.load(Buffer.from(lxBody.letter.base64_file, "base64"));
    expect(sentPdf.getPageCount()).toBe(2);

    expect(deliveryRows).toHaveLength(1);
    const row = deliveryRows[0];
    expect(row.customerId).toBe(TEST_CUSTOMER_ID);
    expect(row.generatedDocumentId).toBe(TEST_DOCUMENT_ID);
    expect(row.deliveryMethod).toBe("post");
    expect(row.status).toBe("sent");
    expect(row.letterxpressLetterId).toBe("lx-987");
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.errorMessage).toBeNull();
    expect(row.createdByUserId).toBe(TEST_USER_ID);
    expect(row.recipientName).toBe("Max Mustermann");
    expect(row.recipientAddress).toContain("Musterstr.");
  });

  it("failure path: LetterXpress 4xx → delivery row is marked 'error' with the German error message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 401, message: "Unauthorized" }, 401),
    );

    const res = await fetch(`${baseUrl}/api/admin/document-delivery/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: TEST_CUSTOMER_ID,
        generatedDocumentIds: [TEST_DOCUMENT_ID],
        deliveryMethod: "post",
      }),
    });
    const body = (await res.json()) as SendResponseError;

    expect(res.status).toBe(502);
    expect(body.code).toBe("DELIVERY_ERROR");
    expect(body.message).toMatch(/LetterXpress-Aufruf fehlgeschlagen \(401\)/);
    expect(typeof body.deliveryId).toBe("number");

    expect(deliveryRows).toHaveLength(1);
    const row = deliveryRows[0];
    expect(row.status).toBe("error");
    expect(row.errorMessage).toMatch(/LetterXpress-Aufruf fehlgeschlagen \(401\)/);
    expect(row.letterxpressLetterId).toBeNull();
    expect(row.sentAt).toBeNull();
  });
});
