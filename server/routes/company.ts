import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler, badRequest } from "../lib/errors";
import { updateCompanySettingsSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { storage } from "../storage";
import { geocodeCompanySettings } from "../services/geocoding";
import { buildLeadAutoReplyHtml } from "../services/lead-auto-reply";
import { getCachedCompanySettings, companySettingsCache } from "../services/cache";

const router = Router();
router.use(requireAuth);

const SENSITIVE_FIELDS = ["twilioAuthToken", "twilioAccountSid", "letterxpressApiKey", "qontoSecretKey", "smtpPass", "whatsappAccessToken"] as const;

router.get("/", asyncHandler("Firmendaten konnten nicht geladen werden", async (req, res) => {
  const settings = await getCachedCompanySettings();
  if (!settings) { res.json(settings); return; }

  const user = req.user!;
  if (!user.isAdmin && !user.isSuperAdmin) {
    const masked = { ...settings };
    for (const field of SENSITIVE_FIELDS) {
      if (field in masked) {
        (masked as Record<string, unknown>)[field] = "";
      }
    }
    res.json(masked);
    return;
  }
  res.json(settings);
}));

router.patch("/", requireAdmin, asyncHandler("Firmendaten konnten nicht gespeichert werden", async (req, res) => {
  const parsed = updateCompanySettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  companySettingsCache.invalidate();
  const updated = await storage.updateCompanySettings(parsed.data, req.user!.id);
  companySettingsCache.invalidate();

  const addressFields = ["strasse", "hausnummer", "plz", "stadt"];
  if (addressFields.some(f => f in parsed.data)) {
    geocodeCompanySettings().catch(err => console.error("[geocoding] Background geocoding failed:", err));
  }

  res.json(updated);
}));

router.get("/lead-auto-reply-preview", requireAdmin, asyncHandler("Vorschau konnte nicht erstellt werden", async (req, res) => {
  const settings = await getCachedCompanySettings();
  if (!settings) {
    throw badRequest("Keine Firmendaten vorhanden");
  }

  const subject = (req.query.subject as string) || settings.leadAutoReplySubject || "Betreff";
  const body = (req.query.body as string) || settings.leadAutoReplyBody || "";

  const html = buildLeadAutoReplyHtml({
    vorname: "Maria",
    nachname: "Mustermann",
    companyName: settings.companyName || "SeniorenEngel",
    logoUrl: settings.logoUrl,
    bodyText: body,
    telefon: settings.telefon,
    email: settings.email,
    website: settings.website,
  });

  res.json({
    subject,
    html,
    attachmentName: settings.leadAutoReplyAttachmentName || null,
  });
}));

export default router;
