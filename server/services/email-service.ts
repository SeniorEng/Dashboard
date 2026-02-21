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

function createTransporter(settings: CompanySettings) {
  if (!settings.smtpHost || !settings.smtpPort || !settings.smtpUser || !settings.smtpPass) {
    throw new Error("SMTP-Konfiguration unvollständig. Bitte in den Einstellungen konfigurieren.");
  }

  const port = parseInt(settings.smtpPort, 10);
  const useSecure = port === 465;

  return nodemailer.createTransport({
    host: settings.smtpHost,
    port,
    secure: useSecure,
    auth: {
      user: settings.smtpUser,
      pass: settings.smtpPass,
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === "production",
    },
  });
}

export async function sendEmail(settings: CompanySettings, options: EmailOptions): Promise<{ messageId: string }> {
  const transporter = createTransporter(settings);

  const fromName = settings.smtpFromName || settings.companyName || "SeniorenEngel";
  const fromEmail = settings.smtpFromEmail || settings.smtpUser;

  const result = await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
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
    const transporter = createTransporter(settings);
    await transporter.verify();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || "Verbindung fehlgeschlagen" };
  }
}

export function buildContractEmailHtml(options: {
  customerName: string;
  companyName: string;
  documentNames: string[];
  logoUrl?: string | null;
}): string {
  const { customerName, companyName, documentNames, logoUrl } = options;

  const docList = documentNames.map((name) => `<li style="padding: 4px 0;">${name}</li>`).join("");

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
              ${logoUrl ? `<img src="${logoUrl}" alt="${companyName}" style="max-height: 48px; margin-bottom: 8px;" />` : ""}
              <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 600;">${companyName}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px;">
              <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
                Sehr geehrte/r ${customerName},
              </p>
              <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
                anbei erhalten Sie Ihre unterschriebenen Vertragsunterlagen:
              </p>
              <div style="background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 16px; margin: 16px 0;">
                <ul style="margin: 0; padding-left: 20px; color: #0f766e; font-size: 15px; line-height: 1.8;">
                  ${docList}
                </ul>
              </div>
              <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 16px 0 0;">
                Bitte bewahren Sie diese Unterlagen sorgfältig auf. Bei Fragen stehen wir Ihnen jederzeit gerne zur Verfügung.
              </p>
              <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 16px 0 0;">
                Mit freundlichen Grüßen<br />
                <strong>${companyName}</strong>
              </p>
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
