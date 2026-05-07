import twilio from "twilio";
import { db } from "../lib/db";
import { whatsappMessageLog, type InsertWhatsAppMessageLog, type CompanySettings } from "@shared/schema";
import { storage } from "../storage";

interface SendTemplateOptions {
  phoneNumber: string;
  templateName: string;
  templateParams?: string[];
  language?: string;
  buttonUrl?: string;
}

interface ResolvedTwilioConfig {
  accountSid: string;
  authToken: string;
  from?: string;
  messagingServiceSid?: string;
}

interface TwilioRequestPayload {
  to: string;
  contentSid: string;
  contentVariables?: string;
  from?: string;
  messagingServiceSid?: string;
}

function withWhatsAppPrefix(phone: string): string {
  const trimmed = phone.trim();
  return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
}

export function buildTwilioRequest(
  options: SendTemplateOptions,
  config: ResolvedTwilioConfig,
): TwilioRequestPayload {
  const variables: Record<string, string> = {};
  (options.templateParams ?? []).forEach((value, index) => {
    variables[String(index + 1)] = value;
  });
  if (options.buttonUrl) {
    const nextIndex = (options.templateParams?.length ?? 0) + 1;
    variables[String(nextIndex)] = options.buttonUrl;
  }

  const payload: TwilioRequestPayload = {
    to: withWhatsAppPrefix(options.phoneNumber),
    contentSid: options.templateName,
  };

  if (Object.keys(variables).length > 0) {
    payload.contentVariables = JSON.stringify(variables);
  }

  if (config.messagingServiceSid) {
    payload.messagingServiceSid = config.messagingServiceSid;
  } else if (config.from) {
    payload.from = withWhatsAppPrefix(config.from);
  }

  return payload;
}

class WhatsAppService {
  async sendTemplateMessage(
    options: SendTemplateOptions,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const config = await this.getConfig();
    if (!config) {
      return { success: false, error: "WhatsApp ist nicht konfiguriert" };
    }

    const payload = buildTwilioRequest(options, config);

    try {
      const client = twilio(config.accountSid, config.authToken);
      const message = await client.messages.create(payload as any);
      return { success: true, messageId: message.sid };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unbekannter Fehler beim Senden";
      console.error("[WhatsApp] Twilio-Sende-Fehler:", errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  async sendAndLog(
    userId: number,
    eventType: string,
    options: SendTemplateOptions,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const result = await this.sendTemplateMessage(options);

    const logEntry: InsertWhatsAppMessageLog = {
      userId,
      eventType,
      templateName: options.templateName,
      phoneNumber: options.phoneNumber,
      status: result.success ? "sent" : "failed",
      errorMessage: result.error || null,
      metaMessageId: result.messageId || null,
    };

    try {
      await db.insert(whatsappMessageLog).values(logEntry);
    } catch (logErr) {
      console.error("[WhatsApp] Fehler beim Loggen:", logErr);
    }

    return result;
  }

  async sendTestMessage(
    phoneNumber: string,
    actingUserId: number,
  ): Promise<{ success: boolean; error?: string }> {
    const config = await this.getConfig();
    if (!config) {
      return { success: false, error: "WhatsApp ist nicht konfiguriert" };
    }

    const { getEnabledRuleByEvent, getWhatsAppNotificationRules } = await import("../storage/whatsapp");
    const allRules = await getWhatsAppNotificationRules();
    const candidate =
      (await getEnabledRuleByEvent("appointment_reminder")) ??
      allRules.find((r) => r.templateName && r.templateName.startsWith("HX"));

    if (!candidate || !candidate.templateName) {
      return {
        success: false,
        error:
          "Keine Twilio Content SID für Testnachricht vorhanden. Bitte zuerst eine Benachrichtigungsregel mit gültiger Content SID konfigurieren.",
      };
    }

    const result = await this.sendTemplateMessage({
      phoneNumber,
      templateName: candidate.templateName,
    });

    try {
      await db.insert(whatsappMessageLog).values({
        userId: actingUserId,
        eventType: "test",
        templateName: candidate.templateName,
        phoneNumber,
        status: result.success ? "sent" : "failed",
        errorMessage: result.error || null,
        metaMessageId: result.messageId || null,
      });
    } catch (logErr) {
      console.error("[WhatsApp] Fehler beim Loggen des Tests:", logErr);
    }

    return result;
  }

  async isConfigured(): Promise<boolean> {
    const config = await this.getConfig();
    return config !== null;
  }

  buildAppUrl(path: string): string {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.APP_URL || "";
    return `${baseUrl}${path}`;
  }

  private async getConfig(): Promise<ResolvedTwilioConfig | null> {
    const settings = await storage.getCompanySettings();
    return resolveTwilioConfigFromSettings(settings);
  }
}

export function resolveTwilioConfigFromSettings(
  settings: Pick<
    CompanySettings,
    "whatsappEnabled" | "whatsappFromOrService" | "whatsappAccessToken"
  >,
): ResolvedTwilioConfig | null {
  if (!settings.whatsappEnabled) return null;

  const fromOrService = settings.whatsappFromOrService?.trim();
  if (!fromOrService) return null;

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = settings.whatsappAccessToken?.trim() || process.env.TWILIO_AUTH_TOKEN?.trim();

  if (!accountSid || !authToken) return null;

  const isMessagingService = fromOrService.startsWith("MG");

  return {
    accountSid,
    authToken,
    ...(isMessagingService
      ? { messagingServiceSid: fromOrService }
      : { from: fromOrService }),
  };
}

export const whatsAppService = new WhatsAppService();
