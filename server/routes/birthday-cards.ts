import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler, forbidden, badRequest } from "../lib/errors";
import { db } from "../lib/db";
import { birthdayCardTracking } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { completeAllBirthdayTasks, reopenAllBirthdayTasks } from "../storage/tasks";

const router = Router();
router.use(requireAuth);

router.get("/", asyncHandler("Geburtstagskarten konnten nicht geladen werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const year = parseInt(req.query.year as string) || new Date().getFullYear();

  const records = await db.select().from(birthdayCardTracking)
    .where(eq(birthdayCardTracking.year, year));

  res.json(records);
}));

const toggleSchema = z.object({
  personType: z.enum(["customer", "employee"]),
  personId: z.number(),
  year: z.number(),
  sent: z.boolean(),
  notes: z.string().optional(),
});

router.post("/toggle", asyncHandler("Kartenstatus konnte nicht aktualisiert werden", async (req, res) => {
  if (!req.user!.isAdmin) throw forbidden("FORBIDDEN", "Nur für Administratoren");

  const parsed = toggleSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("Ungültige Daten");

  const { personType, personId, year, sent, notes } = parsed.data;

  const record = await db.transaction(async (tx) => {
    const existing = await tx.select().from(birthdayCardTracking)
      .where(and(
        eq(birthdayCardTracking.personType, personType),
        eq(birthdayCardTracking.personId, personId),
        eq(birthdayCardTracking.year, year),
      ));

    let result;
    if (existing.length > 0) {
      const [updated] = await tx.update(birthdayCardTracking)
        .set({
          sent,
          sentAt: sent ? new Date() : null,
          sentByUserId: sent ? req.user!.id : null,
          notes: notes ?? existing[0].notes,
        })
        .where(eq(birthdayCardTracking.id, existing[0].id))
        .returning();
      result = updated;
    } else {
      const [created] = await tx.insert(birthdayCardTracking)
        .values({
          personType,
          personId,
          year,
          sent,
          sentAt: sent ? new Date() : null,
          sentByUserId: sent ? req.user!.id : null,
          notes,
        })
        .returning();
      result = created;
    }

    if (sent) {
      await completeAllBirthdayTasks(personType, personId, year, tx);
    } else {
      await reopenAllBirthdayTasks(personType, personId, year, tx);
    }

    return result;
  });

  res.json(record);
}));

export default router;
