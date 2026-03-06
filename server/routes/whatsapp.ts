import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/errors";
import { updateUserWhatsAppPreferencesSchema } from "@shared/schema";
import {
  getUserWhatsAppPreferences,
  upsertUserWhatsAppPreferences,
} from "../storage/whatsapp";

const router = Router();

router.use(requireAuth);

router.get("/preferences", asyncHandler("WhatsApp-Einstellungen konnten nicht geladen werden", async (req, res) => {
  const prefs = await getUserWhatsAppPreferences(req.user!.id);
  res.json(prefs ?? { enabled: false, whatsappNumber: null });
}));

router.put("/preferences", asyncHandler("WhatsApp-Einstellungen konnten nicht gespeichert werden", async (req, res) => {
  const data = updateUserWhatsAppPreferencesSchema.parse(req.body);
  const result = await upsertUserWhatsAppPreferences(req.user!.id, {
    enabled: data.enabled,
    whatsappNumber: data.whatsappNumber ?? null,
  });
  res.json(result);
}));

export default router;
