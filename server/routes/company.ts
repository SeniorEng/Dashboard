import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler, badRequest } from "../lib/errors";
import { updateCompanySettingsSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { storage } from "../storage";
import { geocodeCompanySettings } from "../services/geocoding";

const router = Router();
router.use(requireAuth);

const SENSITIVE_FIELDS = ["twilioAuthToken", "twilioAccountSid", "epostSecret", "qontoSecretKey", "smtpPass", "epostPassword", "whatsappAccessToken"] as const;

router.get("/", asyncHandler("Firmendaten konnten nicht geladen werden", async (req, res) => {
  const settings = await storage.getCompanySettings();
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
  const updated = await storage.updateCompanySettings(parsed.data, req.user!.id);

  const addressFields = ["strasse", "hausnummer", "plz", "stadt"];
  if (addressFields.some(f => f in parsed.data)) {
    geocodeCompanySettings().catch(err => console.error("[geocoding] Background geocoding failed:", err));
  }

  res.json(updated);
}));

export default router;
