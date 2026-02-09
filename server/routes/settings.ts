import { Router, Request, Response } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { systemSettings, updateSystemSettingsSchema } from "@shared/schema";
import { eq } from "drizzle-orm";
import { fromError } from "zod-validation-error";
import { db } from "../lib/db";

const router = Router();

router.use(requireAuth);

async function getOrCreateSettings() {
  const existing = await db.select().from(systemSettings).limit(1);
  if (existing.length > 0) {
    return existing[0];
  }
  const [created] = await db.insert(systemSettings).values({
    autoBreaksEnabled: true,
  }).returning();
  return created;
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (error) {
    handleRouteError(res, error, "Einstellungen konnten nicht geladen werden");
  }
});

router.patch("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const parsed = updateSystemSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: fromError(parsed.error).toString(),
      });
    }

    const current = await getOrCreateSettings();

    const [updated] = await db
      .update(systemSettings)
      .set({
        ...parsed.data,
        updatedAt: new Date(),
        updatedByUserId: req.user!.id,
      })
      .where(eq(systemSettings.id, current.id))
      .returning();

    res.json(updated);
  } catch (error) {
    handleRouteError(res, error, "Einstellungen konnten nicht gespeichert werden");
  }
});

export default router;
