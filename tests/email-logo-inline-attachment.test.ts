/**
 * Task #1107 — Firmenlogo als Inline-`cid:`-Anhang in Lead- UND Dokument-E-Mails.
 *
 * Schwestertest zu `tests/billing/invoice-email-logo-attachment.test.ts`
 * (Task #1104, Abrechnungs-E-Mails). Hier sind die ÜBRIGEN produktiven
 * Versand-Pfade abgedeckt, die dasselbe Logo-Wiring
 * (`buildLogoInlineAttachment` + `EMAIL_LOGO_SRC`) nutzen:
 *
 *   - Lead-/Prospect-Auto-Reply   (`sendLeadAutoReply`)
 *   - Dokument-Zustellung per Mail (`deliverDocuments`, deliveryMethod="email")
 *
 * Vertrag (Regression-Schutz): Das Firmenlogo MUSS als echter Inline-Anhang
 * (`contentDisposition: "inline"`, `cid: "company-logo"`) mitgeschickt und im
 * HTML über `src="cid:company-logo"` referenziert werden — NIE als eingebettete
 * `data:`-URI (die GMX/Outlook/Gmail teils blocken). Ohne konfiguriertes Logo
 * darf KEIN Anhang und KEIN kaputtes `<img>` entstehen.
 *
 * Die schweren Ränder (Object Storage, DB, Puppeteer-PDF) sind gemockt; der
 * ECHTE `email-service` (Stub-Outbox) und der ECHTE HTML-Renderer laufen, damit
 * der tatsächlich versandte Anhang + HTML geprüft werden.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CompanySettings, Customer, GeneratedDocument } from "@shared/schema";

const LOGO_CID = "company-logo";

// Kleinste gültige PNG (1×1, transparent) — echtes, ladbares Logo.
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// Per-Test umschaltbar: Firmen-Settings + ob ein Logo geladen werden kann.
let mockSettings: CompanySettings;
let mockLogoBytes: { content: Buffer; contentType: string } | null;

const TEST_CUSTOMER = {
  id: 42,
  vorname: "Max",
  nachname: "Mustermann",
  strasse: "Musterstr.",
  nr: "12",
  plz: "12345",
  stadt: "Musterstadt",
  email: "max@example.com",
} as unknown as Customer;

const TEST_DOC = {
  id: 101,
  fileName: "Vertrag_101.pdf",
  objectPath: "/storage/doc_101.pdf",
} as unknown as GeneratedDocument;

// `loadLogoBytes` versorgt `buildLogoInlineAttachment` (im ECHTEN email-service)
// mit Bytes — ohne echten Bucket-Zugriff.
vi.mock("../server/services/logo-resolver", () => ({
  loadLogoBytes: vi.fn(async () => mockLogoBytes),
}));

vi.mock("../server/storage", () => ({
  storage: {
    getCompanySettings: vi.fn(async () => mockSettings),
    getCustomer: vi.fn(async () => TEST_CUSTOMER),
  },
}));

vi.mock("../server/storage/prospects", () => ({
  prospectStorage: { addNote: vi.fn(async () => {}) },
}));

vi.mock("../server/storage/deliveries", () => ({
  deliveryStorage: {
    createDelivery: vi.fn(async (data: Record<string, unknown>) => ({ id: 1, ...data })),
    updateDeliveryStatus: vi.fn(async () => {}),
  },
}));

vi.mock("../server/storage/documents", () => ({
  documentStorage: {
    getGeneratedDocument: vi.fn(async () => TEST_DOC),
  },
}));

vi.mock("../server/services/document-pdf", () => ({
  getDocumentPdfBuffer: vi.fn(async () => Buffer.from("%PDF-1.4 stub", "utf8")),
}));

import { sendLeadAutoReply } from "../server/services/lead-auto-reply";
import { deliverDocuments } from "../server/services/document-delivery";
import {
  getTestOutbox,
  clearTestOutbox,
  type TestOutboxEntry,
} from "../server/services/email-service";

const SMTP_SETTINGS = {
  smtpHost: "smtp.test.local",
  smtpPort: "587",
  smtpUser: "outbox@test.local",
  smtpPass: "stub-secret",
  smtpFromEmail: "absender@test.local",
  smtpFromName: "CareConnect Test",
};

function expectInlineLogo(msg: TestOutboxEntry, label: string): void {
  const att = msg.attachments.find((a) => a.cid === LOGO_CID);
  expect(att, `${label}: Inline-Logo-Anhang (cid=${LOGO_CID}) muss vorhanden sein`).toBeTruthy();
  expect(att!.contentDisposition, `${label}: Logo-Anhang muss "inline" sein`).toBe("inline");
  expect(att!.contentType, `${label}: Logo-Anhang ist ein Bild`).toContain("image/");
  expect(att!.contentBase64.length, `${label}: Logo-Anhang trägt Bytes`).toBeGreaterThan(0);
  expect(msg.html, `${label}: HTML referenziert das Logo über cid:`).toContain(`src="cid:${LOGO_CID}"`);
  expect(msg.html, `${label}: HTML enthält KEINE data:-URI (Regression)`).not.toContain("data:image");
}

function expectNoLogo(msg: TestOutboxEntry, label: string): void {
  expect(
    msg.attachments.find((a) => a.cid === LOGO_CID),
    `${label}: KEIN Logo-Anhang ohne konfiguriertes Logo`,
  ).toBeUndefined();
  expect(msg.html, `${label}: HTML referenziert KEIN cid:-Logo`).not.toContain(`cid:${LOGO_CID}`);
  expect(msg.html, `${label}: HTML enthält KEINE data:-URI`).not.toContain("data:image");
}

beforeEach(() => {
  clearTestOutbox();
  mockLogoBytes = { content: LOGO_PNG, contentType: "image/png" };
});

describe("Task #1107 — Firmenlogo als Inline-cid-Anhang in Lead- & Dokument-E-Mails", () => {
  describe("Lead-/Prospect-Auto-Reply (sendLeadAutoReply)", () => {
    beforeEach(() => {
      mockSettings = {
        companyName: "CareConnect Test",
        logoUrl: "/objects/test-logos/logo.png",
        leadAutoReplyEnabled: true,
        leadAutoReplySubject: "Vielen Dank für Ihre Anfrage",
        leadAutoReplyBody: "Wir melden uns in Kürze bei Ihnen.\n\nIhr Team.",
        telefon: "+49 30 123456",
        email: "info@test.local",
        website: "https://test.local",
        ...SMTP_SETTINGS,
      } as unknown as CompanySettings;
    });

    it("hängt das Logo als Inline-cid-Anhang an", async () => {
      await sendLeadAutoReply({
        prospectId: 1,
        leadEmail: "lead@example.com",
        leadVorname: "Erika",
        leadNachname: "Beispiel",
      });

      const outbox = getTestOutbox();
      const msg = outbox.find((m) => m.to === "lead@example.com");
      expect(msg, "Lead-Auto-Reply muss im Postausgang liegen").toBeTruthy();
      expectInlineLogo(msg!, "Lead-Auto-Reply");
    });

    it("Fallback ohne Logo: kein Anhang, kein kaputtes Bild", async () => {
      mockLogoBytes = null;

      await sendLeadAutoReply({
        prospectId: 1,
        leadEmail: "lead@example.com",
        leadVorname: "Erika",
        leadNachname: "Beispiel",
      });

      const outbox = getTestOutbox();
      const msg = outbox.find((m) => m.to === "lead@example.com");
      expect(msg, "Lead-Auto-Reply muss im Postausgang liegen").toBeTruthy();
      expectNoLogo(msg!, "Lead-Auto-Reply Fallback");
    });
  });

  describe("Dokument-Zustellung per E-Mail (deliverDocuments)", () => {
    beforeEach(() => {
      mockSettings = {
        companyName: "CareConnect Test",
        logoUrl: "/objects/test-logos/logo.png",
        ...SMTP_SETTINGS,
      } as unknown as CompanySettings;
    });

    it("hängt das Logo als Inline-cid-Anhang an (neben dem Dokument-PDF)", async () => {
      const result = await deliverDocuments({
        customerId: TEST_CUSTOMER.id,
        generatedDocumentIds: [TEST_DOC.id],
        deliveryMethod: "email",
        userId: 7,
      });
      expect(result.status, `Versand-Status: ${result.error ?? ""}`).toBe("sent");

      const outbox = getTestOutbox();
      const msg = outbox.find((m) => m.to === TEST_CUSTOMER.email);
      expect(msg, "Dokument-Mail muss im Postausgang liegen").toBeTruthy();
      expectInlineLogo(msg!, "Dokument-Zustellung");

      // Das eigentliche Dokument-PDF bleibt zusätzlich angehängt.
      expect(
        msg!.attachments.some((a) => a.filename === TEST_DOC.fileName),
        "Dokument-PDF muss zusätzlich angehängt sein",
      ).toBe(true);
    });

    it("Fallback ohne Logo: kein Anhang, kein kaputtes Bild", async () => {
      mockLogoBytes = null;

      const result = await deliverDocuments({
        customerId: TEST_CUSTOMER.id,
        generatedDocumentIds: [TEST_DOC.id],
        deliveryMethod: "email",
        userId: 7,
      });
      expect(result.status, `Versand-Status: ${result.error ?? ""}`).toBe("sent");

      const outbox = getTestOutbox();
      const msg = outbox.find((m) => m.to === TEST_CUSTOMER.email);
      expect(msg, "Dokument-Mail muss im Postausgang liegen").toBeTruthy();
      expectNoLogo(msg!, "Dokument-Zustellung Fallback");
    });
  });
});
