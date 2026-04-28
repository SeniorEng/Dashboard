import nodemailer from "nodemailer";
import type { CompanySettings } from "@shared/schema";

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
  }>;
}

export interface TestOutboxEntry {
  to: string;
  subject: string;
  html: string;
  from: string;
  attachmentCount: number;
  attachmentNames: string[];
  messageId: string;
  sentAt: string;
}

const testOutbox: TestOutboxEntry[] = [];

export function isStubEmailTransport(): boolean {
  // Explicit opt-out lets unit tests exercise the real nodemailer path
  // (e.g. tests/email-service.test.ts) without sending mail anywhere — the
  // real transport is mocked in that test file. Office 365 must NEVER be
  // contacted from tests, so this opt-out is only meaningful when paired
  // with a mocked nodemailer or a local mail catcher.
  if (process.env.EMAIL_TRANSPORT === "real") return false;
  if (process.env.EMAIL_TRANSPORT === "stub") return true;
  return process.env.NODE_ENV === "test";
}

export function getTestOutbox(): TestOutboxEntry[] {
  return [...testOutbox];
}

export function clearTestOutbox(): void {
  testOutbox.length = 0;
}

function ensureSmtpConfigured(settings: CompanySettings): void {
  if (!settings.smtpHost || !settings.smtpPort || !settings.smtpUser || !settings.smtpPass) {
    throw new Error("SMTP-Konfiguration unvollständig. Bitte in den Einstellungen konfigurieren.");
  }
}

function createTransporter(settings: CompanySettings) {
  ensureSmtpConfigured(settings);

  const port = parseInt(settings.smtpPort!, 10);
  const useSecure = port === 465;

  return nodemailer.createTransport({
    host: settings.smtpHost!,
    port,
    secure: useSecure,
    // Force STARTTLS on submission ports (587 etc.). Office 365 rejects
    // plain-text submissions, so requireTLS must be true whenever we are
    // not already in implicit-TLS mode (port 465).
    requireTLS: !useSecure,
    auth: {
      user: settings.smtpUser!,
      pass: settings.smtpPass!,
    },
    tls: {
      // Pin the TLS floor to 1.2 — Office 365 disabled TLS 1.0/1.1 in 2020,
      // and modern providers all support 1.2+. This also guarantees a
      // modern cipher suite is negotiated.
      minVersion: "TLSv1.2",
      rejectUnauthorized: process.env.NODE_ENV === "production",
    },
  });
}

export async function sendEmail(settings: CompanySettings, options: EmailOptions): Promise<{ messageId: string }> {
  // Validation branches (BF-7-style "SMTP nicht konfiguriert") must keep working
  // identically in stub mode, so we run the same check first.
  ensureSmtpConfigured(settings);

  const fromName = settings.smtpFromName || settings.companyName || "SeniorenEngel";
  const fromEmail = settings.smtpFromEmail || settings.smtpUser!;
  const fromHeader = `"${fromName}" <${fromEmail}>`;

  if (isStubEmailTransport()) {
    const messageId = `<stub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@test.local>`;
    testOutbox.push({
      to: options.to,
      subject: options.subject,
      html: options.html,
      from: fromHeader,
      attachmentCount: options.attachments?.length ?? 0,
      attachmentNames: options.attachments?.map((a) => a.filename) ?? [],
      messageId,
      sentAt: new Date().toISOString(),
    });
    return { messageId };
  }

  const transporter = createTransporter(settings);

  const result = await transporter.sendMail({
    from: fromHeader,
    to: options.to,
    subject: options.subject,
    html: options.html,
    attachments: options.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType || "application/pdf",
    })),
  });

  return { messageId: result.messageId };
}

export async function testSmtpConnection(settings: CompanySettings): Promise<{ success: boolean; error?: string }> {
  try {
    // Same validation as real send, so the admin button surfaces the same
    // "SMTP nicht konfiguriert" errors in test/dev as it would in production.
    ensureSmtpConfigured(settings);

    if (isStubEmailTransport()) {
      return { success: true };
    }

    const transporter = createTransporter(settings);
    await transporter.verify();
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "Verbindung fehlgeschlagen" };
  }
}

function toAbsoluteUrl(relativeUrl: string | null | undefined): string | null {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith("data:")) return relativeUrl;
  if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) return relativeUrl;
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0] || process.env.REPLIT_DEV_DOMAIN;
  if (!domain) return null;
  const base = `https://${domain}`;
  return `${base}${relativeUrl.startsWith("/") ? "" : "/"}${relativeUrl}`;
}

export function buildEmailLayout(companyName: string, logoUrl: string | null | undefined, bodyContent: string): string {
  const absoluteLogoUrl = toAbsoluteUrl(logoUrl);
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f5f0eb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f0eb; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color: #0d9488; padding: 24px 32px; text-align: center;">
              ${absoluteLogoUrl ? `<img src="${absoluteLogoUrl}" alt="${companyName}" style="max-height: 48px; margin-bottom: 8px;" />` : ""}
              <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 600;">${companyName}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px;">
              ${bodyContent}
            </td>
          </tr>
          <tr>
            <td style="background-color: #f9fafb; padding: 16px 32px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                Diese E-Mail wurde automatisch von ${companyName} versendet.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildButtonHtml(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
    <tr>
      <td style="background-color: #0d9488; border-radius: 8px; padding: 14px 28px;">
        <a href="${url}" style="color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; display: inline-block;">${label}</a>
      </td>
    </tr>
  </table>`;
}

export function buildWelcomeEmailHtml(options: {
  vorname: string;
  nachname: string;
  email: string;
  companyName: string;
  resetUrl: string;
  logoUrl?: string | null;
}): string {
  const { vorname, nachname, companyName, email, resetUrl, logoUrl } = options;

  const body = `
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Hallo ${vorname} ${nachname},
    </p>
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Sie wurden als Mitarbeiter/in bei ${companyName} angelegt. Um Ihren Zugang zu aktivieren, setzen Sie bitte Ihr persönliches Passwort über den folgenden Link:
    </p>
    ${buildButtonHtml("Passwort setzen", resetUrl)}
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Dieser Link ist 48 Stunden gültig. Falls er abgelaufen ist, können Sie über „Passwort vergessen" auf der Login-Seite einen neuen Link anfordern.
    </p>
    <div style="background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0; color: #0f766e; font-size: 15px;">
        <strong>Ihre Anmeldedaten:</strong><br />
        E-Mail: ${email}
      </p>
    </div>
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Bei Fragen wenden Sie sich an Ihre Teamleitung.
    </p>
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 16px 0 0;">
      Mit freundlichen Grüßen<br />
      <strong>${companyName}</strong>
    </p>`;

  return buildEmailLayout(companyName, logoUrl, body);
}

export function buildPasswordResetEmailHtml(options: {
  vorname: string;
  nachname: string;
  companyName: string;
  resetUrl: string;
  logoUrl?: string | null;
}): string {
  const { vorname, nachname, companyName, resetUrl, logoUrl } = options;

  const body = `
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Hallo ${vorname} ${nachname},
    </p>
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Sie haben das Zurücksetzen Ihres Passworts angefordert. Klicken Sie auf den folgenden Link, um ein neues Passwort zu setzen:
    </p>
    ${buildButtonHtml("Neues Passwort setzen", resetUrl)}
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Dieser Link ist 1 Stunde gültig. Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren.
    </p>
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 16px 0 0;">
      Mit freundlichen Grüßen<br />
      <strong>${companyName}</strong>
    </p>`;

  return buildEmailLayout(companyName, logoUrl, body);
}
