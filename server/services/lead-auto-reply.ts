import { storage } from "../storage";
import { prospectStorage } from "../storage/prospects";
import { sendEmail, buildEmailLayout } from "./email-service";
import { ObjectStorageService } from "../replit_integrations/object_storage/objectStorage";

interface LeadAutoReplyParams {
  prospectId: number;
  leadEmail: string;
  leadVorname: string;
  leadNachname: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildLeadAutoReplyHtml(options: {
  vorname: string;
  nachname: string;
  companyName: string;
  logoUrl?: string | null;
  bodyText: string;
  telefon?: string | null;
  email?: string | null;
  website?: string | null;
}): string {
  const { vorname, nachname, companyName, logoUrl, bodyText, telefon, email, website } = options;

  const paragraphs = bodyText
    .split(/\n\n|\r\n\r\n/)
    .filter(p => p.trim())
    .map(p => `<p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">${escapeHtml(p.trim()).replace(/\n/g, "<br />")}</p>`)
    .join("\n");

  const greeting = vorname
    ? `Guten Tag ${escapeHtml(vorname)} ${escapeHtml(nachname)},`
    : `Guten Tag,`;

  const contactParts: string[] = [];
  if (telefon) contactParts.push(`Tel.: ${escapeHtml(telefon)}`);
  if (email) contactParts.push(`E-Mail: ${escapeHtml(email)}`);
  if (website) contactParts.push(`Web: ${escapeHtml(website)}`);

  const contactBlock = contactParts.length > 0
    ? `<div style="background-color: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0; color: #0f766e; font-size: 14px;">
          <strong>So erreichen Sie uns:</strong><br />
          ${contactParts.join("<br />")}
        </p>
      </div>`
    : "";

  const body = `
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      ${greeting}
    </p>
    ${paragraphs}
    ${contactBlock}
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 16px 0 0;">
      Mit freundlichen Grüßen<br />
      <strong>${escapeHtml(companyName)}</strong>
    </p>`;

  return buildEmailLayout(companyName, logoUrl, body);
}

async function downloadAttachment(objectPath: string): Promise<Buffer | null> {
  try {
    const objectStorageService = new ObjectStorageService();
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    const [contents] = await file.download();
    return contents;
  } catch (err) {
    console.error("[lead-auto-reply] Failed to download attachment:", err);
    return null;
  }
}

export async function sendLeadAutoReply(params: LeadAutoReplyParams): Promise<void> {
  const { prospectId, leadEmail, leadVorname, leadNachname } = params;

  const settings = await storage.getCompanySettings();
  if (!settings) {
    console.log("[lead-auto-reply] No company settings found, skipping");
    return;
  }

  if (!settings.leadAutoReplyEnabled) {
    console.log("[lead-auto-reply] Auto-reply disabled, skipping");
    return;
  }

  if (!settings.leadAutoReplySubject || !settings.leadAutoReplyBody) {
    console.log("[lead-auto-reply] Auto-reply subject or body not configured, skipping");
    return;
  }

  if (!settings.smtpHost || !settings.smtpUser) {
    console.log("[lead-auto-reply] SMTP not configured, skipping auto-reply");
    await prospectStorage.addNote({
      prospectId,
      noteText: "Automatische Antwort-E-Mail konnte nicht gesendet werden: SMTP nicht konfiguriert",
      noteType: "notiz",
    });
    return;
  }

  const html = buildLeadAutoReplyHtml({
    vorname: leadVorname,
    nachname: leadNachname,
    companyName: settings.companyName || "SeniorenEngel",
    logoUrl: settings.logoUrl,
    bodyText: settings.leadAutoReplyBody,
    telefon: settings.telefon,
    email: settings.email,
    website: settings.website,
  });

  const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> = [];

  if (settings.leadAutoReplyAttachmentPath) {
    const attachmentBuffer = await downloadAttachment(settings.leadAutoReplyAttachmentPath);
    if (attachmentBuffer) {
      attachments.push({
        filename: settings.leadAutoReplyAttachmentName || "Information.pdf",
        content: attachmentBuffer,
        contentType: "application/pdf",
      });
    } else {
      console.warn("[lead-auto-reply] Could not load attachment, sending email without it");
    }
  }

  try {
    const result = await sendEmail(settings, {
      to: leadEmail,
      subject: settings.leadAutoReplySubject,
      html,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    console.log(`[lead-auto-reply] Sent auto-reply to ${leadEmail} for prospect ${prospectId}, messageId=${result.messageId}`);

    const attachmentNote = attachments.length > 0
      ? ` (mit Anhang: ${settings.leadAutoReplyAttachmentName || "Information.pdf"})`
      : "";

    await prospectStorage.addNote({
      prospectId,
      noteText: `Automatische Antwort-E-Mail gesendet an ${leadEmail}${attachmentNote}`,
      noteType: "email",
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unbekannter Fehler";
    console.error(`[lead-auto-reply] Failed to send auto-reply to ${leadEmail}:`, err);

    await prospectStorage.addNote({
      prospectId,
      noteText: `Automatische Antwort-E-Mail an ${leadEmail} fehlgeschlagen: ${errorMsg}`,
      noteType: "notiz",
    });
  }
}
