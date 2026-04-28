import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nodemailer from "nodemailer";
import type { CompanySettings } from "@shared/schema";
import {
  sendEmail,
  testSmtpConnection,
  isStubEmailTransport,
} from "../server/services/email-service";

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn() },
}));

const createTransport = nodemailer.createTransport as unknown as ReturnType<typeof vi.fn>;

function makeSettings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    id: 1,
    companyName: "Test GmbH",
    companyStreet: null,
    companyHouseNumber: null,
    companyZip: null,
    companyCity: null,
    companyPhone: null,
    companyEmail: null,
    companyTaxNumber: null,
    companyVatId: null,
    companyIban: null,
    companyBic: null,
    companyBankName: null,
    logoUrl: null,
    invoicePrefix: null,
    invoiceFooter: null,
    invoiceTermsDays: null,
    invoicePaymentInstructions: null,
    smtpHost: "smtp-mailcatcher.test.local",
    smtpPort: "587",
    smtpUser: "tester@test.local",
    smtpPass: "supersecret",
    smtpFromEmail: "from@test.local",
    smtpFromName: "Test Sender",
    smtpSecure: false,
    ...overrides,
  } as unknown as CompanySettings;
}

describe("email-service real SMTP path (Task #232)", () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    createTransport.mockReset();
    originalNodeEnv = process.env.NODE_ENV;
    // The real path is what we want to verify — opt out of the test stub
    // explicitly. nodemailer is mocked so no network traffic occurs.
    process.env.EMAIL_TRANSPORT = "real";
  });

  afterEach(() => {
    delete process.env.EMAIL_TRANSPORT;
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  describe("isStubEmailTransport()", () => {
    it("EMAIL_TRANSPORT=real overrides NODE_ENV=test", () => {
      process.env.NODE_ENV = "test";
      process.env.EMAIL_TRANSPORT = "real";
      expect(isStubEmailTransport()).toBe(false);
    });

    it("EMAIL_TRANSPORT=stub forces stub even outside test env", () => {
      process.env.NODE_ENV = "development";
      process.env.EMAIL_TRANSPORT = "stub";
      expect(isStubEmailTransport()).toBe(true);
    });

    it("NODE_ENV=test alone keeps the stub active", () => {
      process.env.NODE_ENV = "test";
      delete process.env.EMAIL_TRANSPORT;
      expect(isStubEmailTransport()).toBe(true);
    });

    it("NODE_ENV=production with no override uses real transport", () => {
      process.env.NODE_ENV = "production";
      delete process.env.EMAIL_TRANSPORT;
      expect(isStubEmailTransport()).toBe(false);
    });
  });

  describe("testSmtpConnection() — real path", () => {
    it("invokes nodemailer.createTransport with port 587 STARTTLS, requireTLS, TLS 1.2 floor", async () => {
      const verify = vi.fn().mockResolvedValue(true);
      createTransport.mockReturnValue({ verify, sendMail: vi.fn() });

      const result = await testSmtpConnection(makeSettings());

      expect(result).toEqual({ success: true });
      expect(createTransport).toHaveBeenCalledTimes(1);
      const opts = createTransport.mock.calls[0][0];
      expect(opts.host).toBe("smtp-mailcatcher.test.local");
      expect(opts.port).toBe(587);
      // Port 587 → explicit STARTTLS, not implicit TLS
      expect(opts.secure).toBe(false);
      expect(opts.requireTLS).toBe(true);
      expect(opts.auth).toEqual({
        user: "tester@test.local",
        pass: "supersecret",
      });
      expect(opts.tls?.minVersion).toBe("TLSv1.2");
      // In test env we accept self-signed certs against a local mail catcher;
      // production must reject untrusted chains.
      expect(opts.tls?.rejectUnauthorized).toBe(false);
      expect(verify).toHaveBeenCalledTimes(1);
    });

    it("uses implicit TLS (secure=true, requireTLS=false) on port 465", async () => {
      const verify = vi.fn().mockResolvedValue(true);
      createTransport.mockReturnValue({ verify, sendMail: vi.fn() });

      await testSmtpConnection(makeSettings({ smtpPort: "465" }));

      const opts = createTransport.mock.calls[0][0];
      expect(opts.port).toBe(465);
      expect(opts.secure).toBe(true);
      expect(opts.requireTLS).toBe(false);
      expect(opts.tls?.minVersion).toBe("TLSv1.2");
    });

    it("flips tls.rejectUnauthorized=true when running in NODE_ENV=production", async () => {
      const verify = vi.fn().mockResolvedValue(true);
      createTransport.mockReturnValue({ verify, sendMail: vi.fn() });
      process.env.NODE_ENV = "production";

      await testSmtpConnection(makeSettings());

      const opts = createTransport.mock.calls[0][0];
      expect(opts.tls?.rejectUnauthorized).toBe(true);
    });

    it("returns the underlying error message when verify() rejects", async () => {
      const verify = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      createTransport.mockReturnValue({ verify, sendMail: vi.fn() });

      const result = await testSmtpConnection(makeSettings());

      expect(result.success).toBe(false);
      expect(result.error).toBe("ECONNREFUSED");
    });

    it("returns the 'SMTP nicht konfiguriert' error when SMTP fields are missing", async () => {
      const result = await testSmtpConnection(
        makeSettings({ smtpHost: null, smtpPort: null, smtpUser: null, smtpPass: null }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("SMTP-Konfiguration unvollständig");
      expect(createTransport).not.toHaveBeenCalled();
    });

    it("never contacts an Office 365 host from the test suite", async () => {
      const verify = vi.fn().mockResolvedValue(true);
      createTransport.mockReturnValue({ verify, sendMail: vi.fn() });

      await testSmtpConnection(makeSettings());

      const calledHosts = createTransport.mock.calls.map((c) => (c[0] as { host?: string }).host ?? "");
      for (const host of calledHosts) {
        expect(host.toLowerCase()).not.toContain("office365");
        expect(host.toLowerCase()).not.toContain("outlook.com");
        expect(host.toLowerCase()).not.toContain("microsoft");
      }
    });
  });

  describe("sendEmail() — real path", () => {
    it("forwards subject/html/attachments and the From-header to nodemailer", async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: "<real-1@test.local>" });
      createTransport.mockReturnValue({ verify: vi.fn(), sendMail });

      const result = await sendEmail(makeSettings(), {
        to: "to@test.local",
        subject: "Hallo",
        html: "<p>hi</p>",
        attachments: [
          { filename: "Rechnung.pdf", content: Buffer.from("PDF"), contentType: "application/pdf" },
        ],
      });

      expect(result).toEqual({ messageId: "<real-1@test.local>" });
      expect(sendMail).toHaveBeenCalledTimes(1);
      const call = sendMail.mock.calls[0][0];
      expect(call.to).toBe("to@test.local");
      expect(call.subject).toBe("Hallo");
      expect(call.html).toBe("<p>hi</p>");
      expect(call.from).toBe('"Test Sender" <from@test.local>');
      expect(call.attachments).toEqual([
        { filename: "Rechnung.pdf", content: expect.any(Buffer), contentType: "application/pdf" },
      ]);
    });

    it("falls back to companyName + smtpUser when smtpFromName / smtpFromEmail are missing", async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: "<real-2@test.local>" });
      createTransport.mockReturnValue({ verify: vi.fn(), sendMail });

      await sendEmail(
        makeSettings({ smtpFromName: null, smtpFromEmail: null }),
        { to: "to@test.local", subject: "x", html: "y" },
      );

      const call = sendMail.mock.calls[0][0];
      expect(call.from).toBe('"Test GmbH" <tester@test.local>');
    });

    it("defaults attachment contentType to application/pdf when omitted", async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: "<real-3@test.local>" });
      createTransport.mockReturnValue({ verify: vi.fn(), sendMail });

      await sendEmail(makeSettings(), {
        to: "to@test.local",
        subject: "x",
        html: "y",
        attachments: [{ filename: "doc.pdf", content: Buffer.from("PDF") }],
      });

      const call = sendMail.mock.calls[0][0];
      expect(call.attachments[0].contentType).toBe("application/pdf");
    });

    it("throws the same 'SMTP nicht konfiguriert' error on incomplete settings", async () => {
      await expect(
        sendEmail(makeSettings({ smtpHost: null }), {
          to: "to@test.local",
          subject: "x",
          html: "y",
        }),
      ).rejects.toThrow(/SMTP-Konfiguration unvollständig/);
      expect(createTransport).not.toHaveBeenCalled();
    });

    it("propagates errors thrown by nodemailer.sendMail", async () => {
      const sendMail = vi.fn().mockRejectedValue(new Error("550 mailbox unavailable"));
      createTransport.mockReturnValue({ verify: vi.fn(), sendMail });

      await expect(
        sendEmail(makeSettings(), { to: "to@test.local", subject: "x", html: "y" }),
      ).rejects.toThrow("550 mailbox unavailable");
    });
  });

  describe("Stub-mode safety regression", () => {
    it("does not invoke nodemailer.createTransport when EMAIL_TRANSPORT=stub", async () => {
      process.env.EMAIL_TRANSPORT = "stub";

      const result = await sendEmail(makeSettings(), {
        to: "to@test.local",
        subject: "stub",
        html: "<p>stub</p>",
      });

      expect(result.messageId).toMatch(/^<stub-/);
      expect(createTransport).not.toHaveBeenCalled();
    });

    it("testSmtpConnection returns success without touching nodemailer in stub mode", async () => {
      process.env.EMAIL_TRANSPORT = "stub";

      const result = await testSmtpConnection(makeSettings());

      expect(result).toEqual({ success: true });
      expect(createTransport).not.toHaveBeenCalled();
    });
  });
});
