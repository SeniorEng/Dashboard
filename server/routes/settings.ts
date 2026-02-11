import { Router, Request, Response } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler, badRequest } from "../lib/errors";
import { updateSystemSettingsSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { storage } from "../storage";

const router = Router();
router.use(requireAuth);

router.get("/", asyncHandler("Einstellungen konnten nicht geladen werden", async (_req, res) => {
  const settings = await storage.getSystemSettings();
  res.json(settings);
}));

router.patch("/", requireAdmin, asyncHandler("Einstellungen konnten nicht gespeichert werden", async (req, res) => {
  const parsed = updateSystemSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  const current = await storage.getSystemSettings();
  const updated = await storage.updateSystemSettings(current.id, parsed.data, req.user!.id);
  res.json(updated);
}));

export default router;
