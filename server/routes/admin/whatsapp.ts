import { Router } from "express";
import { asyncHandler, badRequest } from "../../lib/errors";
import { z } from "zod";
import { storage } from "../../storage";
import { getCachedCompanySettings, companySettingsCache } from "../../services/cache";
import { whatsAppService, resolveTwilioConfigFromSettings } from "../../services/whatsapp-service";
import {
  updateWhatsAppConfigSchema,
  updateWhatsAppRulesSchema,
} from "@shared/schema";
import {
  getWhatsAppNotificationRules,
  batchUpsertWhatsAppNotificationRules,
  getMessageLog,
} from "../../storage/whatsapp";

const router = Router();

function isFullyConfigured(settings: {
  whatsappEnabled: boolean;
  whatsappFromOrService: string | null;
  whatsappAccessToken: string | null;
}): boolean {
  return resolveTwilioConfigFromSettings(settings) !== null;
}

router.get("/config", asyncHandler("WhatsApp-Konfiguration konnte nicht geladen werden", async (_req, res) => {
  const settings = await getCachedCompanySettings();
  res.json({
    whatsappEnabled: settings?.whatsappEnabled ?? false,
    whatsappFromOrService: settings?.whatsappFromOrService ?? null,
    whatsappAccessToken: settings?.whatsappAccessToken
      ? "••••" + settings.whatsappAccessToken.slice(-4)
      : null,
    twilioEnvConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    configured: isFullyConfigured({
      whatsappEnabled: settings?.whatsappEnabled ?? false,
      whatsappFromOrService: settings?.whatsappFromOrService ?? null,
      whatsappAccessToken: settings?.whatsappAccessToken ?? null,
    }),
  });
}));

router.put("/config", asyncHandler("WhatsApp-Konfiguration konnte nicht gespeichert werden", async (req, res) => {
  const data = updateWhatsAppConfigSchema.parse(req.body);
  companySettingsCache.invalidate();
  const updated = await storage.updateCompanySettings(data as any, req.user!.id);
  companySettingsCache.invalidate();
  res.json({
    whatsappEnabled: updated.whatsappEnabled,
    whatsappFromOrService: updated.whatsappFromOrService ?? null,
    whatsappAccessToken: updated.whatsappAccessToken
      ? "••••" + updated.whatsappAccessToken.slice(-4)
      : null,
    twilioEnvConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    configured: isFullyConfigured({
      whatsappEnabled: updated.whatsappEnabled,
      whatsappFromOrService: updated.whatsappFromOrService ?? null,
      whatsappAccessToken: updated.whatsappAccessToken ?? null,
    }),
  });
}));

const testMessageSchema = z.object({
  phoneNumber: z.string().min(1, "Telefonnummer ist erforderlich"),
});

router.post("/test", asyncHandler("Testnachricht konnte nicht gesendet werden", async (req, res) => {
  const { phoneNumber } = testMessageSchema.parse(req.body);

  const configured = await whatsAppService.isConfigured();
  if (!configured) {
    throw badRequest("WhatsApp ist nicht konfiguriert. Bitte zuerst den Twilio-Sender eingeben und aktivieren.");
  }

  const result = await whatsAppService.sendTestMessage(phoneNumber, req.user!.id);
  if (!result.success) {
    res.status(400).json({ success: false, error: result.error });
    return;
  }
  res.json({ success: true });
}));

router.get("/rules", asyncHandler("Benachrichtigungsregeln konnten nicht geladen werden", async (_req, res) => {
  const rules = await getWhatsAppNotificationRules();
  res.json(rules);
}));

router.put("/rules", asyncHandler("Benachrichtigungsregeln konnten nicht gespeichert werden", async (req, res) => {
  const { rules } = updateWhatsAppRulesSchema.parse(req.body);

  const existingRules = await getWhatsAppNotificationRules();
  const existingMap = new Map(existingRules.map(r => [r.id, r]));

  const rulesToUpsert = rules
    .filter(rule => existingMap.has(rule.id))
    .map(rule => {
      const existing = existingMap.get(rule.id)!;
      return {
        eventType: existing.eventType,
        enabled: rule.enabled,
        templateName: rule.templateName,
        description: existing.description,
      };
    });

  const updated = await batchUpsertWhatsAppNotificationRules(rulesToUpsert);
  res.json(updated);
}));

router.get("/log", asyncHandler("Nachrichtenprotokoll konnte nicht geladen werden", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const status = req.query.status as string | undefined;
  const statusFilter = status && ["sent", "failed"].includes(status) ? status : undefined;

  const result = await getMessageLog(limit, offset, statusFilter);
  res.json(result);
}));

export default router;
