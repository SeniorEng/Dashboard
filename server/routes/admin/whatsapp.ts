import { Router } from "express";
import { asyncHandler, badRequest } from "../../lib/errors";
import { z } from "zod";
import { storage } from "../../storage";
import { whatsAppService } from "../../services/whatsapp-service";
import {
  updateWhatsAppConfigSchema,
  updateWhatsAppRulesSchema,
} from "@shared/schema";
import {
  getWhatsAppNotificationRules,
  upsertWhatsAppNotificationRule,
  getMessageLog,
} from "../../storage/whatsapp";

const router = Router();

router.get("/config", asyncHandler("WhatsApp-Konfiguration konnte nicht geladen werden", async (_req, res) => {
  const settings = await storage.getCompanySettings();
  res.json({
    whatsappEnabled: settings?.whatsappEnabled ?? false,
    whatsappPhoneNumberId: settings?.whatsappPhoneNumberId ?? null,
    whatsappBusinessAccountId: settings?.whatsappBusinessAccountId ?? null,
    whatsappAccessToken: settings?.whatsappAccessToken
      ? "••••" + settings.whatsappAccessToken.slice(-4)
      : null,
    configured: !!(settings?.whatsappAccessToken && settings?.whatsappPhoneNumberId && settings?.whatsappEnabled),
  });
}));

router.put("/config", asyncHandler("WhatsApp-Konfiguration konnte nicht gespeichert werden", async (req, res) => {
  const data = updateWhatsAppConfigSchema.parse(req.body);
  const updated = await storage.updateCompanySettings(data as any, req.user!.id);
  res.json({
    whatsappEnabled: updated.whatsappEnabled,
    whatsappPhoneNumberId: updated.whatsappPhoneNumberId ?? null,
    whatsappBusinessAccountId: updated.whatsappBusinessAccountId ?? null,
    whatsappAccessToken: updated.whatsappAccessToken
      ? "••••" + updated.whatsappAccessToken.slice(-4)
      : null,
    configured: !!(updated.whatsappAccessToken && updated.whatsappPhoneNumberId && updated.whatsappEnabled),
  });
}));

const testMessageSchema = z.object({
  phoneNumber: z.string().min(1, "Telefonnummer ist erforderlich"),
});

router.post("/test", asyncHandler("Testnachricht konnte nicht gesendet werden", async (req, res) => {
  const { phoneNumber } = testMessageSchema.parse(req.body);

  const configured = await whatsAppService.isConfigured();
  if (!configured) {
    throw badRequest("WhatsApp ist nicht konfiguriert. Bitte zuerst die API-Zugangsdaten eingeben und aktivieren.");
  }

  const result = await whatsAppService.sendTestMessage(phoneNumber, req.user!.id);
  if (!result.success) {
    res.status(400).json({ success: false, error: result.error });
    return;
  }
  res.json({ success: true });
}));

router.get("/templates", asyncHandler("Templates konnten nicht geladen werden", async (_req, res) => {
  const configured = await whatsAppService.isConfigured();
  if (!configured) {
    throw badRequest("WhatsApp ist nicht konfiguriert");
  }

  const templates = await whatsAppService.getTemplates();
  res.json(templates);
}));

router.get("/rules", asyncHandler("Benachrichtigungsregeln konnten nicht geladen werden", async (_req, res) => {
  const rules = await getWhatsAppNotificationRules();
  res.json(rules);
}));

router.put("/rules", asyncHandler("Benachrichtigungsregeln konnten nicht gespeichert werden", async (req, res) => {
  const { rules } = updateWhatsAppRulesSchema.parse(req.body);

  const existingRules = await getWhatsAppNotificationRules();
  const existingMap = new Map(existingRules.map(r => [r.id, r]));

  const updated = [];
  for (const rule of rules) {
    const existing = existingMap.get(rule.id);
    if (!existing) continue;

    const result = await upsertWhatsAppNotificationRule({
      eventType: existing.eventType,
      enabled: rule.enabled,
      templateName: rule.templateName,
      description: existing.description,
    });
    updated.push(result);
  }

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
