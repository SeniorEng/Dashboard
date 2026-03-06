import { db } from "../lib/db";
import { companySettings, whatsappMessageLog, type InsertWhatsAppMessageLog, type CompanySettings } from "@shared/schema";

const META_API_BASE = "https://graph.facebook.com/v21.0";

interface TemplateComponent {
  type: "body" | "button";
  sub_type?: "url";
  index?: number;
  parameters: Array<{ type: "text"; text: string }>;
}

interface SendTemplateOptions {
  phoneNumber: string;
  templateName: string;
  templateParams?: string[];
  language?: string;
  buttonUrl?: string;
}

interface MetaTemplate {
  name: string;
  status: string;
  language: string;
  category: string;
  id: string;
}

interface MetaSendResponse {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

export class WhatsAppService {
  async sendTemplateMessage(options: SendTemplateOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const { phoneNumber, templateName, templateParams = [], language = "de", buttonUrl } = options;

    const config = await this.getConfig();
    if (!config) {
      return { success: false, error: "WhatsApp ist nicht konfiguriert" };
    }

    const components: TemplateComponent[] = [];

    if (templateParams.length > 0) {
      components.push({
        type: "body",
        parameters: templateParams.map((text) => ({ type: "text" as const, text })),
      });
    }

    if (buttonUrl) {
      components.push({
        type: "button",
        sub_type: "url",
        index: 0,
        parameters: [{ type: "text" as const, text: buttonUrl }],
      });
    }

    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to: phoneNumber,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        ...(components.length > 0 ? { components } : {}),
      },
    };

    try {
      const response = await fetch(`${META_API_BASE}/${config.whatsappPhoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.whatsappAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = (errorData as any)?.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        console.error("[WhatsApp] API-Fehler:", errorMsg);
        return { success: false, error: errorMsg };
      }

      const data = (await response.json()) as MetaSendResponse;
      const messageId = data.messages?.[0]?.id;
      return { success: true, messageId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unbekannter Fehler beim Senden";
      console.error("[WhatsApp] Sende-Fehler:", errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  async sendAndLog(
    userId: number,
    eventType: string,
    options: SendTemplateOptions
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

  async getTemplates(): Promise<MetaTemplate[]> {
    const config = await this.getConfig();
    if (!config) {
      throw new Error("WhatsApp ist nicht konfiguriert");
    }

    try {
      const response = await fetch(
        `${META_API_BASE}/${config.whatsappBusinessAccountId}/message_templates`,
        {
          headers: {
            Authorization: `Bearer ${config.whatsappAccessToken}`,
          },
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = (errorData as any)?.error?.message || `HTTP ${response.status}`;
        throw new Error(`Meta API Fehler: ${errorMsg}`);
      }

      const data = (await response.json()) as { data: MetaTemplate[] };
      return data.data || [];
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Meta API Fehler:")) {
        throw err;
      }
      throw new Error(`Fehler beim Abrufen der Templates: ${err instanceof Error ? err.message : "Unbekannt"}`);
    }
  }

  async sendTestMessage(phoneNumber: string, actingUserId: number): Promise<{ success: boolean; error?: string }> {
    const config = await this.getConfig();
    if (!config) {
      return { success: false, error: "WhatsApp ist nicht konfiguriert" };
    }

    const result = await this.sendTemplateMessage({
      phoneNumber,
      templateName: "hello_world",
      language: "en_US",
    });

    try {
      await db.insert(whatsappMessageLog).values({
        userId: actingUserId,
        eventType: "test",
        templateName: "hello_world",
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
      : process.env.APP_URL || "https://app.example.com";
    return `${baseUrl}${path}`;
  }

  private async getConfig(): Promise<CompanySettings | null> {
    const rows = await db.select().from(companySettings).limit(1);
    if (rows.length === 0) return null;

    const settings = rows[0];
    if (
      !settings.whatsappEnabled ||
      !settings.whatsappAccessToken ||
      !settings.whatsappPhoneNumberId
    ) {
      return null;
    }

    return settings;
  }
}

export const whatsAppService = new WhatsAppService();
