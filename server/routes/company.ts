import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler, badRequest } from "../lib/errors";
import { updateCompanySettingsSchema } from "@shared/schema";
import { fromError } from "zod-validation-error";
import { storage } from "../storage";

const router = Router();
router.use(requireAuth);

router.get("/", asyncHandler("Firmendaten konnten nicht geladen werden", async (_req, res) => {
  const settings = await storage.getCompanySettings();
  res.json(settings);
}));

router.patch("/", requireAdmin, asyncHandler("Firmendaten konnten nicht gespeichert werden", async (req, res) => {
  const parsed = updateCompanySettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }
  const updated = await storage.updateCompanySettings(parsed.data, req.user!.id);
  res.json(updated);
}));

export default router;
